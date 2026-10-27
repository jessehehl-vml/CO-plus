// panel.js
// Requires "tabs" permission in manifest.json if you don't already have it.

const DEFAULTS = {
  // screenshots
  delay: 500,
  scale: 2,
  imageType: "png",
  screenshotFrames: [],
  screenshotsEnabled: true,
  recordingsEnabled: true,
  recordingDuration: 15,

  // videos
  videosEnabled: true,
  videoQuality: "1080p",

  // assets
  assetsZipEnabled: true,
  assetsCsvEnabled: true,

  // other
  individualReloadEnabled: true,
  addTemplateEnabled: true,
  liveAdsetStatusEnabled: true,
};

let wasScreenshotRunning = false;
let wasVideoRunning = false;
let screenshotRunTabId = null;
let videoRunTabId = null;

const els = {
  tabsEl: document.querySelector(".tabs"),
  indicator: document.querySelector(".tabIndicator"),

  // screenshots: progress
  sBar: document.getElementById("progressBar"),
  sStatusText: document.getElementById("statusText"),
  sCount: document.getElementById("progressCount"),
  sCancel: document.getElementById("cancelBtn"),
  sEnabled: document.getElementById("screenshotsEnabled"),
  sError: document.getElementById("screenshotError"),

  // screenshots: options
  sDelay: document.getElementById("delay"),
  sScale: document.getElementById("scale"),
  sImageType: document.getElementById("imageType"),
  sSave: document.getElementById("save"),
  sSaveStatus: document.getElementById("status"),

  // screenshots: frames
  fStatus: document.getElementById("frameStatus"),
  fChoices: document.getElementById("frameChoices"),
  fRefresh: document.getElementById("frameRefresh"),

  // videos: progress
  vBar: document.getElementById("videoProgressBar"),
  vStatusText: document.getElementById("videoStatusText"),
  vCount: document.getElementById("videoProgressCount"),
  vCancel: document.getElementById("videoCancelBtn"),
  vEnabled: document.getElementById("videosEnabled"),
  vError: document.getElementById("videoError"),

  // videos: options
  vQuality: document.getElementById("videoQuality"),
  vSave: document.getElementById("videoSave"),
  vSaveStatus: document.getElementById("videoStatus"),

  // assets: options
  zipSw: document.getElementById("assetsZipEnabled"),
  csvSw: document.getElementById("assetsCsvEnabled"),

  // other: options:
  indvReload: document.getElementById("individualReloadEnabled"),
  addTemplateEnabled: document.getElementById("addTemplateEnabled"), // <— FIXED NAME
  liveAdsetStatus: document.getElementById("liveAdsetStatusEnabled"),
};

// --------------------
// Active tabId helpers (panel has no sender.tab)
// --------------------
async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return tab?.id ?? null;
}

// --------------------
// Tabs UI
// --------------------
function setActiveTab(tabId) {
  const tabs = [...document.querySelectorAll(".tab")];
  const panels = [...document.querySelectorAll(".tabPanel")];
  const activeTab = tabs.find((t) => t.id === tabId);
  if (!activeTab) return;

  tabs.forEach((t) => {
    const on = t === activeTab;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;
  });

  panels.forEach((p) => {
    const on = p.id === activeTab.getAttribute("aria-controls");
    p.hidden = !on;
    p.classList.toggle("is-active", on);
  });

  if (els.indicator) {
    const parentBox = activeTab.parentElement.getBoundingClientRect();
    const tabBox = activeTab.getBoundingClientRect();
    els.indicator.style.width = `${tabBox.width}px`;
    els.indicator.style.transform = `translateX(${tabBox.left - parentBox.left + activeTab.parentElement.scrollLeft}px)`;
  }
}

