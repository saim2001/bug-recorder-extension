// The service worker is the coordinator. It can be killed and restarted
// by Chrome at any time, so we persist logs to chrome.storage.session
// rather than trusting an in-memory variable to survive.

let logs = [];
let recording = false;
let recordingStart = null;
let lastError = null;
let license = null; // { key, instanceId, valid } or null if unlicensed

const VALIDATION_CACHE_MS = 24 * 60 * 60 * 1000; // re-check once a day

const LEMON_SQUEEZY_PRODUCT_ID = "1381605"; 

// Every handler below awaits this before touching logs/recording, so a
// freshly-woken service worker never answers with stale defaults before
// storage has actually loaded.
const stateReady = (async () => {
  const data = await chrome.storage.session.get([
    "logs",
    "recording",
    "recordingStart",
    "lastError",
  ]);
  logs = data.logs || [];
  recording = data.recording || false;
  recordingStart = data.recordingStart || null;
  lastError = data.lastError || null;
  // not session — license must survive full browser restarts, unlike recording state
  const localData = await chrome.storage.local.get(["license"]);
  license = localData.license || null;

})();

async function saveLogs() {
  await chrome.storage.session.set({ logs });
}

async function saveRecording(value) {
  recording = value;
  await chrome.storage.session.set({ recording: value });
}

async function saveRecordingStart(value) {
  recordingStart = value;
  await chrome.storage.session.set({ recordingStart: value });
}

async function activateLicense(key) {
  const response = await fetch("https://api.lemonsqueezy.com/v1/licenses/activate", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      license_key: key,
      instance_name: "chrome-extension",
    }),
  });
  const data = await response.json();

  if (!data.activated) {
    return { ok: false, error: data.error || "Invalid license key." };
  }
  if (data.meta.product_id !== Number(LEMON_SQUEEZY_PRODUCT_ID)) {
    return { ok: false, error: "This key isn't for this product." };
  }

  license = {
    key,
    instanceId: data.instance.id,
    valid: true,
    lastValidated: Date.now(),
  };
  await chrome.storage.local.set({ license });
  return { ok: true };
}

async function validateLicense() {
  if (!license) return false;

  const cacheAge = Date.now() - (license.lastValidated || 0);
  if (cacheAge < VALIDATION_CACHE_MS) {
    // Recently confirmed — skip the network call entirely.
    return license.valid;
  }

  try {
    const response = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        license_key: license.key,
        instance_id: license.instanceId,
      }),
    });
    const data = await response.json();

    // Only an explicit "not active" response (revoked, refunded, expired)
    // should lock the user out. Anything else is treated as "couldn't
    // confirm right now" below, in the catch block.
    const stillValid = data.valid === true && data.license_key.status === "active";
    license.valid = stillValid;
    license.lastValidated = Date.now();
    await chrome.storage.local.set({ license });
    return stillValid;
  } catch (err) {
    // Network failure, Lemon Squeezy down, user offline, etc.
    // Don't punish the user for a connectivity issue — keep trusting
    // whatever we last confirmed, and try again next time.
    return license.valid;
  }
}

async function deactivateLicense() {
  if (!license) return { ok: false, error: "No license activated." };

  try {
    await fetch("https://api.lemonsqueezy.com/v1/licenses/deactivate", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        license_key: license.key,
        instance_id: license.instanceId,
      }),
    });
  } catch {
    // Even if the network call fails, still clear it locally below —
    // better to let them re-activate than leave them stuck either way.
  }

  license = null;
  await chrome.storage.local.remove("license");
  return { ok: true };
}

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Recording the active tab for a bug report.",
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await stateReady; // never touch logs/recording before this resolves

    if (message.type === "ACTIVATE_LICENSE") {
      const result = await activateLicense(message.key);
      sendResponse(result);
      return;
    }

    if (message.type === "DEACTIVATE_LICENSE") {
      const result = await deactivateLicense();
      sendResponse(result);
      return;
    }

    if (message.type === "CHECK_LICENSE") {
      const valid = await validateLicense();
      sendResponse({ valid });
      return;
    }

    if (message.type === "LOG_EVENT") {
      logs.push(message.entry);
      await saveLogs();
      return;
    }

    if (message.type === "RECORDING_ERROR") {
      await saveRecording(false);
      lastError = message.error;
      await chrome.storage.session.set({ lastError: message.error });
      return;
    }

    if (message.type === "START_RECORDING") {

      if (!license || !license.valid) {
        sendResponse({ ok: false, error: "Please activate your license first." });
        return;
      }

      // Guard: stops the double-start case (e.g. clicking Start again
      // after the service worker restarted and forgot it was recording).
      if (recording) {
        sendResponse({ ok: false, error: "Already recording." });
        return;
      }

      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });

        logs = [];
        await saveLogs();
        await ensureOffscreenDocument();

        const streamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId: tab.id,
        });

        chrome.runtime.sendMessage({
          type: "OFFSCREEN_START",
          streamId,
        });

        await saveRecording(true);
        sendResponse({ ok: true });
      } catch (err) {
        // Most common cause: a previous stream on this tab was never
        // properly stopped. Reset our state so the user can try again
        // instead of getting stuck in a broken "recording" state.
        await saveRecording(false);
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    if (message.type === "RECORDING_STARTED") {
      // Sent by offscreen.js the instant MediaRecorder actually starts —
      // this is the true t=0 for the video, used later to calculate how
      // far into the recording each log entry falls.
      await saveRecordingStart(message.epoch);
      return;
    }

    if (message.type === "STOP_RECORDING") {
      chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" });
      await saveRecording(false);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "GET_STATE") {
      const errorToReport = lastError;
      lastError = null;
      await chrome.storage.session.set({ lastError: null });
      sendResponse({ recording, logCount: logs.length, error: errorToReport});
      return;
    }

    if (message.type === "GET_LOGS") {
      sendResponse({ logs, recordingStart });
      return;
    }
  })();

  return true; // always keep the channel open — every path above is async now
});
