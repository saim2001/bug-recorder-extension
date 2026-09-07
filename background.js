// The service worker is the coordinator. It can be killed and restarted
// by Chrome at any time, so we persist logs to chrome.storage.session
// rather than trusting an in-memory variable to survive.

let logs = [];
let recording = false;
let recordingStart = null;
let lastError = null;

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
