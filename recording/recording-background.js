importScripts("recording/recording-core.js", "recording/recording-host.js");

const RECORDING_PREFIX = "coPlusRecording:";
const recordingAuthorizationLocks = new Set();
const recordingStartLocks = new Set();
let openingRecordingSelection = false;

function recordingIsBusy(session) {
  return !["Ready", "Done", "Cancelled", "Stopped", "Error"].includes(
    session.status,
  );
}

async function initializeRecordingSelection(id) {
  let session = await updateRecordingSession(id, {
    status: "Preparing preview",
    completed: 0,
    error: null,
    download: null,
    cancelled: false,
    captureAuthorization: null,
    engineConfigured: false,
  });
  if (session.sourceClosed)
    throw new Error("The Choreograph source tab was closed. Select ads again.");
  await ensureRecordingDocument();
  await closeRecordingPreview(id);
  const tab = await chrome.tabs.create({
    windowId: session.windowId,
    url: "about:blank",
    active: true,
  });
  session = await updateRecordingSession(id, { captureTabId: tab.id });
  await prepareRecordingPreview(id, 0);
  await sendRecordingEngine("configureRecording", id, {
    session: {
      id,
      captureTabId: tab.id,
      jobs: session.jobs.map(({ name, width, height }) => ({
        name,
        width,
        height,
      })),
    },
  });
  await updateRecordingSession(id, {
    status: "Starting...",
    engineConfigured: true,
  });
}

async function clearRecordingSelection(id) {
  const session = await getRecordingSession(id);
  if (recordingIsBusy(session))
    throw new Error("Cancel the recording before clearing its selection.");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("recording/recorder.html")],
  });
  if (contexts.length && session.engineConfigured)
    await sendRecordingEngine("releaseRecording", id);
  await closeRecordingPreview(id);
  await chrome.storage.session.remove(`${RECORDING_PREFIX}${id}`);
  await chrome.tabs
    .sendMessage(session.sourceTabId, { action: "releaseRecording", id })
    .catch(() => {});
  if (contexts.length) await chrome.offscreen.closeDocument();
}

async function handleRecordingCommand(message) {
  const starting = message.command === "start";
  if (starting) {
    if (recordingStartLocks.has(message.id))
      throw new Error("This batch is already starting.");
    recordingStartLocks.add(message.id);
  }
  try {
    const session = await getRecordingSession(message.id);
    if (message.command === "clear") return clearRecordingSelection(session.id);
    if (message.command === "cancel") {
      await updateRecordingSession(session.id, { cancelled: true });
      if (session.engineConfigured)
        await sendRecordingEngine("cancelRecording", session.id).catch(
          () => {},
        );
      if (["Ready", "Preparing preview"].includes(session.status)) {
        await closeRecordingPreview(session.id);
        await updateRecordingSession(session.id, { status: "Cancelled" });
      }
      return;
    }
    if (message.command === "pptx") {
      if (!session.engineConfigured || !session.download)
        throw new Error("Record ads before creating a PowerPoint file.");
      if (recordingIsBusy(session))
        throw new Error("Wait for the recording to finish.");
      const { download } = await sendRecordingEngine(
        "buildPresentation",
        session.id,
      );
      if (
        typeof download?.url !== "string" ||
        !download.url.startsWith(`blob:${chrome.runtime.getURL("")}`) ||
        !/\.pptx$/.test(download.name || "")
      )
        throw new Error("Invalid PowerPoint download.");
      return { url: download.url, name: download.name };
    }
    if (message.command !== "start")
      throw new Error("Unknown recording command.");
    if (recordingIsBusy(session))
      throw new Error("This batch is already running.");
    if (session.sourceClosed)
      throw new Error(
        "The Choreograph source tab was closed. Clear the selection and select ads again.",
      );
    const duration = Number(message.duration ?? 15);
    if (!Number.isFinite(duration) || duration < 1 || duration > 120)
      throw new Error("Duration must be between 1 and 120 seconds.");
    const range = message.range
      ? RecordingCore.recordingRange(message.range.start, message.range.end)
      : RecordingCore.recordingRange(
          { type: "seconds", value: 0 },
          { type: "seconds", value: duration },
        );
    const scale = Number(message.scale ?? 2);
    if (![1, 2].includes(scale)) throw new Error("Scale must be 1x or 2x.");
    await updateRecordingSession(session.id, {
      status: "Starting...",
      error: null,
      range,
      scale,
    });
    try {
      if (session.status !== "Ready" || !session.captureTabId)
        await initializeRecordingSelection(session.id);
      await chrome.storage.sync.set({
        recordingDuration: duration,
        recordingStart: range.start,
        recordingEnd: range.end,
        recordingScale: scale,
      });
      const current = await getRecordingSession(session.id);
      await setRecordingToolbarPrompt(current.captureTabId, false);
      await sendRecordingEngine("startRecording", session.id, {
        duration,
        scale,
      });
    } catch (error) {
      await updateRecordingSession(session.id, {
        status: "Error",
        error: error.message,
      });
      throw error;
    }
  } finally {
    if (starting) recordingStartLocks.delete(message.id);
  }
}

