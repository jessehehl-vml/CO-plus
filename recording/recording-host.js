let creatingRecordingDocument = null;

async function setRecordingToolbarPrompt(
  tabId,
  visible,
  stage = "authorization",
) {
  if (!tabId) return;
  const setup = stage === "setup";
  const requests = [
    chrome.action.setBadgeText({ tabId, text: visible && !setup ? "GO" : "" }),
    chrome.action.setTitle({
      tabId,
      title: visible
        ? setup
          ? "Open CO Plus to choose a start and end point"
          : "Click CO Plus to start recording this preview"
        : "Open Panel",
    }),
    chrome.scripting.executeScript({
      target: { tabId },
      func: (show, iconUrl, preparing) => {
        document.getElementById("co-plus-recording-authorization")?.remove();
        if (!show) return;
        const prompt = document.createElement("aside");
        prompt.id = "co-plus-recording-authorization";
        prompt.setAttribute("role", "status");
        Object.assign(prompt.style, {
          position: "fixed",
          top: "16px",
          right: "16px",
          width: "360px",
          maxWidth: "calc(100vw - 32px)",
          boxSizing: "border-box",
          padding: "16px",
          border: "2px solid #0014cc",
          borderRadius: "8px",
          background: "#ffffff",
          color: "#101828",
          zIndex: "2147483647",
          font: "14px/1.5 Helvetica, sans-serif",
        });
        const heading = document.createElement("div");
        Object.assign(heading.style, {
          display: "flex",
          alignItems: "center",
          gap: "12px",
        });
        const icon = document.createElement("img");
        icon.src = iconUrl;
        icon.alt = "CO Plus extension icon";
        icon.width = 32;
        icon.height = 32;
        icon.style.flexShrink = "0";
        const title = document.createElement("strong");
        title.textContent = preparing
          ? "Choose a start and end point"
          : "Click CO Plus in Chrome's toolbar";
        heading.append(icon, title);
        const message = document.createElement("p");
        message.textContent = preparing
          ? "In the CO Plus side panel, choose your start and end points, then click Start recording."
          : "At the top right of Chrome, click the CO Plus extension icon to start recording this tab.";
        message.style.margin = "12px 0 0";
        const fallback = document.createElement("p");
        fallback.textContent = preparing
          ? "Side panel closed? Click the CO Plus icon in Chrome's toolbar, or find CO Plus in the Extensions menu (puzzle piece)."
          : "Icon not visible? Open Chrome's Extensions menu (puzzle piece) and choose CO Plus.";
        Object.assign(fallback.style, {
          margin: "8px 0 0",
          color: "#475467",
          fontSize: "13px",
        });
        prompt.append(heading, message, fallback);
        document.documentElement.append(prompt);
      },
      args: [visible, chrome.runtime.getURL("icons/icon40.png"), setup],
    }),
  ];
  if (visible && !setup) {
    requests.push(
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#b45309" }),
    );
    requests.push(chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" }));
  }
  await Promise.allSettled(requests);
}

async function ensureRecordingDocument() {
  if (creatingRecordingDocument) return creatingRecordingDocument;
  creatingRecordingDocument = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("recording/recorder.html")],
    });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: "recording/recorder.html",
        reasons: ["USER_MEDIA", "BLOBS"],
        justification:
          "Record authorized ad tabs and retain local MP4 downloads independently of the side panel.",
      });
    }
  })();
  try {
    await creatingRecordingDocument;
  } finally {
    creatingRecordingDocument = null;
  }
}

async function getRecordingSession(id) {
  const key = `coPlusRecording:${id}`;
  const session = (await chrome.storage.session.get(key))[key];
  if (!session)
    throw new Error(
      "Recording selection expired. Select ads again in Choreograph.",
    );
  return session;
}

async function updateRecordingSession(id, patch) {
  const session = { ...(await getRecordingSession(id)), ...patch };
  await chrome.storage.session.set({ [`coPlusRecording:${id}`]: session });
  return session;
}

