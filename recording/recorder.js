import { remuxRecording, posterFrame } from "./mp4.mjs";
import { buildPresentation } from "./pptx.mjs";
import { acquireTabCapture } from "./tab-capture.mjs";

const {
  selectRecordingType,
  recordingOptions,
  recordingFileName,
  recordingCrop,
} = RecordingCore;
let sessionId = null;
const ui = Object.fromEntries(
  ["capture", "canvas"].map((id) => [id, document.getElementById(id)]),
);
let session;
let captureTab;
let sharedStream;
let cancelled = false;
let running = false;
let downloadUrl;
let presentationUrl;
let buildingPresentation = false;
let interrupt;
let recordingController;
let captureAuthorization = null;
let authorizedCaptureTabId = null;
let captureFailure = null;
let activeBounds = null;
const files = [];

function checkCancelled() {
  if (cancelled) throw new Error("Recording cancelled.");
}

function cancelRecording() {
  cancelled = true;
  recordingController?.abort();
  interrupt?.();
}

async function recordingHost(operation, values = {}) {
  const response = await chrome.runtime.sendMessage({
    action: "recordingHost",
    id: sessionId,
    operation,
    ...values,
  });
  if (!response?.success)
    throw new Error(
      response?.error || "The recording controller is unavailable.",
    );
  return response.data;
}

async function setStatus(status, values = {}) {
  await recordingHost("status", {
    status,
    completed: files.length,
    captureAuthorization,
    ...values,
  });
}

