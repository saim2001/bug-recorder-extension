// This runs in a hidden document that DOES have access to media APIs
// (unlike the service worker). It records the tab and, when told to
// stop, downloads the result as a .webm file.

let mediaRecorder;
let chunks = [];

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "OFFSCREEN_START") {
    startRecording(message.streamId);
  }
  if (message.type === "OFFSCREEN_STOP") {
    stopRecording();
  }
});

async function startRecording(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30,
      },
    },
  });

  // Also play the audio back out so the user doesn't lose tab sound
  // while recording (capturing it mutes the original tab otherwise).
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(audioContext.destination);

  chunks = [];
  mediaRecorder = new MediaRecorder(stream, {
    mimeType: "video/webm;codecs=vp8,opus",
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    downloadRecording();
  };

  mediaRecorder.start();

  chrome.runtime.sendMessage({
    type: "RECORDING_STARTED",
    epoch: Date.now(),
  });
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

async function downloadRecording() {
  const videoBlob = new Blob(chunks, { type: "video/webm" });
  const { logs, recordingStart } = await chrome.runtime.sendMessage({
    type: "GET_LOGS",
  });

  const viewerHtml = await buildViewerHtml(logs, recordingStart);
  const readmeUrl = chrome.runtime.getURL("README-template.txt");
  const readme = await (await fetch(readmeUrl)).text();

  const zip = new JSZip();
  zip.file("recording.webm", videoBlob);
  zip.file("logs.json", JSON.stringify(logs, null, 2));
  zip.file("viewer.html", viewerHtml);
  zip.file("README.txt", readme);

  const zipBlob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
  });
  const zipUrl = URL.createObjectURL(zipBlob);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  triggerDownload(zipUrl, `bug-report-${timestamp}.zip`);
}

async function buildViewerHtml(logs, recordingStart) {
  const templateUrl = chrome.runtime.getURL("viewer-template.html");
  const template = await (await fetch(templateUrl)).text();

  return template
    .replace("__LOGS_JSON__", JSON.stringify(logs))
    .replace("__RECORDING_START_JSON__", JSON.stringify(recordingStart));
}

function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
