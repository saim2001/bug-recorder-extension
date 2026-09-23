const licenseView = document.getElementById("licenseView");
const appView = document.getElementById("appView");
const licenseInput = document.getElementById("licenseInput");
const activateBtn = document.getElementById("activateBtn");
const licenseStatus = document.getElementById("licenseStatus");
const deactivateLink = document.getElementById("deactivateLink");

const recordBtn = document.getElementById("recordBtn");
const stopBtn = document.getElementById("stopBtn");
const status = document.getElementById("status");

function renderRecordingState(state) {
  if (state.recording) {
    recordBtn.style.display = "none";
    stopBtn.style.display = "block";
    status.textContent = `Recording... ${state.logCount} issue(s) captured`;
  } else {
    recordBtn.style.display = "block";
    stopBtn.style.display = "none";
    status.textContent = "Idle";
  }
  if (state.error) {
    status.textContent = `Recording stopped: ${state.error}`;
  }
}

async function refreshRecordingState() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  renderRecordingState(state);
}

async function init() {
  const { valid } = await chrome.runtime.sendMessage({ type: "CHECK_LICENSE" });

  if (valid) {
    licenseView.style.display = "none";
    appView.style.display = "block";
    refreshRecordingState();
  } else {
    licenseView.style.display = "block";
    appView.style.display = "none";
  }
}

activateBtn.addEventListener("click", async () => {
  const key = licenseInput.value.trim();
  if (!key) {
    licenseStatus.textContent = "Enter a license key first.";
    return;
  }

  licenseStatus.textContent = "Activating...";
  const result = await chrome.runtime.sendMessage({
    type: "ACTIVATE_LICENSE",
    key,
  });

  if (result.ok) {
    licenseView.style.display = "none";
    appView.style.display = "block";
    refreshRecordingState();
  } else {
    licenseStatus.textContent = result.error || "Activation failed.";
  }
});

deactivateLink.addEventListener("click", async (e) => {
  e.preventDefault();
  const confirmed = confirm("Deactivate this device? You'll need to re-enter your license key to use the extension here again.");
  if (!confirmed) return;

  await chrome.runtime.sendMessage({ type: "DEACTIVATE_LICENSE" });
  appView.style.display = "none";
  licenseView.style.display = "block";
  licenseInput.value = "";
  licenseStatus.textContent = "Deactivated. Enter a license key to reactivate.";
});

recordBtn.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "START_RECORDING" });
  if (!result || !result.ok) {
    status.textContent = `Couldn't start: ${result?.error || "unknown error"}`;
    return;
  }
  refreshRecordingState();
});

stopBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
  status.textContent = "Exporting...";
  setTimeout(() => window.close(), 800);
});

init();