async function handleRecordingHost(message) {
  const session = await getRecordingSession(message.id);
  if (message.operation === "prepare")
    return prepareRecordingPreview(session.id, message.index);
  if (message.operation === "measure")
    return measureRecordingPreview(session.id, message.index);
  if (message.operation === "watch") return watchRecordingPreview(session.id);
  if (message.operation === "range")
    return resolveRecordingPreviewRange(session.id);
  if (message.operation === "resume") return resumeRecordingPreview(session.id);
  if (message.operation === "pause") return pauseRecordingPreview(session.id);
  if (message.operation === "closePreview")
    return closeRecordingPreview(session.id);
  if (message.operation === "status") {
    if (
      typeof message.status !== "string" ||
      message.status.length > 1500 ||
      !Number.isInteger(message.completed) ||
      message.completed < 0 ||
      message.completed > session.jobs.length
    )
      throw new Error("Invalid recording progress.");
    const patch = { status: message.status, completed: message.completed };
    const clip = message.clipProgress;
    patch.clipProgress =
      Number.isFinite(clip?.startedAt) &&
      Number.isFinite(clip?.duration) &&
      clip.duration > 0 &&
      clip.duration <= 120
        ? { startedAt: clip.startedAt, duration: clip.duration }
        : null;
    if ("error" in message)
      patch.error =
        message.error === null ? null : String(message.error).slice(0, 5000);
    if ("captureAuthorization" in message)
      patch.captureAuthorization =
        typeof message.captureAuthorization === "string"
          ? message.captureAuthorization.slice(0, 100)
          : null;
    await updateRecordingSession(session.id, patch);
    if (
      message.status === "Awaiting toolbar authorization" ||
      session.status === "Awaiting toolbar authorization"
    ) {
      await setRecordingToolbarPrompt(
        session.captureTabId,
        message.status === "Awaiting toolbar authorization",
      );
    }
    if (message.status === "Awaiting toolbar authorization") {
      const tab = await chrome.tabs.get(session.captureTabId);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return;
  }
  if (message.operation === "download") {
    const download = message.download;
    if (
      !download ||
      typeof download.url !== "string" ||
      !download.url.startsWith(`blob:${chrome.runtime.getURL("")}`) ||
      typeof download.name !== "string" ||
      !/\.(mp4|zip)$/.test(download.name)
    )
      throw new Error("Invalid recording download.");
    await updateRecordingSession(session.id, {
      download: { url: download.url, name: download.name },
    });
    return;
  }
  throw new Error("Unknown recording operation.");
}

async function authorizeRecordingTab(tab) {
  const stored = await chrome.storage.session.get(null);
  const session = Object.entries(stored).find(
    ([key, value]) =>
      key.startsWith(RECORDING_PREFIX) &&
      value.captureTabId === tab.id &&
      value.status === "Awaiting toolbar authorization" &&
      !value.sourceClosed &&
      typeof value.captureAuthorization === "string",
  )?.[1];
  if (!session || recordingAuthorizationLocks.has(session.id)) return;
  recordingAuthorizationLocks.add(session.id);
  const result = {
    target: "recording-engine",
    action: "recordingTabCaptureResult",
    id: session.id,
    captureTabId: tab.id,
    authorization: session.captureAuthorization,
  };
  try {
    const preview = await chrome.tabs.get(tab.id);
    if (!session.jobs.some((job) => job.blobUrl === preview.url)) {
      throw new Error(
        "The recording preview changed. Start a new recording from Choreograph.",
      );
    }
    await setRecordingToolbarPrompt(tab.id, false);
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });
    await chrome.runtime.sendMessage({ ...result, streamId });
  } catch (error) {
    await chrome.runtime
      .sendMessage({
        ...result,
        error: `Tab capture could not start: ${error.message}. Check the extension's tab-capture permission; managed Chrome policies may also block recording.`,
      })
      .catch(() => {});
  } finally {
    recordingAuthorizationLocks.delete(session.id);
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  void authorizeRecordingTab(tab).catch((error) =>
    console.warn("[recording] toolbar authorization failed", error),
  );
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.action === "openRecordingPanel") {
    if (
      !sender.tab?.id ||
      !sender.url?.startsWith("https://create.choreograph.com/")
    ) {
      respond({
        success: false,
        error: "Open recording controls from a Choreograph preview.",
      });
      return;
    }
    try {
      const opened = chrome.sidePanel.open({ windowId: sender.tab.windowId });
      const navigation = chrome.storage.session.set({
        [`coPlusPanelNavigation:${sender.tab.windowId}`]: {
          tab: "t-recordings",
          requestId: crypto.randomUUID(),
        },
      });
      Promise.all([opened, navigation])
        .then(() => respond({ success: true }))
        .catch((error) => respond({ success: false, error: error.message }));
    } catch (error) {
      respond({ success: false, error: error.message });
    }
    return true;
  }
  if (
    message?.action === "recordingCommand" ||
    message?.action === "recordingHost"
  ) {
    const path =
      message.action === "recordingHost"
        ? "recording/recorder.html"
        : "panel/panel.html";
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      sender.url !== chrome.runtime.getURL(path)
    ) {
      respond({
        success: false,
        error: "Recording request is not authorized.",
      });
      return;
    }
    const task =
      message.action === "recordingHost"
        ? handleRecordingHost(message)
        : handleRecordingCommand(message);
    task
      .then((data) => respond({ success: true, data }))
      .catch((error) => respond({ success: false, error: error.message }));
    return true;
  }
  if (message?.action === "recordingPreviewGeometry") {
    void getRecordingSession(message.id)
      .then((session) => {
        const bounds = message.bounds;
        if (
          sender.id === chrome.runtime.id &&
          sender.tab?.id === session.captureTabId &&
          bounds &&
          [
            bounds.width,
            bounds.height,
            bounds.viewportWidth,
            bounds.viewportHeight,
          ].every((value) => Number.isFinite(value) && value > 0) &&
          [bounds.left ?? 0, bounds.top ?? 0].every(
            (value) => Number.isFinite(value) && value >= 0,
          ) &&
          (bounds.left || 0) + bounds.width <= bounds.viewportWidth &&
          (bounds.top || 0) + bounds.height <= bounds.viewportHeight
        ) {
          return sendRecordingEngine("recordingPreviewGeometry", session.id, {
            bounds,
          });
        }
      })
      .catch(() => {});
    return;
  }
  if (message?.action !== "openRecording") return;
  (async () => {
    if (
      !sender.tab?.id ||
      !sender.url?.startsWith("https://create.choreograph.com/")
    )
      throw new Error("Open a Choreograph preview to record ads.");
    const jobs = message.jobs;
    if (
      !Array.isArray(jobs) ||
      !jobs.length ||
      jobs.length > 500 ||
      jobs.some(
        (job) =>
          !job ||
          typeof job !== "object" ||
          !/^blob:https:\/\/create\.choreograph\.com\/[\w-]+$/.test(
            job.blobUrl,
          ) ||
          ![job.width, job.height].every(
            (value) => Number.isInteger(value) && value > 0 && value <= 4096,
          ) ||
          typeof job.name !== "string" ||
          job.name.length > 1000,
      )
    )
      throw new Error(
        "Invalid recording selection (maximum 500 ads, 4096 pixels per dimension).",
      );
    if (openingRecordingSelection)
      throw new Error("A recording selection is already opening.");
    openingRecordingSelection = true;
    try {
      const stored = await chrome.storage.session.get(null);
      if (Object.keys(stored).some((key) => key.startsWith(RECORDING_PREFIX)))
        throw new Error(
          "Clear the existing selection in the Recordings side panel before selecting another batch.",
        );
      const id = crypto.randomUUID();
      const key = `${RECORDING_PREFIX}${id}`;
      await chrome.storage.session.set({
        [key]: {
          id,
          sourceTabId: sender.tab.id,
          windowId: sender.tab.windowId,
          jobs,
          completed: 0,
          status: "Ready",
          captureTabId: null,
          engineConfigured: false,
          download: null,
          error: null,
        },
      });
      respond({ success: true, id });
    } finally {
      openingRecordingSelection = false;
    }
  })().catch((error) => respond({ success: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    const stored = await chrome.storage.session.get(null);
    for (const [key, session] of Object.entries(stored)) {
      if (!key.startsWith(RECORDING_PREFIX)) continue;
      if (session.sourceTabId === tabId || session.captureTabId === tabId) {
        await updateRecordingSession(session.id, {
          sourceClosed: session.sourceClosed || session.sourceTabId === tabId,
          cancelled: true,
        });
        if (session.engineConfigured)
          await sendRecordingEngine("cancelRecording", session.id).catch(
            () => {},
          );
        if (
          !recordingIsBusy(session) ||
          session.status === "Preparing preview"
        ) {
          await closeRecordingPreview(session.id);
          await updateRecordingSession(session.id, { status: "Cancelled" });
        }
      }
    }
  })().catch((error) => console.warn("[recording] cleanup failed", error));
});
