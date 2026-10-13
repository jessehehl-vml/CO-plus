// background.js (MV3 service worker)
// Per-tab progress + per-tab errors (screenshots + videos)

const screenshotsByTab = new Map(); // tabId -> { total, completed, running, error }
const videosByTab = new Map(); // tabId -> { total, completed, running, error, runId }

let captureTabId = null; // temporary tab used by captureAdBlob()

// -------------------------------
// HELPERS
// -------------------------------
function getShotState(tabId) {
  if (!screenshotsByTab.has(tabId)) {
    screenshotsByTab.set(tabId, {
      total: 0,
      completed: 0,
      running: false,
      error: null,
    });
  }
  return screenshotsByTab.get(tabId);
}

function getVideoState(tabId) {
  if (!videosByTab.has(tabId)) {
    videosByTab.set(tabId, {
      total: 0,
      completed: 0,
      running: false,
      error: null,
      runId: 0,
    });
  }
  return videosByTab.get(tabId);
}

function broadcastScreenshots(tabId) {
  const progress = getShotState(tabId);
  chrome.runtime
    .sendMessage({ action: "progressUpdate", tabId, progress })
    .catch(() => {});
}

function broadcastVideos(tabId) {
  const progress = getVideoState(tabId);
  chrome.runtime
    .sendMessage({ action: "videoProgressUpdate", tabId, progress })
    .catch(() => {});
}

function sendToTab(tabId, message) {
  return tabId
    ? chrome.tabs.sendMessage(tabId, message).catch(() => {})
    : Promise.resolve();
}

function idleShot(tabId) {
  const st = getShotState(tabId);
  st.total = 0;
  st.completed = 0;
  st.running = false;
  // keep st.error as-is unless caller clears it
  return st;
}

function idleVideo(tabId) {
  const vt = getVideoState(tabId);
  vt.total = 0;
  vt.completed = 0;
  vt.running = false;
  // keep vt.error as-is unless caller clears it
  return vt;
}