async function waitFor(
  test,
  timeout = 20000,
  message = "Creative did not become ready before the timeout.",
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    checkCancelled();
    const result = await test();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function nextCaptureFrame(previousFrames = 0, syncMarker = null) {
  let markerContext;
  if (syncMarker) {
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    markerContext = probe.getContext("2d", { willReadFrequently: true });
    if (!markerContext)
      throw new Error("Could not verify the selected recording start frame.");
  }
  await waitFor(
    () => {
      if (!verifyCapture({ allowPending: true })) return false;
      if (
        ui.capture.readyState < 2 ||
        !ui.capture.videoWidth ||
        !ui.capture.videoHeight
      )
        return false;
      if (!syncMarker)
        return (
          ui.capture.getVideoPlaybackQuality().totalVideoFrames > previousFrames
        );
      const markerCrop = recordingCrop(
        syncMarker,
        ui.capture.videoWidth,
        ui.capture.videoHeight,
      );
      markerContext.drawImage(
        ui.capture,
        markerCrop.left + markerCrop.width / 2 - 0.5,
        markerCrop.top + markerCrop.height / 2 - 0.5,
        1,
        1,
        0,
        0,
        1,
        1,
      );
      const pixel = markerContext.getImageData(0, 0, 1, 1).data;
      return (
        pixel[3] === 255 &&
        syncMarker.color.every(
          (channel, index) => Math.abs(channel - pixel[index]) <= 20,
        )
      );
    },
    10000,
    syncMarker
      ? "The selected start frame has not reached the captured video. Keep the preview tab open and retry."
      : "The captured tab did not deliver a frame for the next ad. Keep the ad-preview tab open and do not minimize Chrome.",
  );
}

async function preparePreview(job) {
  return recordingHost("prepare", { index: session.jobs.indexOf(job) });
}

async function measurePreview(job) {
  return recordingHost("measure", { index: session.jobs.indexOf(job) });
}

async function resumeCreative() {
  return recordingHost("resume");
}

function verifyCapture({ allowPending = false } = {}) {
  if (captureFailure) throw captureFailure;
  if (!captureTab || authorizedCaptureTabId !== captureTab.id)
    throw new Error(
      "This preview tab has not been authorized. Retry using CO Plus in the preview toolbar.",
    );
  const track = sharedStream?.getVideoTracks()[0];
  if (track?.readyState !== "live")
    throw new Error(
      "Tab capture has stopped. Retry and keep the preview open until recording finishes.",
    );
  if (track.muted) {
    if (allowPending) return false;
    throw new Error(
      "The captured preview tab is temporarily unavailable. Keep the tab open and do not minimize Chrome, then retry.",
    );
  }
  return true;
}

async function waitForCapture() {
  await waitFor(
    () => verifyCapture({ allowPending: true }),
    10000,
    "The captured preview tab is not ready. Keep the tab open and do not minimize Chrome, then retry.",
  );
}

async function recordAd(job, bounds, type, options) {
  checkCancelled();
  verifyCapture();
  Object.assign(bounds, await recordingHost("watch"));
  activeBounds = bounds;
  const canvas = ui.canvas;
  const outputWidth = job.width * options.scale;
  const outputHeight = job.height * options.scale;
  canvas.width = Math.ceil(outputWidth / 2) * 2;
  canvas.height = Math.ceil(outputHeight / 2) * 2;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Could not create recording canvas.");
  let frameRequest;
  let drawError;
  const draw = () => {
    try {
      if (!verifyCapture({ allowPending: !!options.realTime })) return;
      if (
        ui.capture.readyState < 2 ||
        !ui.capture.videoWidth ||
        !ui.capture.videoHeight
      )
        return;
      const crop = recordingCrop(
        bounds,
        ui.capture.videoWidth,
        ui.capture.videoHeight,
      );
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        ui.capture,
        crop.left,
        crop.top,
        crop.width,
        crop.height,
        0,
        0,
        outputWidth,
        outputHeight,
      );
    } catch (error) {
      drawError = error;
      interrupt?.();
    }
  };
  draw();
  if (drawError) throw drawError;
  const stream = canvas.captureStream(options.fps);
  frameRequest = setInterval(draw, 1000 / options.fps);
  let recorder;
  let timer;
  let stopRecording;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: type,
      videoBitsPerSecond: Math.min(
        20000000,
        Math.max(2500000, canvas.width * canvas.height * 8),
      ),
    });
    const chunks = [];
    const stopped = new Promise((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = (event) =>
        reject(event.error || new Error("H.264 encoder failed."));
      recorder.onstop = resolve;
    });
    void stopped.catch(() => {});
    stopRecording = () => {
      if (recorder.state !== "inactive") recorder.stop();
    };
    interrupt = stopRecording;
    const recordingStartedAt = Date.now();
    recorder.start(1000);
    const playback = await resumeCreative();
    checkCancelled();
    if (playback?.bounds) Object.assign(bounds, playback.bounds);
    const startedAt = playback?.startedAt || Date.now();
    const loadedOffset = Math.max(0, (startedAt - recordingStartedAt) / 1000);
    const trim = options.realTime
      ? { start: loadedOffset + options.start, end: loadedOffset + options.end }
      : null;
    await setStatus(`Recording ${job.name} (${job.width}x${job.height})`, {
      clipProgress: options.realTime
        ? {
            startedAt: startedAt + options.start * 1000,
            duration: options.end - options.start,
          }
        : { startedAt, duration: options.duration },
    });
    timer = setTimeout(
      stopRecording,
      Math.max(
        0,
        (options.realTime ? options.end : options.duration) * 1000 -
          (Date.now() - startedAt),
      ),
    );
    await stopped;
    if (drawError) throw drawError;
    checkCancelled();
    await recordingHost("pause");
    const blob = new Blob(chunks, { type });
    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (
      blob.size < 32 ||
      String.fromCharCode(...header.slice(4, 8)) !== "ftyp" ||
      !/avc1/i.test(recorder.mimeType)
    ) {
      throw new Error("The encoder did not produce a valid H.264 MP4 file.");
    }
    clearInterval(frameRequest);
    await setStatus(`Finalizing ${job.name} (${job.width}x${job.height})`);
    return await remuxRecording(blob, recordingController.signal, trim);
  } finally {
    clearTimeout(timer);
    activeBounds = null;
    interrupt = null;
    if (recorder?.state !== "inactive") recorder?.stop();
    clearInterval(frameRequest);
    stream.getTracks().forEach((track) => track.stop());
  }
}

async function offerDownload() {
  if (!files.length) return;
  await setStatus("Preparing download...");
  let blob = files[0].blob;
  let name = files[0].name;
  if (files.length > 1) {
    const zip = new JSZip();
    const usedNames = new Set();
    for (const [index, file] of files.entries()) {
      let filename = file.name;
      if (usedNames.has(filename))
        filename = filename.replace(/\.mp4$/, `_${index + 1}.mp4`);
      usedNames.add(filename);
      zip.file(filename, file.blob);
    }
    blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    name = "ad-recordings.zip";
  }
  downloadUrl = URL.createObjectURL(blob);
  await recordingHost("download", { download: { url: downloadUrl, name } });
}

async function createPresentation() {
  if (running) throw new Error("Wait for the recording to finish.");
  if (buildingPresentation) throw new Error("The PowerPoint file is already being created.");
  if (!files.length) throw new Error("There are no recordings to place in PowerPoint.");
  buildingPresentation = true;
  try {
    const slides = [];
    for (const file of files)
      slides.push({
        name: file.name,
        video: file.blob,
        poster: await posterFrame(file.blob),
        width: file.width,
        height: file.height,
      });
    const blob = await buildPresentation(slides, JSZip);
    if (presentationUrl) URL.revokeObjectURL(presentationUrl);
    presentationUrl = URL.createObjectURL(blob);
    return { url: presentationUrl, name: "ad-recordings.pptx" };
  } finally {
    buildingPresentation = false;
  }
}