function wirePanelNavigation() {
  let key = null;
  let receivedChange = false;
  const activate = (request) => {
    if (request?.tab === "t-recordings") setActiveTab("t-recordings");
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session" || !key || !changes[key]) return;
    receivedChange = true;
    activate(changes[key].newValue);
  });
  void chrome.windows
    .getCurrent()
    .then(async (currentWindow) => {
      key = `coPlusPanelNavigation:${currentWindow.id}`;
      const stored = await chrome.storage.session.get(key);
      if (!receivedChange) activate(stored[key]);
    })
    .catch((error) => console.warn("[panel] navigation failed", error));
}

function wireTabs() {
  if (!els.tabsEl) return;

  els.tabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (btn) setActiveTab(btn.id);
  });

  els.tabsEl.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;

    const tabs = [...els.tabsEl.querySelectorAll(".tab")];
    const current = document.activeElement.closest(".tab");
    const i = Math.max(0, tabs.indexOf(current));
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % tabs.length
        : (i - 1 + tabs.length) % tabs.length;

    tabs[next].focus();
    setActiveTab(tabs[next].id);
    e.preventDefault();
  });

  requestAnimationFrame(() => setActiveTab("t-progress"));
  window.addEventListener("resize", () => {
    const active = document.querySelector(".tab.is-active")?.id;
    if (active) setActiveTab(active);
  });
}

// --------------------
// Toggle dependent cards
// --------------------
function toggleGroup(selector, enabled) {
  document.querySelectorAll(selector).forEach((el) => {
    el.classList.toggle("is-hidden", !enabled);
  });
}

// --------------------
// Progress UI
// --------------------
function renderProgress(
  { barEl, statusEl, countEl, cancelEl, errorEl },
  progress,
) {
  if (!progress) return;

  const total = progress.total || 0;
  const completed = progress.completed || 0;
  const running = !!progress.running;
  const errMsg = progress.error || "";

  if (cancelEl) cancelEl.disabled = !running;

  if (barEl) barEl.classList.toggle("is-error", !!errMsg);

  // show/hide error line
  if (errorEl) {
    errorEl.hidden = !errMsg;
    errorEl.textContent = errMsg;
  }

  if (errMsg) {
    if (statusEl) statusEl.textContent = "Error";
    // keep count as 0/0 when errored
    if (countEl) countEl.textContent = "0 / 0";
    if (barEl) barEl.style.width = "100%";
    return;
  }

  const cancelled = !running && total > 0 && completed < total;
  if (cancelled || (!running && total === 0)) {
    if (statusEl) statusEl.textContent = "Idle";
    if (countEl) countEl.textContent = "0 / 0";
    if (barEl) barEl.style.width = "0%";
    return;
  }

  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  if (statusEl) statusEl.textContent = running ? "Running" : "Done";
  if (countEl) countEl.textContent = `${completed} / ${total}`;
  if (barEl) barEl.style.width = `${percent}%`;
}
function handleScreenshotProgress(progress) {
  const running = !!progress?.running;

  // auto-switch to screenshots tab on start
  if (running && !wasScreenshotRunning) setActiveTab("t-screenshot");
  wasScreenshotRunning = running;

  renderProgress(
    {
      barEl: els.sBar,
      statusEl: els.sStatusText,
      countEl: els.sCount,
      cancelEl: els.sCancel,
      errorEl: els.sError,
    },
    progress,
  );
}

function handleVideoProgress(progress) {
  const running = !!progress?.running;

  // auto-switch to videos tab on start or error
  if ((running && !wasVideoRunning) || progress?.error)
    setActiveTab("t-videos");
  wasVideoRunning = running;

  renderProgress(
    {
      barEl: els.vBar,
      statusEl: els.vStatusText,
      countEl: els.vCount,
      cancelEl: els.vCancel,
      errorEl: els.vError,
    },
    progress,
  );
}

