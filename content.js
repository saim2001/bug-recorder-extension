// Runs in the ISOLATED world — can't see the page's real console/fetch,
// but CAN call chrome.* APIs. Its only job: relay messages from
// main-world.js to the background service worker.

const CHANNEL = "__bug_recorder__";

window.addEventListener("message", (event) => {
  // Only trust messages from this exact page, on our own channel
  if (event.source !== window) return;
  if (!event.data || event.data.channel !== CHANNEL) return;

  chrome.runtime.sendMessage({
    type: "LOG_EVENT",
    entry: event.data.entry,
    url: location.href,
  });
});