async function sendRecordingEngine(action, id, values = {}) {
  const response = await chrome.runtime.sendMessage({
    target: "recording-engine",
    action,
    id,
    ...values,
  });
  if (!response?.success)
    throw new Error(
      response?.error ||
        "The recording engine is unavailable. Clear this selection and try again.",
    );
  return response;
}

function recordingFrameWasRemoved(error) {
  return /Frame with ID \d+ (?:was removed|is not found)|The frame was removed/i.test(
    error?.message || "",
  );
}

async function waitForRecordingPreview(id, predicate, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const session = await getRecordingSession(id);
    if (session.sourceClosed || session.cancelled)
      throw new Error("Recording cancelled.");
    try {
      if (await predicate(session)) return;
    } catch (error) {
      if (!recordingFrameWasRemoved(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function executeRecordingPreview(
  session,
  func,
  args = [],
  allFrames = false,
  world = "MAIN",
) {
  if (!session.captureTabId)
    throw new Error("The ad-preview tab was closed. Retry the recording.");
  return chrome.scripting.executeScript({
    target: { tabId: session.captureTabId, allFrames },
    world,
    func,
    args,
  });
}

function recordingJob(session, index) {
  if (!Number.isInteger(index) || !session.jobs[index])
    throw new Error("Invalid recording job.");
  return session.jobs[index];
}

function layoutRecordingPreview(
  width,
  height,
  sessionId = null,
  outputScale = 1,
) {
  document.documentElement.style.overflow = "hidden";
  Object.assign(document.body.style, {
    margin: "0",
    padding: "0",
    transform: "none",
    transformOrigin: "top left",
  });
  const iframe =
    document.querySelector("ins iframe") ||
    document.querySelector("body > iframe");
  const creative =
    iframe ||
    document.getElementById("ad-container") ||
    document.querySelector("ins");
  if (iframe)
    Object.assign(iframe.style, {
      display: "block",
      border: "0",
      width: `${width}px`,
      height: `${height}px`,
      boxSizing: "content-box",
    });
  const natural = creative?.getBoundingClientRect();
  const right = natural?.width > 0 ? natural.right : width;
  const bottom = natural?.height > 0 ? natural.bottom : height;
  const scale = Math.min(
    Math.max(1, outputScale / devicePixelRatio),
    Math.max(1, innerWidth - 24) / Math.max(width, right),
    Math.max(1, innerHeight - 24) / Math.max(height, bottom),
  );
  document.body.style.transform = `scale(${scale})`;
  const rect = creative?.getBoundingClientRect();
  const bounds = {
    left: rect?.width > 0 ? rect.left : 0,
    top: rect?.height > 0 ? rect.top : 0,
    width: rect?.width > 0 ? rect.width : width * scale,
    height: rect?.height > 0 ? rect.height : height * scale,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
  };
  if (sessionId) {
    addEventListener("resize", () => {
      void chrome.runtime
        .sendMessage({
          action: "recordingPreviewGeometry",
          id: sessionId,
          bounds: layoutRecordingPreview(width, height, null, outputScale),
        })
        .catch(() => {});
    });
  }
  return bounds;
}

async function measureRecordingPreview(id, index) {
  const session = await getRecordingSession(id);
  const job = recordingJob(session, index);
  const results = await executeRecordingPreview(
    session,
    layoutRecordingPreview,
    [job.width, job.height, null, session.scale || 1],
    false,
    "ISOLATED",
  );
  return results[0].result;
}

async function prepareRecordingPreview(id, index) {
  const session = await updateRecordingSession(id, { activeJob: index });
  const job = recordingJob(session, index);
  let previousDocumentId = null;
  try {
    const tab = await chrome.tabs.get(session.captureTabId);
    if (tab.url === job.blobUrl) {
      const [previous] = await executeRecordingPreview(
        session,
        () => location.href,
      );
      previousDocumentId = previous?.documentId || null;
    }
  } catch (error) {
    if (!recordingFrameWasRemoved(error)) throw error;
  }
  await chrome.tabs.update(session.captureTabId, { url: job.blobUrl });
  await waitForRecordingPreview(
    id,
    async (current) => {
      const tab = await chrome.tabs.get(current.captureTabId);
      if (tab.url !== job.blobUrl) return false;
      try {
        const results = await executeRecordingPreview(
          current,
          (expectedUrl) =>
            location.href === expectedUrl && document.readyState !== "loading",
          [job.blobUrl],
        );
        return (
          results[0]?.result === true &&
          (!previousDocumentId ||
            (typeof results[0].documentId === "string" &&
              results[0].documentId !== previousDocumentId))
        );
      } catch (error) {
        if (recordingFrameWasRemoved(error)) return false;
        throw error;
      }
    },
    20000,
    "The ad preview document did not open. Keep Choreograph open, refresh it, and select the ads again.",
  );
  await executeRecordingPreview(session, () => {
    document.title = "CO Plus - Ad Recording";
  });
  const bounds = await measureRecordingPreview(id, index);
  await waitForRecordingPreview(
    id,
    async (current) => {
      const results = await executeRecordingPreview(
        current,
        () => {
          const timeline = window.Creative?.timeline;
          if (
            (document.fonts && document.fonts.status !== "loaded") ||
            [...document.images].some((image) => !image.complete)
          )
            return { ready: false, timeline: !!timeline };
          if (!timeline) {
            const wrapper = document.querySelector("body > ins");
            const rendered =
              !wrapper ||
              !!document.querySelector(
                "iframe, #ad-container, img, canvas, video",
              );
            return {
              ready: document.readyState === "complete" && rendered,
              timeline: false,
            };
          }
          if (timeline.paused() && timeline.time() === 0) return null;
          timeline.pause(0, true);
          document.querySelectorAll("video, audio").forEach((media) => {
            media.muted = true;
            media.pause();
            media.currentTime = 0;
          });
          return { ready: true, timeline: true };
        },
        [],
        true,
      );
      const timelineFrames = results.filter(
        (result) => result.result?.timeline,
      );
      if (timelineFrames.length) {
        if (!timelineFrames.some((result) => result.result.ready)) return false;
        await updateRecordingSession(id, { playbackMode: "timeline" });
        return true;
      }
      if (
        results.length &&
        results.every(
          (result) => result.result?.ready && !result.result.timeline,
        )
      ) {
        await updateRecordingSession(id, { playbackMode: "realtime" });
        return true;
      }
      return false;
    },
    20000,
    "The creative did not finish loading its document, fonts, or images before the recording timeout.",
  );
  return bounds;
}

async function watchRecordingPreview(id) {
  const session = await getRecordingSession(id);
  const job = recordingJob(session, session.activeJob || 0);
  const results = await executeRecordingPreview(
    session,
    layoutRecordingPreview,
    [job.width, job.height, id, session.scale || 1],
    false,
    "ISOLATED",
  );
  return results[0].result;
}

async function resolveRecordingPreviewRange(id) {
  const session = await getRecordingSession(id);
  const results = await executeRecordingPreview(
    session,
    () => {
      const timeline = window.Creative?.timeline;
      return timeline ? { labels: { ...timeline.labels } } : null;
    },
    [],
    true,
  );
  const timeline = results.find((result) => result.result)?.result;
  if (!timeline) {
    const range = session.range || RecordingCore.recordingRange();
    if (range.start.type !== "seconds" || range.end.type !== "seconds")
      throw new Error(
        "This creative has no timeline. Choose seconds for both Start and End.",
      );
    const clip = {
      ...RecordingCore.resolveRecordingRange(range),
      realTime: true,
    };
    await updateRecordingSession(id, { clip, playbackMode: "realtime" });
    return clip;
  }
  const clip = RecordingCore.resolveRecordingRange(
    session.range || RecordingCore.recordingRange(),
    timeline.labels,
  );
  const markerSequence = (session.markerSequence || 0) + 1;
  const color = [
    32 + (markerSequence % 4) * 64,
    32 + (Math.floor(markerSequence / 4) % 4) * 64,
    32 + (Math.floor(markerSequence / 16) % 4) * 64,
  ];
  await updateRecordingSession(id, { clip, markerSequence });
  const seek = await executeRecordingPreview(
    session,
    async (start) => {
      const timeline = window.Creative?.timeline;
      if (!timeline) return false;
      timeline.pause(start, false);
      document.querySelectorAll("video, audio").forEach((media) => {
        media.muted = true;
        media.pause();
      });
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      return true;
    },
    [clip.start],
    true,
  );
  if (!seek.some((result) => result.result === true))
    throw new Error("Could not seek the creative to the selected start.");
  const markerResults = await executeRecordingPreview(
    session,
    (markerColor) => {
      document.getElementById("co-plus-recording-sync")?.remove();
      const marker = document.createElement("div");
      marker.id = "co-plus-recording-sync";
      marker.setAttribute("aria-hidden", "true");
      Object.assign(marker.style, {
        position: "fixed",
        right: "4px",
        bottom: "4px",
        width: "16px",
        height: "16px",
        margin: "0",
        padding: "0",
        border: "0",
        boxShadow: "none",
        pointerEvents: "none",
        background: `rgb(${markerColor.join(",")})`,
        opacity: "1",
        zIndex: "2147483647",
      });
      document.documentElement.append(marker);
      const rect = marker.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        color: markerColor,
      };
    },
    [color],
    false,
    "ISOLATED",
  );
  return { ...clip, syncMarker: markerResults[0].result };
}

async function resumeRecordingPreview(id) {
  const session = await getRecordingSession(id);
  if (session.clip?.realTime) {
    await prepareRecordingPreview(id, session.activeJob || 0);
    const startedAt = Date.now();
    await executeRecordingPreview(
      session,
      () => {
        const timeline = window.Creative?.timeline;
        if (timeline) timeline.play(0, false);
        document.querySelectorAll("video, audio").forEach((media) => {
          media.muted = true;
          void media.play().catch(() => {});
        });
      },
      [],
      true,
    );
    const bounds = await watchRecordingPreview(id);
    return { startedAt, bounds, realTime: true };
  }
  const results = await executeRecordingPreview(
    session,
    (start) => {
      const timeline = window.Creative?.timeline;
      if (!timeline) return null;
      if (typeof timeline.timeScale === "function") timeline.timeScale(1);
      const startedAt = Date.now();
      timeline.play(start, false);
      document.querySelectorAll("video, audio").forEach((media) => {
        media.muted = true;
        void media.play().catch(() => {});
      });
      return { startedAt };
    },
    [session.clip?.start || 0],
    true,
  );
  const started = results.find((result) => result.result)?.result;
  if (!started)
    throw new Error("Creative timeline disappeared before recording.");
  return started;
}

async function pauseRecordingPreview(id) {
  const session = await getRecordingSession(id);
  await executeRecordingPreview(
    session,
    (end) => {
      const timeline = window.Creative?.timeline;
      if (timeline) timeline.pause(end, true);
      document
        .querySelectorAll("video, audio")
        .forEach((media) => media.pause());
    },
    [session.clip?.end],
    true,
  );
}

async function closeRecordingPreview(id) {
  const session = await getRecordingSession(id);
  await setRecordingToolbarPrompt(session.captureTabId, false);
  await updateRecordingSession(id, { captureTabId: null });
  if (session.captureTabId)
    await chrome.tabs.remove(session.captureTabId).catch(() => {});
}