function wireProgress() {
  chrome.runtime.onMessage.addListener((msg) => {
    // IMPORTANT: background broadcasts include tabId now; only accept current tab's
    (async () => {
      const activeTabId = await getActiveTabId();
      if (!activeTabId) return;

      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.action === "progressUpdate") {
          screenshotRunTabId = msg.tabId; // ✅ store
          handleScreenshotProgress(msg.progress);
        }
        if (msg?.action === "videoProgressUpdate") {
          videoRunTabId = msg.tabId; // ✅ store
          handleVideoProgress(msg.progress);
        }
      });
    })();
  });

  // initial fetch for current tab
  (async () => {
    const tabId = await getActiveTabId();
    if (!tabId) return;

    chrome.runtime.sendMessage({ action: "getProgress", tabId }, (p) =>
      handleScreenshotProgress(p),
    );
    chrome.runtime.sendMessage({ action: "getVideoProgress", tabId }, (p) =>
      handleVideoProgress(p),
    );
  })();
}

// --------------------
// Settings
// --------------------
function wireSettings() {
  els.sSave?.addEventListener("click", () => {
    const delay = parseInt(
      els.sDelay?.dataset.value ?? els.sDelay?.value ?? DEFAULTS.delay,
      10,
    );
    const scale = parseFloat(els.sScale?.value ?? DEFAULTS.scale);
    const imageType = els.sImageType?.value ?? DEFAULTS.imageType;

    chrome.storage.sync.set({ delay, scale, imageType }, () => {
      if (!els.sSaveStatus) return;
      els.sSaveStatus.textContent = "Settings saved!";
      setTimeout(() => (els.sSaveStatus.textContent = ""), 1200);
    });
  });

  els.vSave?.addEventListener("click", () => {
    const videoQuality = els.vQuality?.value ?? DEFAULTS.videoQuality;

    chrome.storage.sync.set({ videoQuality }, () => {
      if (!els.vSaveStatus) return;
      els.vSaveStatus.textContent = "Settings saved!";
      setTimeout(() => (els.vSaveStatus.textContent = ""), 1200);
    });
  });
}

// --------------------
// Frames (detected per size by the content script)
// --------------------
let frameRequestId = 0;

function setFrameStatus(text, isError = false) {
  els.fStatus.textContent = text;
  els.fStatus.classList.toggle("errorText", isError);
  els.fStatus.classList.toggle("hint", !isError);
}
let selectedFrames = [];
let detectedMax = 0; // highest frame number found for the current page; 0 = none/unknown/detecting

// The delay only applies to the single capture; frames are captured instantly
function updateDelayState() {
  const input = els.sDelay;
  if (!input) return;
  // Only disabled while the current page actually has frames that are selected
  const off = selectedFrames.some((f) => f <= detectedMax);

  // A number input can't show text, so it becomes a text field while disabled
  if (off && input.type === "number") {
    input.dataset.value = input.value;
    input.type = "text";
    input.value = `${input.dataset.value} (disabled)`;
  } else if (!off && input.type === "text") {
    input.type = "number";
    input.value = input.dataset.value ?? input.value;
    delete input.dataset.value;
  }
  input.disabled = off;
  input.title = off ? "Not used while frames are selected" : "";
}

function renderFrames(sizes) {
  const entries = Object.entries(sizes || {});
  const max = Math.max(0, ...entries.map(([, frames]) => frames.length));
  detectedMax = max;
  updateDelayState();

  els.fChoices.replaceChildren();
  for (let n = 1; n <= max; n++) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = String(n);
    box.checked = selectedFrames.includes(n);
    box.addEventListener("change", () => {
      selectedFrames = [...els.fChoices.querySelectorAll("input:checked")].map(
        (i) => Number(i.value),
      );
      chrome.storage.sync.set({ screenshotFrames: selectedFrames });
      updateDelayState();
    });
    label.append(box, `Frame ${n}`);
    els.fChoices.append(label);
  }

  setFrameStatus(
    max
      ? "Select the frames to capture:"
      : "No frame labels found in these creatives.",
  );
}