// -------------------------------
// MESSAGE ROUTER
// -------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const senderTabId = sender?.tab?.id ?? null;

  // ============================
  // CAPTURE (screenshots)
  // ============================
  if (msg?.action === "captureAdBlob") {
    (async () => {
      if (!senderTabId) {
        sendResponse({
          success: false,
          error: "No sender.tab.id for captureAdBlob",
        });
        return;
      }

      // If this tab is in an error/cancelled state, let capture proceed anyway unless you want to block it.
      // (Most people want single screenshots to keep working.)
      const settings = await chrome.storage.sync.get({
        delay: 500,
        scale: 2,
        imageType: "png", // "png" | "jpeg"
      });

      const blobUrl = msg.payload?.blobUrl;
      if (!blobUrl) {
        sendResponse({
          success: false,
          error: "captureAdBlob missing payload.blobUrl",
        });
        return;
      }

      const delay = msg.payload?.delay ?? settings.delay;
      const scale = msg.payload?.scale ?? settings.scale;
      const frames = Array.isArray(msg.payload?.frames)
        ? msg.payload.frames
        : [];

      // IMPORTANT: don't allow payload to force png forever
      const imageType = settings.imageType;

      try {
        const shots = await captureAdBlob(blobUrl, {
          delay,
          scale,
          imageType,
          frames,
        });
        sendResponse({ success: true, shots });
      } catch (err) {
        sendResponse({ success: false, error: err?.message || String(err) });
      }
    })();

    return true;
  }

  // ============================
  // FRAME DETECTION (static template scan, then hidden tab)
  // ============================
  if (msg?.action === "scanTemplateFrames") {
    scanTemplateFrames(msg.payload?.urls || [])
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) =>
        sendResponse({ success: false, error: err?.message || String(err) }),
      );
    return true;
  }

  if (msg?.action === "probeFrames") {
    const blobUrl = msg.payload?.blobUrl;
    if (!blobUrl) {
      sendResponse({ success: false, error: "probeFrames missing blobUrl" });
      return true;
    }
    probeFrames(blobUrl)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) =>
        sendResponse({ success: false, error: err?.message || String(err) }),
      );
    return true;
  }

  // ============================
  // SCREENSHOTS PROGRESS (per-tab)
  // ============================
  if (msg?.action === "initProgress") {
    if (!senderTabId) {
      sendResponse({
        success: false,
        error: "No sender.tab.id for initProgress",
      });
      return true;
    }

    const st = getShotState(senderTabId);
    st.total = msg.total || 0;
    st.completed = 0;
    st.running = true;
    st.error = null;

    broadcastScreenshots(senderTabId);
    sendResponse({ success: true });
    return true;
  }

  if (msg?.action === "incrementProgress") {
    if (!senderTabId) {
      sendResponse({
        success: false,
        error: "No sender.tab.id for incrementProgress",
      });
      return true;
    }

    const st = getShotState(senderTabId);

    if (!st.running) {
      sendResponse({ success: false, ignored: true });
      return true;
    }

    st.completed = Math.min(st.completed + 1, st.total);
    if (st.completed >= st.total) st.running = false;

    broadcastScreenshots(senderTabId);
    sendResponse({ success: true });
    return true;
  }

  if (msg?.action === "screenshotError") {
    if (!senderTabId) {
      sendResponse({
        success: false,
        error: "No sender.tab.id for screenshotError",
      });
      return true;
    }

    const st = idleShot(senderTabId);
    st.error = msg.message || "Unknown screenshot error";

    console.error("[bg] screenshotError", {
      tabId: senderTabId,
      error: st.error,
      details: msg.details,
    });

    broadcastScreenshots(senderTabId);
    sendResponse({ success: true });
    return true;
  }

  if (msg?.action === "getProgress") {
    const tabId = msg.tabId ?? senderTabId;
    if (!tabId) {
      sendResponse({ total: 0, completed: 0, running: false, error: null });
      return true;
    }
    sendResponse(getShotState(tabId));
    return true;
  }

  if (msg?.action === "cancelScreenshots") {
    const tabId = msg.tabId ?? senderTabId; // panel must pass tabId
    if (!tabId) {
      sendResponse({
        success: false,
        error: "cancelScreenshots missing tabId",
      });
      return true;
    }

    (async () => {
      const st = idleShot(tabId);
      st.error = null;

      broadcastScreenshots(tabId);

      await sendToTab(tabId, { action: "cancelScreenshots" });

      if (captureTabId != null) {
        await chrome.tabs.remove(captureTabId).catch(() => {});
        captureTabId = null;
      }

      sendResponse({ success: true });
    })();

    return true;
  }

  // ============================
  // VIDEO PROGRESS (per-tab, runId guarded)
  // ============================
  if (msg?.action === "initVideoProgress") {
    if (!senderTabId) {
      sendResponse({
        success: false,
        error: "No sender.tab.id for initVideoProgress",
      });
      return true;
    }

    const vt = getVideoState(senderTabId);
    vt.runId += 1;
    vt.total = msg.total || 0;
    vt.completed = 0;
    vt.running = true;
    vt.error = null;

    broadcastVideos(senderTabId);
    sendResponse({ success: true, runId: vt.runId });
    return true;
  }

  if (msg?.action === "incrementVideoProgress") {
    if (!senderTabId) {
      sendResponse({
        success: false,
        error: "No sender.tab.id for incrementVideoProgress",
      });
      return true;
    }

    const vt = getVideoState(senderTabId);

    if (!vt.running || msg.runId !== vt.runId) {
      sendResponse({ success: false, ignored: true, currentRunId: vt.runId });
      return true;
    }

    vt.completed = Math.min(vt.completed + 1, vt.total);
    if (vt.completed >= vt.total) vt.running = false;

    broadcastVideos(senderTabId);
    sendResponse({ success: true });
    return true;
  }

  if (msg?.action === "videoFinished") {
    if (!senderTabId) {
      sendResponse({
        success: false,
        error: "No sender.tab.id for videoFinished",
      });
      return true;
    }

    const vt = getVideoState(senderTabId);
    if (msg.runId && msg.runId !== vt.runId) {
      sendResponse({ success: false, ignored: true, currentRunId: vt.runId });
      return true;
    }

    vt.running = false;
    broadcastVideos(senderTabId);
    sendResponse({ success: true });
    return true;
  }

  if (msg?.action === "videoError") {
    if (!senderTabId) {
      sendResponse({
        success: false,
        error: "No sender.tab.id for videoError",
      });
      return true;
    }

    const vt = idleVideo(senderTabId);
    vt.error = msg.message || "Unknown video error";

    console.error("[bg] videoError", {
      tabId: senderTabId,
      error: vt.error,
      details: msg.details,
    });

    broadcastVideos(senderTabId);
    sendResponse({ success: true });
    return true;
  }

  if (msg?.action === "getVideoProgress") {
    const tabId = msg.tabId ?? senderTabId;
    if (!tabId) {
      sendResponse({
        total: 0,
        completed: 0,
        running: false,
        error: null,
        runId: 0,
      });
      return true;
    }
    sendResponse(getVideoState(tabId));
    return true;
  }

  if (msg?.action === "cancelVideos") {
    const tabId = msg.tabId ?? senderTabId; // panel must pass tabId
    if (!tabId) {
      sendResponse({ success: false, error: "cancelVideos missing tabId" });
      return true;
    }

    (async () => {
      const vt = getVideoState(tabId);

      // invalidate current run so late increments are ignored
      vt.runId += 1;

      vt.total = 0;
      vt.completed = 0;
      vt.running = false;
      vt.error = null;

      broadcastVideos(tabId);
      await sendToTab(tabId, { action: "cancelVideos" });

      sendResponse({ success: true });
    })();

    return true;
  }
});

