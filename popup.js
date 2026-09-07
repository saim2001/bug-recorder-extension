const recordBtn = document.getElementById("recordBtn");
const stopBtn = document.getElementById("stopBtn");
const status = document.getElementById("status");

function render(state) {
  if (state.recording) {
    recordBtn.style.display = "none";
    stopBtn.style.display = "block";
    status.textContent = `Recording... ${state.logCount} issue(s) captured`;
  } else {
    recordBtn.style.display = "block";
    stopBtn.style.display = "none";
    status.textContent = "Idle";
  }
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  render(state);
}

recordBtn.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "START_RECORDING" });
  if (!result || !result.ok) {
    status.textContent = `Couldn't start: ${result?.error || "unknown error"}`;
    return;
  }
  refresh();
});

stopBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
  status.textContent = "Exporting...";
  setTimeout(() => window.close(), 800);
});

refresh();