async function refreshFrames(force = false) {
  // Only a Choreograph page can answer. The extension's own capture/probe tabs (blob: pages and
  // popups) become the active tab while screenshots run, so they must not wipe the panel.
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!/^https:\/\/create\.choreograph\.com\//.test(tab?.url || "")) {
    if (frameRequestId === 0) {
      setFrameStatus("Open an adset's ad-variants page to detect frames.");
    }
    return;
  }

  const requestId = ++frameRequestId;
  setFrameStatus("Detecting frames…");
  els.fChoices.replaceChildren();
  detectedMax = 0;
  updateDelayState();
  const tabId = tab.id;

  chrome.tabs.sendMessage(tabId, { action: "getFrameInfo", force }, (resp) => {
    if (requestId !== frameRequestId) return; // a newer request superseded this one
    if (chrome.runtime.lastError || !resp) {
      setFrameStatus("Open an adset's ad-variants page to detect frames.");
      return;
    }
    if (!resp.success) {
      detectedMax = 0;
      updateDelayState();
      setFrameStatus(resp.error || "Frame detection failed.", true);
      return;
    }
    renderFrames(resp.sizes);
  });
}

function wireFrames() {
  els.fRefresh?.addEventListener("click", () => refreshFrames(true));

  const refresh = debounce(() => refreshFrames(false), 400);
  chrome.tabs.onActivated.addListener(refresh);
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (tab.active && (info.url || info.status === "complete")) refresh();
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// --------------------
// Cancel (must include tabId)
// --------------------
function wireCancel() {
  els.sCancel?.addEventListener("click", async () => {
    if (!screenshotRunTabId) return;
    chrome.runtime.sendMessage({
      action: "cancelScreenshots",
      tabId: screenshotRunTabId,
      closePanel: true,
    });
  });

  els.vCancel?.addEventListener("click", async () => {
    if (!videoRunTabId) return;
    chrome.runtime.sendMessage({
      action: "cancelVideos",
      tabId: videoRunTabId,
      closePanel: true,
    });
  });
}

// --------------------
// Init
// --------------------
function wireRecordings() {
  const enabled = document.getElementById("recordingsEnabled");
  const endpoints = Object.fromEntries(
    ["Start", "End"].map((name) => [
      name.toLowerCase(),
      {
        mode: document.getElementById(`recording${name}Mode`),
        seconds: document.getElementById(`recording${name}Seconds`),
        frame: document.getElementById(`recording${name}Frame`),
        frameMode: document.getElementById(`recording${name}FrameMode`),
      },
    ]),
  );
  const frameStatus = document.getElementById("recordingFrameStatus");
  const frameRefresh = document.getElementById("recordingFrameRefresh");
  const save = document.getElementById("recordingSave");
  const scale = document.getElementById("recordingScale");
  const status = document.getElementById("recordingStatus");
  const authorization = document.getElementById("recordingAuthorization");
  const count = document.getElementById("recordingCount");
  const cancel = document.getElementById("recordingCancel");
  const start = document.getElementById("recordingStart");
  const clear = document.getElementById("recordingClear");
  const progress = document.getElementById("recordingProgress");
  const clipBox = document.getElementById("recordingClip");
  const clipTime = document.getElementById("recordingClipTime");
  const clipProgress = document.getElementById("recordingClipProgress");
  let clipTimer = null;
  const error = document.getElementById("recordingError");
  const download = document.getElementById("recordingDownload");
  const pptx = document.getElementById("recordingPptx");
  let pptxPending = false;
  const settingsStatus = document.getElementById("recordingSettingsStatus");
  let current;
  let requestId = 0;
  let pending = false;
  let selectedId = null;
  let frames = [];
  let framesReady = false;
  let frameSource = null;
  let frameRequest = 0;
  let settingsReady = false;
  let rangeError = "";
  let savedRange = RecordingCore.recordingRange();
  const terminal = (value) =>
    ["Ready", "Done", "Cancelled", "Stopped", "Error"].includes(value);
  const readRange = () => {
    const read = (field) =>
      field === endpoints.start &&
      field.mode.value === "frame" &&
      field.frame.value === "0"
        ? { type: "seconds", value: 0 }
        : {
            type: field.mode.value,
            value:
              field.mode.value === "frame"
                ? field.frame.value
                : field.seconds.value,
          };
    const range = RecordingCore.recordingRange(
      read(endpoints.start),
      read(endpoints.end),
    );
    for (const endpoint of [range.start, range.end]) {
      if (endpoint.type === "frame" && !frames.includes(endpoint.value))
        throw new Error(
          framesReady
            ? `Frame ${endpoint.value} is not detected for this adset. Re-detect frames or use seconds.`
            : "Detecting frame labels...",
        );
    }
    return range;
  };
  const endFrames = () =>
    endpoints.start.mode.value === "frame"
      ? frames.filter((number) => number > Number(endpoints.start.frame.value))
      : frames;
  const updateEndpointDisplay = () => {
    for (const [name, field] of Object.entries(endpoints)) {
      field.seconds.hidden = field.mode.value === "frame";
      field.frame.hidden = field.mode.value !== "frame";
      field.frameMode.disabled =
        (name === "end" ? endFrames() : frames).length === 0;
    }
  };
  const renderFrameOptions = () => {
    for (const [name, field] of Object.entries(endpoints)) {
      let selected = field.selectedFrame ?? field.frame.value;
      const available =
        name === "end" ? endFrames() : frames.length ? [0, ...frames] : [];
      const bannerStart = name === "start" && selected === "0";
      if (
        framesReady &&
        field.mode.value === "frame" &&
        (!available.length ||
          (selected && !frames.includes(Number(selected)) && !bannerStart))
      ) {
        field.mode.value = "seconds";
        field.seconds.value = name === "start" ? "0" : "15";
      }
      if (framesReady && !available.includes(Number(selected)))
        selected = available.length ? String(available[0]) : "";
      field.frame.replaceChildren();
      for (const number of available) {
        const option = document.createElement("option");
        option.value = String(number);
        option.textContent =
          name === "start" && number === 0 ? "Banner start" : `Frame ${number}`;
        field.frame.append(option);
      }
      if (!framesReady && field.mode.value === "frame") {
        const option = document.createElement("option");
        option.value = selected;
        option.textContent = "Detecting frames...";
        option.disabled = true;
        field.frame.append(option);
      }
      field.frame.value =
        selected || (available.length ? String(available[0]) : "");
      field.selectedFrame = field.frame.value;
    }
    updateEndpointDisplay();
  };
  const applyRange = (range) => {
    for (const name of ["start", "end"]) {
      const field = endpoints[name];
      const keepBannerStart =
        name === "start" &&
        range[name].type === "seconds" &&
        range[name].value === 0 &&
        field.mode.value === "frame" &&
        field.selectedFrame === "0";
      field.mode.value = keepBannerStart ? "frame" : range[name].type;
      if (range[name].type === "seconds")
        field.seconds.value = String(range[name].value);
      field.selectedFrame = keepBannerStart
        ? "0"
        : range[name].type === "frame"
          ? String(range[name].value)
          : "";
    }
    renderFrameOptions();
  };
  const updateControls = () => {
    const busy = !!current && !terminal(current.status);
    let valid = settingsReady;
    const previousError = rangeError;
    rangeError = "";
    try {
      readRange();
    } catch (failure) {
      valid = false;
      rangeError = failure.message;
    }
    if (settingsReady && rangeError) settingsStatus.textContent = rangeError;
    else if (previousError && settingsStatus.textContent === previousError)
      settingsStatus.textContent = "";
    start.disabled =
      pending ||
      !enabled.checked ||
      !current ||
      busy ||
      !!current.sourceClosed ||
      !valid;
    start.textContent =
      current &&
      !["Ready", "Preparing preview"].includes(current.status) &&
      !busy
        ? "Record again"
        : "Start recording";
    cancel.disabled = pending || !current || !busy;
    clear.disabled = pending || !current || busy;
    pptx.disabled = pending || busy;
    pptx.textContent = pptxPending ? "Creating PPTX..." : "Download PPTX";
    for (const field of Object.values(endpoints)) {
      field.mode.disabled = busy || pending;
      field.seconds.disabled = busy || pending;
      field.frame.disabled = busy || pending || !framesReady;
    }
    save.disabled = busy || pending || !settingsReady;
    frameRefresh.disabled = busy || pending;
    updateEndpointDisplay();
  };
  const refreshFrameOptions = async (force = false) => {
    let request;
    try {
      const tab = current?.sourceTabId
        ? await chrome.tabs.get(current.sourceTabId)
        : (
            await chrome.tabs.query({ active: true, lastFocusedWindow: true })
          )[0];
      if (!/^https:\/\/create\.choreograph\.com\//.test(tab?.url || "")) {
        frameSource = null;
        frameRequest++;
        frames = [];
        framesReady = true;
        frameStatus.textContent = "Open an adset preview to detect frames.";
        renderFrameOptions();
        updateControls();
        return;
      }
      const source = `${tab.id}:${tab.url.split("?")[0]}`;
      if (!force && frameSource === source) return;
      frameSource = source;
      request = ++frameRequest;
      frameStatus.textContent = "Detecting frames...";
      frames = [];
      framesReady = false;
      renderFrameOptions();
      updateControls();
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: "getFrameInfo",
        force,
      });
      if (request !== frameRequest) return;
      if (!response?.success)
        throw new Error(response?.error || "Frame detection unavailable.");
      frames = [
        ...new Set(
          Object.values(response.sizes || {})
            .flat()
            .filter((number) => Number.isInteger(number) && number > 0),
        ),
      ].sort((first, second) => first - second);
      framesReady = true;
      frameStatus.textContent = frames.length
        ? `${frames.length} frame${frames.length === 1 ? "" : "s"} detected`
        : "No frame labels detected.";
      renderFrameOptions();
      updateControls();
    } catch (failure) {
      if (request !== undefined && request !== frameRequest) return;
      frames = [];
      framesReady = true;
      frameStatus.textContent = failure.message;
      renderFrameOptions();
      updateControls();
    }
  };
  const renderClip = () => {
    clearInterval(clipTimer);
    clipTimer = null;
    const active =
      current &&
      !terminal(current.status) &&
      current.status !== "Awaiting toolbar authorization";
    clipBox.hidden = !active;
    if (!active) return;
    const clip = current.clipProgress;
    if (!clip) {
      clipProgress.removeAttribute("value");
      clipTime.textContent = /^Finalizing/.test(current.status)
        ? "Finalizing..."
        : "Preparing...";
      return;
    }
    const tick = () => {
      const elapsed = Math.min(
        clip.duration,
        Math.max(0, (Date.now() - clip.startedAt) / 1000),
      );
      clipProgress.max = clip.duration;
      clipProgress.value = elapsed;
      clipTime.textContent = `${elapsed.toFixed(1)} / ${clip.duration.toFixed(1)} s`;
    };
    tick();
    clipTimer = setInterval(tick, 100);
  };
  const refresh = async () => {
    const request = ++requestId;
    const stored = await chrome.storage.session.get(null);
    if (request !== requestId) return;
    current = Object.entries(stored).find(([key]) =>
      key.startsWith("coPlusRecording:"),
    )?.[1];
    if (current && selectedId !== current.id) setActiveTab("t-recordings");
    selectedId = current?.id || null;
    const awaitingClick = current?.status === "Awaiting toolbar authorization";
    status.textContent = awaitingClick
      ? "Click CO Plus to start"
      : current?.status || "Idle";
    authorization.hidden = !awaitingClick;
    const total = current?.jobs.length || 0;
    const completed = current?.completed || 0;
    count.textContent = `${completed} / ${total}`;
    progress.max = total || 1;
    progress.value = completed;
    renderClip();
    error.hidden = !current?.error;
    error.textContent = current?.error || "";
    download.hidden = !current?.download;
    if (current?.download) {
      download.href = current.download.url;
      download.download = current.download.name;
      download.textContent = current.download.name.endsWith(".zip")
        ? "Download ZIP"
        : "Download MP4";
    } else download.removeAttribute("href");
    pptx.hidden = !current?.download;
    updateControls();
    void refreshFrameOptions();
  };
  const command = async (value) => {
    if (!current || pending) return;
    pending = true;
    pptxPending = value === "pptx";
    updateControls();
    try {
      const response = await chrome.runtime.sendMessage({
        action: "recordingCommand",
        command: value,
        id: current.id,
        ...(value === "start"
          ? { range: readRange(), scale: Number(scale.value) }
          : {}),
      });
      if (!response?.success)
        throw new Error(response?.error || "Recording request failed.");
      if (value === "pptx") {
        const link = document.createElement("a");
        link.href = response.data.url;
        link.download = response.data.name;
        link.click();
      }
      await refresh();
    } catch (failure) {
      error.hidden = false;
      error.textContent = failure.message;
    } finally {
      pending = false;
      pptxPending = false;
      updateControls();
    }
  };
  chrome.storage.sync.get(
    {
      recordingsEnabled: true,
      recordingStart: { type: "seconds", value: 0 },
      recordingEnd: { type: "seconds", value: 15 },
      recordingScale: 2,
    },
    (settings) => {
      enabled.checked = settings.recordingsEnabled;
      scale.value = settings.recordingScale === 1 ? "1" : "2";
      try {
        savedRange = RecordingCore.recordingRange(
          settings.recordingStart || { type: "seconds", value: 0 },
          settings.recordingEnd || { type: "seconds", value: 15 },
        );
      } catch (failure) {
        settingsStatus.textContent = failure.message;
      }
      applyRange(savedRange);
      settingsReady = true;
      toggleGroup(".recordingsDependent", enabled.checked);
      updateControls();
    },
  );
  enabled.addEventListener("change", () => {
    chrome.storage.sync.set({ recordingsEnabled: enabled.checked });
    toggleGroup(".recordingsDependent", enabled.checked);
    updateControls();
  });
  save.addEventListener("click", async () => {
    try {
      savedRange = readRange();
      await chrome.storage.sync.set({
        recordingStart: savedRange.start,
        recordingEnd: savedRange.end,
        recordingScale: Number(scale.value),
      });
      settingsStatus.textContent = "Settings saved";
    } catch (failure) {
      settingsStatus.textContent = failure.message;
    }
  });
  for (const field of Object.values(endpoints)) {
    field.mode.addEventListener("change", () => {
      renderFrameOptions();
      updateControls();
    });
    field.seconds.addEventListener("input", updateControls);
    field.frame.addEventListener("change", () => {
      field.selectedFrame = field.frame.value;
      renderFrameOptions();
      updateControls();
    });
  }
  frameRefresh.addEventListener("click", () => {
    void refreshFrameOptions(true);
  });
  start.addEventListener("click", () => {
    void command("start");
  });
  cancel.addEventListener("click", () => {
    void command("cancel");
  });
  clear.addEventListener("click", () => {
    void command("clear");
  });
  pptx.addEventListener("click", () => {
    void command("pptx");
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === "session" &&
      Object.keys(changes).some((key) => key.startsWith("coPlusRecording:"))
    )
      void refresh();
    if (area === "sync" && (changes.recordingStart || changes.recordingEnd)) {
      try {
        savedRange = RecordingCore.recordingRange(
          changes.recordingStart
            ? changes.recordingStart.newValue
            : savedRange.start,
          changes.recordingEnd ? changes.recordingEnd.newValue : savedRange.end,
        );
        applyRange(savedRange);
        updateControls();
      } catch (failure) {
        settingsStatus.textContent = failure.message;
      }
    }
    if (area === "sync" && changes.recordingsEnabled) {
      enabled.checked = changes.recordingsEnabled.newValue;
      toggleGroup(".recordingsDependent", enabled.checked);
      updateControls();
    }
  });
  chrome.tabs.onActivated.addListener(() => {
    void refresh();
  });
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (
      (info.url || info.status === "complete") &&
      (tab.id === current?.sourceTabId || (!current && tab.active))
    )
      void refreshFrameOptions(info.status === "complete");
  });
  void refresh();
}

