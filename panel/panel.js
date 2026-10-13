// panel.js
// Requires "tabs" permission in manifest.json if you don't already have it.

const DEFAULTS = {
  // screenshots
  delay: 500,
  scale: 2,
  imageType: "png",
  screenshotFrames: [],
  screenshotsEnabled: true,

  // videos
  videosEnabled: true,
  videoQuality: "1080p",

  // assets
  assetsZipEnabled: true,
  assetsCsvEnabled: true,

  // auto-map
  autoMapEnabled: true,

  // other
  individualReloadEnabled: true,
  addTemplateEnabled: true,
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

  // auto-map: options:
  autoMapSw: document.getElementById("autoMapEnabled"),

  // other: options:
  indvReload: document.getElementById("individualReloadEnabled"),
  addTemplateEnabled: document.getElementById("addTemplateEnabled"), // <— FIXED NAME
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
    els.indicator.style.transform = `translateX(${tabBox.left - parentBox.left}px)`;
  }
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
document.addEventListener("DOMContentLoaded", () => {
  wireTabs();
  wireProgress();
  wireSettings();
  wireCancel();
  wireFrames();

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

    // auto-map
    if (els.autoMapSw) els.autoMapSw.checked = !!settings.autoMapEnabled;

    // other
    if (els.indvReload)
      els.indvReload.checked = !!settings.individualReloadEnabled;
    if (els.addTemplateEnabled)
      els.addTemplateEnabled.checked = !!settings.addTemplateEnabled;
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

  els.autoMapSw?.addEventListener("change", (e) => {
    chrome.storage.sync.set({ autoMapEnabled: e.target.checked });
  });

  els.indvReload?.addEventListener("change", (e) => {
    chrome.storage.sync.set({ individualReloadEnabled: e.target.checked });
  });

  els.addTemplateEnabled?.addEventListener("change", (e) => {
    chrome.storage.sync.set({ addTemplateEnabled: e.target.checked });
  });
});
