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

      // IMPORTANT: don't allow payload to force png forever
      const imageType = settings.imageType;

      try {
        const dataUrl = await captureAdBlob(blobUrl, {
          delay,
          scale,
          imageType,
        });
        sendResponse({ success: true, dataUrl });
      } catch (err) {
        sendResponse({ success: false, error: err?.message || String(err) });
      }
    })();

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
async function captureAdBlob(
  blobUrl,
  { delay = 500, scale = 2, imageType = "png" },
) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: blobUrl, active: true }, async (tab) => {
      if (!tab?.id) return reject(new Error("Could not create tab"));
      captureTabId = tab.id;

      const cleanup = async () => {
        try {
          await chrome.tabs.remove(tab.id);
        } catch {}
        if (captureTabId === tab.id) captureTabId = null;
      };

      try {
        await new Promise((r) => setTimeout(r, 200));

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

        chrome.tabs.update(tab.id, { active: true }, () => {
          chrome.tabs.captureVisibleTab(
            tab.windowId,
            { format: imageType, quality: 100 },
            async (dataUrl) => {
              if (!dataUrl) {
                await cleanup();
                return reject(new Error("Failed to capture tab"));
              }
              await cleanup();
              resolve(dataUrl);
            },
          );
        });
      } catch (err) {
        await cleanup();
        reject(err);
      }
    });
  });
}

// -------------------------------
// SIDE PANEL BEHAVIOR
// -------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});
