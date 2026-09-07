// Runs INSIDE the page's own JS world, so it can see the page's real
// console, fetch, and XMLHttpRequest — not a copy of them.
// It can't call chrome.* APIs directly (only content.js can), so it
// talks to content.js via plain window.postMessage.

(function () {
  const CHANNEL = "__bug_recorder__";

  function send(entry) {
    window.postMessage(
      { channel: CHANNEL, entry: { ...entry, epoch: Date.now() } },
      "*"
    );
  }

  function timestamp() {
    return new Date().toLocaleString();
  }

  function safeBody(body) {
    if (body == null) return null;

    if (typeof body === "string") {
      try {
        // It might be a JSON string — parse, redact, re-stringify.
        const parsed = JSON.parse(body);
        return JSON.stringify(redactObject(parsed)).slice(0, 2000);
      } catch {
        // Not JSON (e.g. form-urlencoded or plain text) — can't safely
        // redact structured fields, so just cap the size as before.
        return body.slice(0, 2000);
      }
    }

    try {
      return JSON.stringify(redactObject(body)).slice(0, 2000);
    } catch {
      return String(body).slice(0, 2000);
    }
  }

  function getQueryParams(url) {
    try {
      const u = new URL(url, location.origin);
      const params = Object.fromEntries(u.searchParams.entries());
      return redactObject(params);
    } catch {
      return null;
    }
  }

  const SENSITIVE_KEYS = [
  "password", "pass", "pwd",
  "token", "accesstoken", "refreshtoken", "idtoken",
  "authorization", "auth",
  "secret", "apikey", "api_key", "api-key", "x-api-key",
  "cookie", "session", "sessionid",
  "ssn", "creditcard", "cardnumber", "cvv",
  ];

  function isSensitiveKey(key) {
    const normalized = key.toLowerCase().replace(/[_-]/g, "");
    return SENSITIVE_KEYS.some((k) => normalized.includes(k));
  }

  function redactObject(obj) {
    if (Array.isArray(obj)) return obj.map(redactObject);
    if (obj !== null && typeof obj === "object") {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = isSensitiveKey(key) ? "[REDACTED]" : redactObject(value);
      }
      return result;
    }
    return obj;
  }

  // 1. Catch console.error / console.warn
  ["error", "warn"].forEach((level) => {
    const original = console[level];
    console[level] = function (...args) {
      send({
        type: `console.${level}`,
        message: args.map(String).join(" "),
        time: timestamp(),
      });
      original.apply(console, args);
    };
  });

  // 2. Catch uncaught exceptions
  window.addEventListener("error", (e) => {
    send({
      type: "uncaught-exception",
      message: e.message,
      source: `${e.filename}:${e.lineno}:${e.colno}`,
      time: timestamp(),
    });
  });

  // 3. Catch unhandled promise rejections
  window.addEventListener("unhandledrejection", (e) => {
    send({
      type: "unhandled-rejection",
      message: String(e.reason),
      time: timestamp(),
    });
  });

  // 4. Catch failed fetch() calls (network errors or non-2xx status)
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const started = timestamp();
    const [resource, options] = args;
    const url = typeof resource === "string" ? resource : resource?.url;
    const payload = safeBody(options?.body);
    const queryParams = getQueryParams(url);

    try {
      const response = await originalFetch.apply(this, args);
      if (!response.ok) {
        let responseBody = null;
        try {
          // .clone() is required — a Response body can only be read once,
          // and the caller still needs to read the original.
          const rawText = await response.clone().text();
          try {
            responseBody = JSON.stringify(redactObject(JSON.parse(rawText))).slice(0, 2000);
          } catch {
            responseBody = rawText.slice(0, 2000); // not JSON, leave as-is
          }
        } catch {
          // Some responses (opaque cross-origin, streams already used
          // elsewhere) can't be read here — fail silently, don't break the app.
        }
        send({
          type: "fetch-error",
          message: `${response.status} ${response.statusText} — ${url}`,
          url,
          queryParams,
          payload,
          responseBody,
          time: started,
        });
      }
      return response;
    } catch (err) {
      send({
        type: "fetch-network-error",
        message: `${err.message} — ${url} (network failure, or CORS blocked — check DevTools Network tab for the real status)`,
        url,
        queryParams,
        payload,
        time: started,
      });
      throw err;
    }
  };

  // 5. Catch failed XMLHttpRequest calls
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__bugRecorderMethod = method;
    this.__bugRecorderUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.__bugRecorderPayload = safeBody(body);

    this.addEventListener("loadend", () => {
      if (this.status === 0 || this.status >= 400) {
        let responseBody = null;
        try {
          // responseText throws if responseType is "blob"/"arraybuffer"
          try {
                responseBody = JSON.stringify(redactObject(JSON.parse(this.responseText))).slice(0, 2000);
              } 
          catch {
                responseBody = this.responseText?.slice(0, 2000);
              }
        } catch {}

        const isNetworkError = this.status === 0;

        send({
          type: isNetworkError ? "xhr-network-error" : "xhr-error",
          message: isNetworkError
            ? `${this.__bugRecorderMethod} ${this.__bugRecorderUrl} — no readable response (network failure, or CORS blocked — check DevTools Network tab for the real status)`
            : `${this.__bugRecorderMethod} ${this.__bugRecorderUrl} — status ${this.status}`,
          url: this.__bugRecorderUrl,
          queryParams: getQueryParams(this.__bugRecorderUrl),
          payload: this.__bugRecorderPayload,
          responseBody,
          time: timestamp(),
        });
      }
    });

    return originalSend.call(this, body);
  };
})();