// Cleanup when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  screenshotsByTab.delete(tabId);
  videosByTab.delete(tabId);
});

// -------------------------------
// CAPTURE IMPLEMENTATION
// -------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs inside every frame (MAIN world): frame numbers from "frameN-preview" GSAP labels, plus diagnostics
function readFrameInfo() {
  const timeline = window.Creative?.timeline;
  const labels = Object.keys(timeline?.labels || {});
  return {
    host: location.host || location.protocol,
    visibility: document.visibilityState,
    creative: !!window.Creative,
    timeline: !!timeline,
    labels,
    frames: labels
      .map((k) => /^frame(\d+)-preview$/.exec(k))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b),
  };
}

// Runs inside the creative's frame (MAIN world): jumps the paused timeline to a frame's label
async function seekToFrame(frame, waitForPlay) {
  const timeline = window.Creative?.timeline;
  if (!timeline) return null; // not the creative's frame

  // The creative calls play() once fonts/images are ready; seeking earlier would be undone by it
  if (waitForPlay) {
    const start = Date.now();
    while (timeline.paused() && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const label = `frame${frame}-preview`;
  if (!(label in timeline.labels)) {
    const available = Object.keys(timeline.labels)
      .map((k) => /^frame(\d+)-preview$/.exec(k))
      .filter(Boolean)
      .map((m) => Number(m[1]));
    return { missing: true, available };
  }

  timeline.seek(label, false).pause();
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  return { ok: true };
}

async function runInCreativeFrame(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func,
    args,
  });
  return results.map((r) => r.result).find((r) => r != null) ?? null;
}

async function probeTab(tabId, timeoutMs, { giveUpIfHiddenAfterMs } = {}) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let debug = null;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: readFrameInfo,
      });
      const infos = results.map((r) => r.result).filter(Boolean);
      const found = infos.find((i) => i.frames.length);
      if (found) return { frames: found.frames };
      debug = { frames: infos.length, infos };

      // A hidden tab never starts the creative, so there is no point waiting for the full timeout
      if (
        giveUpIfHiddenAfterMs != null &&
        Date.now() - start > giveUpIfHiddenAfterMs &&
        infos.some((i) => i.timeline && i.visibility === "hidden")
      ) {
        return { frames: [], debug, hidden: true };
      }
    } catch (err) {
      debug = { error: err?.message || String(err) }; // tab still loading
    }
  }
  return { frames: [], debug };
}