document.addEventListener("DOMContentLoaded", () => {
  wireTabs();
  wirePanelNavigation();
  wireProgress();
  wireSettings();
  wireCancel();
  wireFrames();
  wireRecordings();

  chrome.storage.sync.get(DEFAULTS, (settings) => {
    selectedFrames = Array.isArray(settings.screenshotFrames)
      ? settings.screenshotFrames
      : [];
    updateDelayState();
    refreshFrames();

    // screenshots
    if (els.sDelay) els.sDelay.value = settings.delay;
    if (els.sScale) els.sScale.value = settings.scale;
    if (els.sImageType) els.sImageType.value = settings.imageType;
    if (els.sEnabled) els.sEnabled.checked = !!settings.screenshotsEnabled;
    toggleGroup(".shotsDependent", !!settings.screenshotsEnabled);

    // videos
    if (els.vEnabled) els.vEnabled.checked = !!settings.videosEnabled;
    if (els.vQuality)
      els.vQuality.value = settings.videoQuality || DEFAULTS.videoQuality;
    toggleGroup(".videosDependent", !!settings.videosEnabled);

    // assets
    if (els.zipSw) els.zipSw.checked = !!settings.assetsZipEnabled;
    if (els.csvSw) els.csvSw.checked = !!settings.assetsCsvEnabled;

    // other
    if (els.indvReload)
      els.indvReload.checked = !!settings.individualReloadEnabled;
    if (els.addTemplateEnabled)
      els.addTemplateEnabled.checked = !!settings.addTemplateEnabled;
    if (els.liveAdsetStatus)
      els.liveAdsetStatus.checked = !!settings.liveAdsetStatusEnabled;
  });

  els.sEnabled?.addEventListener("change", (e) => {
    const enabled = e.target.checked;
    console.log("[panel] screenshotsEnabled ->", e.target.checked);
    chrome.storage.sync.set({ screenshotsEnabled: enabled });
    toggleGroup(".shotsDependent", enabled);
  });

  els.vEnabled?.addEventListener("change", (e) => {
    const enabled = e.target.checked;
    chrome.storage.sync.set({ videosEnabled: enabled });
    toggleGroup(".videosDependent", enabled);
  });

  els.zipSw?.addEventListener("change", (e) => {
    chrome.storage.sync.set({ assetsZipEnabled: e.target.checked });
  });

  els.csvSw?.addEventListener("change", (e) => {
    chrome.storage.sync.set({ assetsCsvEnabled: e.target.checked });
  });

  els.indvReload?.addEventListener("change", (e) => {
    chrome.storage.sync.set({ individualReloadEnabled: e.target.checked });
  });

  els.addTemplateEnabled?.addEventListener("change", (e) => {
    chrome.storage.sync.set({ addTemplateEnabled: e.target.checked });
  });
  els.liveAdsetStatus?.addEventListener("change", (e) => {
    chrome.storage.sync.set({ liveAdsetStatusEnabled: e.target.checked });
  });
});