function releaseDownloads() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  if (presentationUrl) URL.revokeObjectURL(presentationUrl);
  downloadUrl = null;
  presentationUrl = null;
  files.length = 0;
}

async function runRecording(duration, scale = 1) {
  if (running) throw new Error("A recording is already running.");
  running = true;
  let type;
  let options;
  cancelled = false;
  captureFailure = null;
  authorizedCaptureTabId = null;
  captureAuthorization = crypto.randomUUID();
  recordingController = new AbortController();
  let failure = null;
  try {
    type = selectRecordingType(globalThis.MediaRecorder);
    options = { ...recordingOptions(duration), scale: scale === 2 ? 2 : 1 };
    sharedStream = await acquireTabCapture({
      sessionId,
      authorization: captureAuthorization,
      previewTabId: captureTab.id,
      signal: recordingController.signal,
      onWaiting: () => setStatus("Awaiting toolbar authorization"),
    });
    checkCancelled();
    authorizedCaptureTabId = captureTab.id;
    await waitForCapture();
    await setStatus("Starting...");
    sharedStream
      .getVideoTracks()[0]
      .addEventListener("ended", cancelRecording, { once: true });
    ui.capture.srcObject = sharedStream;
    await ui.capture.play();
    for (const [index, job] of session.jobs.entries()) {
      checkCancelled();
      await setStatus(`Preparing ${job.name} (${job.width}x${job.height})`);
      const previousFrames =
        index === 0 ? 0 : ui.capture.getVideoPlaybackQuality().totalVideoFrames;
      if (index !== 0) await preparePreview(job);
      const clip = await recordingHost("range");
      await waitForCapture();
      const bounds = await measurePreview(job);
      await nextCaptureFrame(previousFrames, clip.syncMarker);
      checkCancelled();
      await setStatus(`Recording ${job.name} (${job.width}x${job.height})`);
      files.push({
        name: recordingFileName(job.name, job.width, job.height),
        width: job.width,
        height: job.height,
        blob: await recordAd(job, bounds, type, { ...options, ...clip }),
      });
      await setStatus(`Recorded ${job.name} (${job.width}x${job.height})`);
    }
  } catch (error) {
    failure = cancelled ? null : error.message;
  } finally {
    captureAuthorization = null;
    authorizedCaptureTabId = null;
    sharedStream?.getTracks().forEach((track) => track.stop());
    ui.capture.srcObject = null;
    await recordingHost("closePreview").catch(() => {});
    captureTab = null;
    try {
      await offerDownload();
      await setStatus(
        cancelled
          ? "Cancelled"
          : files.length === session.jobs.length
            ? "Done"
            : "Stopped",
        { error: failure },
      );
    } catch (error) {
      await setStatus("Error", {
        error: `Could not prepare download: ${error.message}`,
      });
    }
    running = false;
  }
}

function configureRecording(value) {
  if (running)
    throw new Error(
      "Cancel the current recording before changing the selection.",
    );
  selectRecordingType(globalThis.MediaRecorder);
  if (
    !navigator.mediaDevices?.getUserMedia ||
    !value?.id ||
    !Array.isArray(value.jobs) ||
    !value.jobs.length ||
    !Number.isInteger(value.captureTabId)
  )
    throw new Error("Invalid recording configuration.");
  releaseDownloads();
  session = value;
  sessionId = value.id;
  captureTab = { id: value.captureTabId };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    message?.target !== "recording-engine" ||
    sender.id !== chrome.runtime.id ||
    sender.tab
  )
    return;
  if (
    message.action === "recordingTabCaptureResult" &&
    message.id === sessionId
  ) {
    respond({ success: true });
    return;
  }
  try {
    if (message.action === "configureRecording")
      configureRecording(message.session);
    else {
      if (message.id !== sessionId) return;
      if (message.action === "buildPresentation") {
        createPresentation().then(
          (download) => respond({ success: true, download }),
          (error) => respond({ success: false, error: error.message }),
        );
        return true;
      }
      if (message.action === "startRecording") {
        if (running) throw new Error("This batch is already recording.");
        void runRecording(message.duration, message.scale).catch((error) =>
          console.error("[recording]", error),
        );
      } else if (message.action === "cancelRecording") cancelRecording();
      else if (message.action === "recordingPreviewGeometry") {
        if (activeBounds) Object.assign(activeBounds, message.bounds);
      } else if (message.action === "releaseRecording") {
        if (running)
          throw new Error("Cancel the recording before clearing it.");
        releaseDownloads();
        session = null;
        sessionId = null;
      } else return;
    }
    respond({ success: true });
  } catch (error) {
    respond({ success: false, error: error.message });
  }
});