// Looks for literal "frameN-preview" label names in the template's HTML and the scripts it loads.
// Fast (no rendering), but can't see labels that are built dynamically or added conditionally.
async function scanTemplateFrames(urls) {
  const found = new Set();
  const seen = new Set();
  // Template URLs are folders (the app serves index.html from them), so request the file explicitly
  const asPage = (url) =>
    /\/[^/]*\.[a-z0-9]+$/i.test(url.split(/[?#]/)[0])
      ? url
      : `${url.replace(/\/$/, "")}/index.html`;
  const queue = urls.slice(0, 5).map((url) => ({ url: asPage(url), depth: 0 }));
  let fetched = 0;
  let failed = 0;
  let maybeDynamic = false; // "-preview" appears in code but not as a literal label name

  while (queue.length && fetched < 12) {
    const { url, depth } = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    let res;
    try {
      res = await fetch(url);
    } catch {
      failed++;
      continue;
    }
    const type = res.headers.get("content-type") || "";
    if (!res.ok) {
      failed++;
      continue;
    }
    if (/^(image|video|audio|font)\//.test(type)) continue;

    const text = await res.text();
    fetched++;
    const before = found.size;
    for (const m of text.matchAll(/["'`]frame(\d+)-preview["'`]/g)) {
      found.add(Number(m[1]));
    }
    // Creative.js is the shared library: it only reads labels (`frame${n}-preview`), never defines them
    const isLibrary = /\/Creative\.js$/i.test(url.split(/[?#]/)[0]);
    if (!isLibrary && found.size === before && /-preview/.test(text))
      maybeDynamic = true;

    if (/html/.test(type) && depth < 1) {
      for (const m of text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
        try {
          const src = new URL(m[1], url);
          // Only the template's own scripts; CDN libraries (jQuery, GSAP) never define frame labels
          if (src.origin === new URL(url).origin)
            queue.push({ url: src.href, depth: depth + 1 });
        } catch {
          // ignore malformed src
        }
      }
    }
  }

  // "complete": every file was read and nothing suggests labels are built dynamically,
  // so an empty result really means the creative has no frames
  const complete =
    fetched > 0 && failed === 0 && queue.length === 0 && !maybeDynamic;
  return {
    frames: [...found].sort((a, b) => a - b),
    scanned: fetched,
    complete,
  };
}

let inactiveTabProbeWorks = true; // set to false once a hidden tab is seen not to run the creative

// Reads which frame labels the creative's timeline has. Tries an inactive tab first; if the
// creative never initialises there (hidden tabs don't count as visible), uses an unfocused popup.
async function probeFrames(blobUrl, timeoutMs = 8000) {
  let result = { frames: [] };

  if (inactiveTabProbeWorks) {
    const tab = await chrome.tabs.create({ url: blobUrl, active: false });
    if (!tab?.id) throw new Error("Could not create tab");
    try {
      result = await probeTab(tab.id, timeoutMs, {
        giveUpIfHiddenAfterMs: 2500,
      });
    } finally {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
    if (result.frames.length) return result;
    if (result.hidden) inactiveTabProbeWorks = false;
  }

  const win = await chrome.windows.create({
    url: blobUrl,
    type: "popup",
    focused: false,
    width: 400,
    height: 400,
  });
  try {
    const popupTabId = win?.tabs?.[0]?.id;
    if (!popupTabId) return result;
    const retry = await probeTab(popupTabId, timeoutMs);
    return {
      ...retry,
      debug: { inactiveTab: result.debug, popup: retry.debug },
    };
  } finally {
    if (win?.id) await chrome.windows.remove(win.id).catch(() => {});
  }
}

// Runs in the captured page. Applies the scale to the ad container (if the tag provides one) and
// returns the device pixels per CSS pixel of the ad: display pixel ratio times the applied scale.
async function prepareShot(scale, waitForContainerMs) {
  const find = () => document.getElementById("ad-container");
  const start = Date.now();
  let container = find();
  while (!container && Date.now() - start < waitForContainerMs) {
    await new Promise((r) => setTimeout(r, 50));
    container = find();
  }
  if (container) {
    container.style.transform = `scale(${scale})`;
    container.style.transformOrigin = "top left";
  }
  await new Promise((r) => requestAnimationFrame(r));

  const transform = container && getComputedStyle(container).transform;
  const zoom =
    transform && transform !== "none" ? new DOMMatrix(transform).a : 1;
  return { factor: window.devicePixelRatio * zoom, hasContainer: !!container };
}

async function runPrepareShot(tabId, scale, waitForContainerMs) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: prepareShot,
    args: [scale, waitForContainerMs],
  });
  return res?.result || { factor: 1, hasContainer: false };
}

// chrome.tabs.captureVisibleTab is limited to 2 calls per second
const CAPTURE_MIN_INTERVAL_MS = 520;
let lastCaptureAt = 0;

// Captures need the tab to be visible, so only one can run at a time
let captureQueue = Promise.resolve();
function captureAdBlob(blobUrl, options) {
  const run = captureQueue.then(() => captureAdBlobNow(blobUrl, options));
  captureQueue = run.catch(() => {});
  return run;
}

// Returns [{ frame: number|null, dataUrl, factor }]; frame is null for a plain delayed capture
async function captureAdBlobNow(
  blobUrl,
  { delay = 500, scale = 2, imageType = "png", frames = [] },
) {
  const tab = await chrome.tabs.create({ url: blobUrl, active: true });
  if (!tab?.id) throw new Error("Could not create tab");
  captureTabId = tab.id;

  const capture = async () => {
    const wait = lastCaptureAt + CAPTURE_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();

    return new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(
        tab.windowId,
        { format: imageType, quality: 100 },
        (dataUrl) =>
          dataUrl
            ? resolve(dataUrl)
            : reject(new Error("Failed to capture tab")),
      );
    });
  };

  try {
    if (!frames.length) {
      await sleep(200);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (scale, delay) => {
          const container = document.getElementById("ad-container");
          if (container) {
            container.style.transform = `scale(${scale})`;
            container.style.transformOrigin = "top left";
          }
          const waitForLemonpi =
            window.lemonpiReadyPromise || Promise.resolve();
          return waitForLemonpi.then(
            () => new Promise((r) => setTimeout(r, delay)),
          );
        },
        args: [scale, delay],
      });
      const { factor } = await runPrepareShot(tab.id, scale, 0);
      return [{ frame: null, dataUrl: await capture(), factor }];
    }

    const shots = [];
    let waitForContainerMs = 500; // only the first shot waits: if the tag has no container, it never will
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      let seek = null;
      // The tab/creative may not be ready yet on the first attempts
      for (let tries = 0; tries < 200 && !seek; tries++) {
        try {
          seek = await runInCreativeFrame(tab.id, seekToFrame, [
            frame,
            i === 0,
          ]);
        } catch {
          // page still loading
        }
        if (!seek) await sleep(50);
      }
      if (!seek)
        throw new Error("Creative timeline not found in captured page");
      if (seek.missing) continue;

      const { factor, hasContainer } = await runPrepareShot(
        tab.id,
        scale,
        waitForContainerMs,
      );
      if (!hasContainer) waitForContainerMs = 0;

      shots.push({ frame, dataUrl: await capture(), factor });
    }
    return shots;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
    if (captureTabId === tab.id) captureTabId = null;
  }
}

// -------------------------------
// SIDE PANEL BEHAVIOR
// -------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});
