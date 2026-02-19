/**
 * =========================
 * CONTENT.JS INDEX
 * =========================
 * 1) Globals / constants
 * 2) Storage helpers
 * 3) Messaging (cancel + errors)
 * 4) API: adset + ad variants
 * 5) Tools: Screenshots
 * 6) Tools: Videos
 * 7) Tools: Assets (ZIP/CSV)
 * 8) Tools: Auto-map
 * 9) UI Injection (buttons + iframe buttons)
 * 10) Bootstrapping (observers + init)
 */

// =========================
// 1) Globals / constants
// =========================
const session = JSON.parse(localStorage.getItem("session") || "{}");
const accessToken = session.token; // string | undefined
let adsetData = null; // filled later by fetchAdsetData()

// Tool options
const STORAGE_DEFAULTS = {
  delay: 500,
  scale: 2,
  imageType: "png", // "png" | "jpeg"
  screenshotsEnabled: true,

  videoQuality: "1080p", // "1080p" | "720p" | "480p" | "270p"
  videosEnabled: true,

  assetsZipEnabled: true,
  assetsCsvEnabled: true,

  autoMapEnabled: true,

  individualReloadEnabled: true,
};

let nodeTypesCache = null;

async function loadNodeTypes() {
  if (nodeTypesCache) return nodeTypesCache;

  const url = chrome.runtime.getURL("content/node_types.json");

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error("[auto-map] fetch(node_types.json) failed", e);
    throw e;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `node_types.json HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }

  nodeTypesCache = await res.json();
  return nodeTypesCache;
}

const API = {
  dispatch: "https://api.lemonpi.io/dispatch",
  contentBuild: "https://api.lemonpi.io/content-build/v1",
  adsets2: "https://api.lemonpi.io/api/v0/adsets-2",
};

const RE = {
  adVariantsPage:
    /^https:\/\/create\.choreograph\.com\/\d+\/advertiser\/\d+\/campaign\/\d+\/adset\/\d+\/ad-variants/,
  assetsPage:
    /^https:\/\/create\.choreograph\.com\/\d+\/advertiser\/\d+\/assets\?node=\d+/,
};

const SEL = {
  uploadButton: 'button[data-testid="uploadButton"]',
  variantTreeRoot: "#variant-tree-root",
  shareButtonText: "Share",
};

// =========================
// 2) Storage helpers
// =========================
function storageGet(defaults) {
  return new Promise((resolve) => chrome.storage.sync.get(defaults, resolve));
}
function storageSet(values) {
  return new Promise((resolve) => chrome.storage.sync.set(values, resolve));
}
async function getScreenshotSettings() {
  const { delay, scale, imageType, screenshotsEnabled } = await storageGet({
    delay: STORAGE_DEFAULTS.delay,
    scale: STORAGE_DEFAULTS.scale,
    imageType: STORAGE_DEFAULTS.imageType,
    screenshotsEnabled: STORAGE_DEFAULTS.screenshotsEnabled,
  });
  return { delay, scale, imageType, screenshotsEnabled };
}

async function getVideoSettings() {
  const { videoQuality, videosEnabled } = await storageGet({
    videoQuality: STORAGE_DEFAULTS.videoQuality,
    videosEnabled: STORAGE_DEFAULTS.videosEnabled,
  });
  return { videoQuality, videosEnabled };
}
function onStorageChanged(keys, callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (!keys.some((k) => changes[k])) return;
    callback(changes);
  });
}

// =========================
// 3) Messaging (cancel + errors)
// =========================
const state = {
  cancelScreenshots: false,
  cancelVideos: false,
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === "cancelScreenshots") state.cancelScreenshots = true;
  if (msg?.action === "cancelVideos") state.cancelVideos = true;
});

function runtimeSend(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(err);
      resolve(resp);
    });
  });
}

function reportScreenshotError(message, details = {}) {
  console.error("[screenshots]", message, details);
  chrome.runtime.sendMessage({ action: "screenshotError", message, details });
}
function reportVideoError(message, details = {}) {
  console.error("[videos]", message, details);
  chrome.runtime.sendMessage({ action: "videoError", message, details });
}

function initScreenshotProgress(total) {
  chrome.runtime.sendMessage({ action: "initProgress", total });
}
function incScreenshotProgress() {
  chrome.runtime.sendMessage({ action: "incrementProgress" });
}

async function initVideoProgress(total) {
  const resp = await runtimeSend({ action: "initVideoProgress", total });
  return resp?.runId;
}
function incVideoProgress(runId) {
  chrome.runtime.sendMessage({ action: "incrementVideoProgress", runId });
}

// =========================
// 4) API: adset + ad variants
// =========================

function getIdsFromUrl() {
  const match = location.href.match(
    /\/(\d+)\/advertiser\/(\d+)\/campaign\/(\d+)\/adset\/(\d+)\/ad-variants/,
  );
  if (!match) return null;

  const [, agencyId, advertiserId, campaignId, adsetId] = match;
  return { agencyId, advertiserId, campaignId, adsetId };
}

async function apiFetch(url, { method = "GET", headers = {}, body } = {}) {
  if (!accessToken) throw new Error("Access token not available");

  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...headers,
      Authorization: `lemonpi ${accessToken}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `HTTP ${res.status} ${res.statusText} - ${text.slice(0, 300)}`,
    );
  }
  return res;
}

async function fetchAdsetData() {
  const urlMatch = location.href.match(/adset\/(\d+)/);
  if (!urlMatch) throw new Error("No adset ID found in URL");
  const adsetId = urlMatch[1];

  const res = await apiFetch(
    `${API.adsets2}/${adsetId}?embed=%5B%22template_revisions%22%5D`,
    { headers: { Accept: "application/json" } },
  );

  adsetData = await res.json();
  return adsetData;
}

async function fetchPaginated(
  urlString,
  bodyTemplate,
  { extractItems, onProgress } = {},
) {
  let allItems = [];
  let cursor = null;
  let firstFetch = true;
  let totalItems = null;

  do {
    const url = new URL(urlString);
    url.searchParams.set("limit", "100");

    if (firstFetch) {
      url.searchParams.set("sort", "+content-id");
      firstFetch = false;
    } else if (cursor) {
      url.searchParams.set("starting-after", cursor);
    }

    const res = await apiFetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(bodyTemplate),
    });

    const data = await res.json();
    if (totalItems === null) totalItems = data.total ?? 0;

    const items = extractItems ? extractItems(data) : data.data || [];
    allItems.push(...items);

    cursor = items.length > 0 ? items[items.length - 1].cursor : null;

    if (onProgress) onProgress(allItems.length, totalItems);
  } while (cursor);

  return allItems;
}

async function fetchAdVariants({ onProgress } = {}) {
  const ids = getIdsFromUrl();
  if (!ids) throw new Error("Could not extract IDs from URL");

  const url = `${API.contentBuild}/advertisers/${ids.advertiserId}/adsets/${ids.adsetId}/ad-variants-by-content-id`;

  const bodyTemplate = {
    "muix-data-grid": {
      "link-operator": "and",
      filters: [
        {
          operator: "is-any-of",
          column: "ad-variant-status",
          value: [
            "queued",
            "canceled",
            "rendering",
            "error",
            "render-failed",
            "unknown",
            "draft",
            "approved",
            "internal-review",
          ],
        },
      ],
    },
  };

  const items = await fetchPaginated(url, bodyTemplate, {
    extractItems: (res) => res.data || [],
    onProgress,
  });

  return items;
}

// =========================
// 5) Tools: Screenshots
// =========================

// 5.1 Helpers (naming, sanitizing, DOM context)
function sanitizeName(name) {
  return (name || "Unnamed Variant")
    .replace(/[:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getIframeContext(container) {
  const iframe = container.querySelector("iframe");
  const titleEl = container.querySelector("p.MuiTypography-root[aria-label]");
  if (!iframe || !titleEl) return null;

  const width = Number(iframe.getAttribute("width"));
  const height = Number(iframe.getAttribute("height"));
  const contentId = titleEl.getAttribute("aria-label")?.trim();

  if (!width || !height || !contentId) return null;
  return { width, height, contentId };
}

function mergeComponents(apiVariants, previewVariants) {
  const result = {};
  previewVariants.forEach((pv) => {
    const match = apiVariants.find(
      (d) => d?.data?.["content-id"] === pv.variant,
    );
    if (match) result[pv.variant] = match;
  });
  return result;
}
// 5.2 Preview tree selection parsing (only for bulk screenshots)
async function extractVariantsFromPreview() {
  const result = [];

  const variantNodes = Array.from(
    document.querySelectorAll(
      '[data-testid^="variant-tree-item-"]:not([data-testid="variant-tree-item-root"])',
    ),
  ).filter((node) => !node.textContent.includes("HTML5"));

  for (const node of variantNodes) {
    const labelEl = node.querySelector(".MuiTypography-root");
    if (!labelEl) continue;

    const variantName = labelEl.textContent.trim();
    const parentLi = node.closest("li");
    if (!parentLi) continue;

    if (parentLi.getAttribute("aria-expanded") === "false") {
      node.click();
      await new Promise((r) => setTimeout(r, 200));
    }

    const sizeEls = parentLi.querySelectorAll(
      ':scope ul [data-testid^="variant-tree-item-"]',
    );

    const sizes = [];
    sizeEls.forEach((sizeEl) => {
      const label = sizeEl.querySelector(".MuiTypography-root");
      const checkbox = sizeEl.querySelector('input[type="checkbox"]');
      if (label && checkbox?.checked) {
        const text = label.textContent.trim();
        if (text.includes("·")) sizes.push(text.split("·")[1].trim());
      }
    });

    if (sizes.length) result.push({ variant: variantName, sizes });
  }

  return result;
}

// 5.3 Rendering + capture
function buildAdBlob(renderData) {
  const width = renderData.width;
  const height = renderData.height;

  const config = {
    version: 2,
    adserver: { code: "lemonpi" },
    advertiserId: renderData.advertiserId || 0,
    adsetId: renderData.adsetId || 0,
    environment: "prod",
    staticContent: true,
    template: renderData.template,
    exportContent: renderData.content,
  };

  const encodedConfig = btoa(
    String.fromCharCode(...new TextEncoder().encode(JSON.stringify(config))),
  );
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Lemonpi Ad Preview</title>
      <style>
        body { margin: 0; }
        iframe { display: block; }
      </style>
    </head>
    <body>
      <ins width="${width}" height="${height}">
        <script
          data-width="${width}"
          data-height="${height}"
          data-lemonpi-config="${encodedConfig}"
          src="https://creative-libraries.lemonpi.io/v1/display-tag.js">
        </script>

      </ins>
    </body>
    </html>
  `;
  return URL.createObjectURL(new Blob([html], { type: "text/html" }));
}

// 5.4 Core Capture
async function takeScreenshot(match, ctx) {
  if (!match) throw new Error("No matching ad variant found");

  const variantsList = match.data?.["ad-variants"] || [];
  const variant = variantsList.find((v) =>
    v["ad-formats"]?.some(
      (f) => f.width === ctx.width && f.height === ctx.height,
    ),
  );

  if (!variant) {
    throw new Error(
      `No matching ad format for size ${ctx.width}x${ctx.height}`,
    );
  }

  const renderData =
    variant.components?.["urn:lemonpi:artefact:display:content+template"]
      ?.value;

  if (!renderData) throw new Error("Render data missing");

  const { scale, imageType } = await getScreenshotSettings();
  const mime =
    imageType === "jpeg" || imageType === "jpg" ? "image/jpeg" : "image/png";

  const variantName = match.data?.["content-id"] || "Unnamed Variant";
  const safeVariantName = sanitizeName(variantName);
  const sizeString = `${ctx.width}x${ctx.height}`;

  const blobUrl = buildAdBlob(renderData);

  try {
    const response = await runtimeSend({
      action: "captureAdBlob",
      payload: { blobUrl },
    });

    if (!response?.success) {
      throw new Error(
        response?.error ||
          (response?.cancelled ? "Cancelled" : "Capture failed"),
      );
    }

    const dataUrl =
      response.dataUrl || `data:${mime};base64,${response.base64}`;

    const out = await new Promise((resolve, reject) => {
      const img = new Image();

      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = renderData.width * scale;
        canvas.height = renderData.height * scale;

        const ctx2d = canvas.getContext("2d");
        if (!ctx2d) return reject(new Error("Failed to get canvas context"));

        ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error("Failed to create blob"));
            resolve({ blob, safeVariantName, sizeString });
          },
          mime,
          1,
        );
      };

      img.onerror = () => reject(new Error("Failed to decode captured image"));
      img.src = dataUrl;
    });

    return out;
  } finally {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {}
  }
}

// 5.5 Bulk screenshot entrypoint
async function screenshotAll() {
  state.cancelScreenshots = false;

  if (!window.JSZip) {
    reportScreenshotError("JSZip not loaded.", { phase: "zip" });
    return;
  }

  // 1) Fetch API variants (throws on failure)
  let variants;
  try {
    variants = await fetchAdVariants();
  } catch (err) {
    reportScreenshotError(err?.message || String(err), {
      phase: "fetchAdVariants",
      stack: err?.stack,
    });
    return;
  }

  if (!Array.isArray(variants) || variants.length === 0) {
    reportScreenshotError(
      "Failed to fetch ad variants (empty result). Check token/network and refresh the page.",
      { phase: "fetchAdVariants", returnedLength: variants?.length },
    );
    return;
  }

  // 2) Parse selected preview items
  let previewVariants;
  try {
    previewVariants = await extractVariantsFromPreview();
  } catch (err) {
    reportScreenshotError(err?.message || String(err), {
      phase: "extractVariantsFromPreview",
      stack: err?.stack,
    });
    return;
  }

  if (!Array.isArray(previewVariants) || previewVariants.length === 0) {
    reportScreenshotError(
      "No selected preview variants found (nothing to screenshot).",
      {
        phase: "extractVariantsFromPreview",
      },
    );
    return;
  }

  const total = previewVariants.reduce(
    (sum, item) => sum + (item.sizes?.length || 0),
    0,
  );
  if (!total) {
    reportScreenshotError("No sizes selected (0 screenshots).", {
      phase: "count",
    });
    return;
  }

  // 3) Run
  const merged = mergeComponents(variants, previewVariants);
  const zip = new window.JSZip();
  let filesAdded = 0;

  initScreenshotProgress(total);

  for (const pv of previewVariants) {
    if (state.cancelScreenshots) return;

    const component = merged[pv.variant];
    const sizes = pv.sizes || [];

    // if missing component, still increment progress for the sizes so UI doesn't freeze
    if (!component) {
      for (let i = 0; i < sizes.length; i++) incScreenshotProgress();
      continue;
    }

    for (const size of sizes) {
      console.log(state.cancelScreenshots);
      if (state.cancelScreenshots) return;

      const [width, height] = size.split("x").map(Number);

      try {
        const result = await takeScreenshot(component, {
          width,
          height,
          contentId: pv.variant,
        });

        if (result?.blob) {
          const ext = result.blob.type.split("/")[1] || "png";
          zip.file(
            `${result.safeVariantName}_${result.sizeString}.${ext}`,
            result.blob,
          );
          filesAdded++;
        }
      } catch (err) {
        if (state.cancelScreenshots) return;

        const msg = err?.message || String(err);
        if (/Frame with ID .* was removed/i.test(msg)) return; // treat as cancellation/race

        reportScreenshotError(
          `Screenshot failed for ${pv.variant} ${size}: ${msg}`,
          { phase: "takeScreenshot" },
        );
      } finally {
        if (!state.cancelScreenshots) incScreenshotProgress();
      }
    }
  }

  if (state.cancelScreenshots) return;

  // 4) Zip + download
  if (filesAdded === 0) {
    reportScreenshotError(
      "No screenshots were added to the ZIP. This usually means captures failed or nothing matched.",
      { phase: "zip", filesAdded, total },
    );
    return;
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  if (!zipBlob || zipBlob.size < 50) {
    reportScreenshotError(
      `Generated ZIP appears empty/corrupt (size=${zipBlob?.size ?? 0} bytes).`,
      {
        phase: "zipBlob",
        size: zipBlob?.size ?? 0,
        filesAdded,
      },
    );
    return;
  }

  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ad-screenshots.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 250);
}

// =========================
// 6) Tools: Videos
// =========================

// 6.1 VAST key parsing + picking

function parseVastVideoKeys(components = {}) {
  const out = [];
  for (const key of Object.keys(components)) {
    const m = key.match(/^urn:lemonpi:vast:video:scale:([^:]+):kbps:(\d+)$/);
    if (!m) continue;
    out.push({ key, scale: m[1], kbps: Number(m[2]) });
  }
  return out;
}

function desiredHeightFromQuality(q) {
  return { "1080p": 1080, "720p": 720, "480p": 480, "270p": 270 }[q] ?? 1080;
}

function scaleHeight(scale) {
  // based on your observed keys
  const map = {
    full: 1080,
    "two-thirds": 720,
    half: 540,
    "one-thirds": 360,
    quarter: 270,
  };
  return map[scale] ?? null;
}

function pickBestVideoComponentKey(components, videoQuality) {
  const candidates = parseVastVideoKeys(components);
  if (!candidates.length) return null;

  const desired = desiredHeightFromQuality(videoQuality);

  let bestScale = null;
  let bestDiff = Infinity;

  for (const c of candidates) {
    const h = scaleHeight(c.scale);
    if (h == null) continue;
    const diff = Math.abs(h - desired);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestScale = c.scale;
    }
  }

  if (!bestScale) return null;

  // within the chosen scale, pick highest kbps
  return (
    candidates
      .filter((c) => c.scale === bestScale)
      .sort((a, b) => b.kbps - a.kbps)[0]?.key ?? null
  );
}

async function collectVideoFilesForQuality(adVariantsData, videoQuality) {
  const videoFiles = [];
  const usedKeys = new Map();
  let missingKeyCount = 0;

  for (const item of adVariantsData) {
    const contentId = item?.data?.["content-id"];
    const variants = item?.data?.["ad-variants"] || [];

    for (const variant of variants) {
      const components = variant?.components || {};
      const key = pickBestVideoComponentKey(components, videoQuality);

      if (!key) {
        missingKeyCount++;
        continue;
      }

      const url = components[key]?.value;
      if (!url) continue;

      usedKeys.set(key, (usedKeys.get(key) || 0) + 1);

      const { width, height } = variant.dimensions || {};
      const fileName = `${contentId}_${width}x${height}.mp4`;
      videoFiles.push({ url, fileName });
    }
  }

  return {
    videoFiles,
    missingKeyCount,
    usedKeys: Object.fromEntries(usedKeys),
  };
}

function parseVastVideoKeys(components = {}) {
  const out = [];
  for (const key of Object.keys(components)) {
    const m = key.match(/^urn:lemonpi:vast:video:scale:([^:]+):kbps:(\d+)$/);
    if (!m) continue;
    out.push({ key, scale: m[1], kbps: Number(m[2]) });
  }
  return out;
}

// 6.2 Collect video files for the chosen quality

async function collectVideoFilesForQuality(adVariantsData, videoQuality) {
  console.log(adVariantsData, videoQuality);
  const videoFiles = [];
  const usedKeys = new Map();
  let missingKeyCount = 0;

  for (const item of adVariantsData) {
    const contentId = item?.data?.["content-id"];
    const variants = item?.data?.["ad-variants"] || [];

    for (const variant of variants) {
      const components = variant?.components || {};
      const key = pickBestVideoComponentKey(components, videoQuality);

      if (!key) {
        missingKeyCount++;
        continue;
      }

      const url = components[key]?.value;
      if (!url) continue;

      usedKeys.set(key, (usedKeys.get(key) || 0) + 1);

      const meta = components[key]?.metadata || {};
      const w = meta.width ?? variant.dimensions?.width;
      const h = meta.height ?? variant.dimensions?.height;

      const fileName = `${contentId}_${w}x${h}.mp4`;
      videoFiles.push({ url, fileName });
    }
  }

  return {
    videoFiles,
    missingKeyCount,
    usedKeys: Object.fromEntries(usedKeys),
  };
}

// 6.3 Zip + download with progress/cancel
async function zipAndDownloadVideos(videoFiles, runId) {
  if (!window.JSZip) throw new Error("JSZip not loaded");

  const zip = new window.JSZip();

  for (let i = 0; i < videoFiles.length; i++) {
    if (state.cancelVideos) {
      chrome.runtime.sendMessage({ action: "cancelVideos" });
      return;
    }

    const v = videoFiles[i];
    const safeName = (v.fileName || "video.mp4").replace(/\s+/g, "_");

    try {
      const res = await fetch(v.url);
      if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
      zip.file(safeName, await res.blob());
    } catch (err) {
      // keep going but log
      console.warn("[videos] failed download:", safeName, err);
    } finally {
      incVideoProgress(runId);
    }
  }

  if (state.cancelVideos) {
    chrome.runtime.sendMessage({ action: "cancelVideos" });
    return;
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  if (!zipBlob || zipBlob.size < 50) {
    throw new Error(
      `Generated ZIP appears empty/corrupt (size=${zipBlob?.size ?? 0}).`,
    );
  }

  const a = document.createElement("a");
  a.href = URL.createObjectURL(zipBlob);
  a.download = "lemonpi_videos.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(a.href), 250);
}

// 6.4 Core Video Download
async function downloadVideos() {
  state.cancelVideos = false;

  const { videosEnabled, videoQuality } = await getVideoSettings();
  if (!videosEnabled) return;

  // Fetch variants
  let adVariantsData;
  try {
    adVariantsData = await fetchAdVariants();
  } catch (err) {
    reportVideoError(err?.message || String(err), {
      phase: "fetchAdVariants",
      stack: err?.stack,
    });
    return;
  }

  if (!Array.isArray(adVariantsData) || adVariantsData.length === 0) {
    reportVideoError(
      "Failed to fetch ad variants (empty result). Check token/network and refresh the page.",
      { phase: "fetchAdVariants", returnedLength: adVariantsData?.length },
    );
    return;
  }

  // Collect urls
  const { videoFiles, missingKeyCount, usedKeys } =
    await collectVideoFilesForQuality(adVariantsData, videoQuality);

  if (!videoFiles.length) {
    reportVideoError(`No videos found for quality "${videoQuality}".`, {
      phase: "collect",
      videoQuality,
      missingKeyCount,
      usedKeys,
    });
    return;
  }

  // Init progress
  let runId;
  try {
    runId = await initVideoProgress(videoFiles.length);
  } catch (err) {
    reportVideoError(
      `Failed to init video progress: ${err?.message || String(err)}`,
      {
        phase: "initVideoProgress",
        stack: err?.stack,
      },
    );
    return;
  }

  // Zip + download
  try {
    await zipAndDownloadVideos(videoFiles, runId);
    chrome.runtime.sendMessage({ action: "videoFinished", runId });
  } catch (err) {
    reportVideoError(err?.message || String(err), {
      phase: "zipAndDownloadVideos",
      stack: err?.stack,
    });
  }
}

// =========================
// 7) Tools: Assets (ZIP/CSV)
// =========================

// 7.1 Helpers
function getAssetsIdsFromUrl() {
  const m = location.href.match(/\/advertiser\/(\d+)\/assets\?node=(\d+)/);
  if (!m) return null;
  return { advertiserId: Number(m[1]), assetTreeId: Number(m[2]) };
}

function sanitizeFilename(name) {
  return (name || "file").replace(/[:"/\\|?*]+/g, "_");
}

async function listAssets({ advertiserId, assetTreeId }) {
  const res = await apiFetch(API.dispatch, {
    method: "POST",
    headers: {
      "Content-Type": "application/transit+json",
      Accept: "application/transit+json",
    },
    body: JSON.stringify([
      "^ ",
      "~:type",
      "~:asset/list-assets",
      "~:data",
      [
        "^ ",
        "~:asset/advertiser-id",
        advertiserId,
        "~:asset/asset-tree-id",
        assetTreeId,
      ],
    ]),
  });

  const data = await res.json();
  return data?.[1] ?? [];
}

// 7.2 Download all
async function downloadAllAssetsZip() {
  if (!window.JSZip) throw new Error("JSZip not loaded");

  const ids = getAssetsIdsFromUrl();
  if (!ids) {
    console.warn(
      "[assets] Cannot determine advertiserId/assetTreeId from URL.",
    );
    return;
  }

  const assetList = await listAssets(ids);
  if (!assetList.length) {
    console.warn("[assets] No assets found.");
    return;
  }

  const zip = new window.JSZip();
  const added = new Set();

  for (const assetArray of assetList) {
    let url;
    let filename;

    for (const value of assetArray) {
      if (typeof value !== "string") continue;
      if (value.startsWith("https://assets.lemonpi.io")) url = value;
      else if (value.match(/\.(png|jpe?g|webp|gif|mp4|mov|svg)$/i))
        filename ??= value;
    }

    if (!url || !filename) continue;

    filename = sanitizeFilename(filename);
    if (added.has(filename)) continue;

    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      zip.file(filename, await r.blob());
      added.add(filename);
    } catch (e) {
      console.warn("[assets] failed:", filename, e);
    }
  }

  if (!added.size) {
    console.warn("[assets] No files added to ZIP.");
    return;
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  const zipUrl = URL.createObjectURL(zipBlob);

  const a = document.createElement("a");
  a.href = zipUrl;
  a.download = `assets_${ids.assetTreeId}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(zipUrl), 250);
}

// 7.3 Export CSV
async function exportUrlsToCsv() {
  const ids = getAssetsIdsFromUrl();
  if (!ids) {
    console.warn(
      "[assets] Cannot determine advertiserId/assetTreeId from URL.",
    );
    return;
  }

  const assetList = await listAssets(ids);
  if (!assetList.length) {
    console.warn("[assets] No assets found.");
    return;
  }

  const lines = [["name", "imageName", "dimensions", "image_url"]];

  for (const assetArray of assetList) {
    let name;
    let url;

    for (const value of assetArray) {
      if (typeof value !== "string") continue;
      if (value.startsWith("https://assets.lemonpi.io")) url = value;
      else if (value.match(/\.(png|jpe?g|webp|gif|mp4|mov|svg)$/i))
        name ??= value;
    }

    if (!name || !url) continue;

    const extMatch = name.match(/(.*)\.[^.]+$/);
    let imageName = extMatch ? extMatch[1] : name;

    let dimensions = "";
    const dimMatch = imageName.match(/^(.*?)[\s\-_](\d+x\d+)\.?\w*$/);
    if (dimMatch) {
      imageName = dimMatch[1];
      dimensions = dimMatch[2];
    }

    lines.push([
      `"${name.replace(/"/g, '""')}"`,
      `"${imageName.replace(/"/g, '""')}"`,
      `"${dimensions.replace(/"/g, '""')}"`,
      `"${url.replace(/"/g, '""')}"`,
    ]);
  }

  if (lines.length === 1) {
    console.warn("[assets] No valid assets to export.");
    return;
  }

  const csvContent = lines.map((l) => l.join(",")).join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const csvUrl = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = csvUrl;
  a.download = `assets_${ids.assetTreeId}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(csvUrl), 250);
}

// =========================
// 8) Tools: Auto-map
// =========================

// 8.1 Extract + API update

function extractTargetingValues(adVariants) {
  const targetingValues = {};

  adVariants.forEach((item) => {
    const variants = item?.data?.["ad-variants"] || [];
    variants.forEach((variant) => {
      const tValues = variant?.["targeting-values"] || [];
      tValues.forEach(({ name, value }) => {
        if (!targetingValues[name]) targetingValues[name] = [];
        targetingValues[name].push(...(value || []));
      });
    });
  });

  Object.keys(targetingValues).forEach((k) => {
    targetingValues[k] = [...new Set(targetingValues[k])];
  });

  return targetingValues;
}

async function updateTargetingConfig(mappings) {
  if (!accessToken) throw new Error("Access token not available");
  if (!adsetData?.advertiserId || !adsetData?.id) {
    throw new Error("adsetData missing advertiserId or adset id");
  }

  const advertiserId = adsetData.advertiserId;
  const adsetId = adsetData.id;

  const res = await apiFetch(
    `${API.contentBuild}/advertisers/${advertiserId}/adsets/${adsetId}/targeting-config`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(mappings),
    },
  );

  return res.json();
}

// 8.2 predicate builders
function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function parseTimeRange(label) {
  const [start, end] = label.split(">").map((s) => s.trim());
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return { start: { hour: sh, minute: sm }, end: { hour: eh, minute: em } };
}

function parseExactDateRange(label, year = new Date().getUTCFullYear()) {
  if (!label || typeof label !== "string")
    throw new Error("Invalid date range label");

  const parts = label.split(/\s*[-_|>]\s*/);
  if (parts.length !== 2)
    throw new Error(`Invalid date range format: "${label}"`);

  const [rawStart, rawEnd] = parts;
  const startDate = new Date(`${rawStart} ${year} UTC`);
  const endDate = new Date(`${rawEnd} ${year} UTC`);
  if (isNaN(startDate) || isNaN(endDate))
    throw new Error(`Unable to parse dates from label: "${label}"`);

  endDate.setUTCHours(23, 59, 59, 999);
  return { label, start: startDate.toISOString(), end: endDate.toISOString() };
}

function buildPredicate({ label, type, field, predicate }) {
  switch (type) {
    case "day-of-week": {
      const days = label.split(",").map((d) => capitalize(d.trim()));
      return [
        days.length > 1 ? "in" : "=",
        field,
        days.length > 1 ? days : days[0],
      ];
    }
    case "time-of-day": {
      return [predicate, field, parseTimeRange(label)];
    }
    case "timestamp": {
      const range = parseExactDateRange(label);
      return [
        "in-range",
        field,
        { start: { timestamp: range.start }, end: { timestamp: range.end } },
      ];
    }
    case "exact-match": {
      if (!label) return null;
      return [predicate, field, label];
    }
    default:
      return null;
  }
}

//8.3 Build payload from UI Selections
async function buildTargetingPayload(nodeTypeSelections) {
  const payload = [];
  const nodeTypes = await loadNodeTypes();

  for (const [column, selection] of Object.entries(nodeTypeSelections)) {
    const { value, nodeType, trigger } = selection;
    if (!nodeType || !trigger) continue;

    const nodeConfig = nodeTypes.find((n) => n.name === nodeType);
    if (!nodeConfig) continue;

    const triggerConfig = nodeConfig.triggers.find((t) => t.name === trigger);
    if (!triggerConfig) continue;

    const { field, type, predicate } = triggerConfig;

    const labels = (value || [])
      .map((label) => {
        const pred = buildPredicate({ label, type, field, predicate });
        return pred ? { label, predicate: pred } : null;
      })
      .filter(Boolean);

    payload.push({
      "targeting-column": column,
      mapping: "mapped",
      "node-type": nodeType,
      labels,
    });
  }

  return payload;
}

// 8.4 UI (missing OpenTargetingPopup and createAutoComplete)
async function openTargetingPopup(targeting) {
  // Ensure node types are loaded (fills nodeTypesCache)
  const nodeTypes = await loadNodeTypes();

  return new Promise((resolve, reject) => {
    // ---- BACKDROP ----
    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";

    // ---- DRAWER ----
    const drawer = document.createElement("div");
    drawer.className = "drawer";
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");

    backdrop.onclick = (e) => {
      if (!drawer.contains(e.target)) close("cancel");
    };

    // ---- HEADER ----
    const header = document.createElement("div");
    header.className = "header";

    const title = document.createElement("h2");
    title.className = "title";
    title.textContent = "Auto-map";

    const closeBtn = document.createElement("button");
    closeBtn.className = "close-btn";
    closeBtn.type = "button";
    closeBtn.innerHTML = "✕";
    closeBtn.onclick = () => close("cancel");

    header.append(title, closeBtn);

    // ---- CONTENT ----
    const content = document.createElement("div");
    content.className = "content";
    content.style.cssText = "flex: 1; overflow-y: auto; padding: 16px;";

    const list = document.createElement("ul");
    list.className = "input-root";

    // ---- FOOTER ----
    const footer = document.createElement("div");
    footer.className = "footer";
    footer.appendChild(document.createElement("hr"));

    const nextBtn = document.createElement("button");
    nextBtn.className = "next-btn";
    nextBtn.type = "button";
    nextBtn.textContent = "Next";
    nextBtn.disabled = true;
    nextBtn.style.opacity = "0.5";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "cancel-btn";
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => close("cancel");

    const buttonsDiv = document.createElement("div");
    buttonsDiv.className = "buttons";
    buttonsDiv.append(cancelBtn, nextBtn);
    footer.appendChild(buttonsDiv);

    // enable Next if at least one row has both values
    function recomputeNextEnabled() {
      const rows = Array.from(list.querySelectorAll(".list-item"));
      const anyComplete = rows.some((li) => {
        const main = li.querySelector(".input-base input")?.value?.trim();
        const sub = li.querySelector(".second-input-base input")?.value?.trim();
        return !!(main && sub);
      });

      nextBtn.disabled = !anyComplete;
      nextBtn.style.opacity = anyComplete ? "1" : "0.5";
    }

    nextBtn.onclick = () => {
      try {
        const payload = {};
        list.querySelectorAll(".list-item").forEach((li) => {
          const mainInput = li.querySelector(".input-base input");
          const subInput = li.querySelector(".second-input-base input");
          const column = mainInput?.dataset.column || mainInput?.name;
          if (!column) return;

          payload[column] = {
            value: targeting[column],
            nodeType: mainInput?.value || null,
            trigger: subInput?.value || null,
          };
        });

        close("next", payload);
      } catch (err) {
        console.error(err);
      }
    };

    // ---- Create Inputs ----
    Object.keys(targeting).forEach((column) => {
      const li = document.createElement("li");
      li.className = "list-item";

      const label = document.createElement("p");
      label.className = "list-label";
      label.textContent = column;

      const autocompleteInput = createAutocompleteInput(
        column,
        nodeTypes,
        recomputeNextEnabled,
      );
      li.append(label, autocompleteInput);
      list.appendChild(li);
    });

    content.appendChild(list);
    drawer.append(header, content, footer);
    document.body.append(backdrop, drawer);

    // ---- LOCK BODY SCROLL ----
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // ---- ANIMATE IN ----
    requestAnimationFrame(() => {
      backdrop.style.opacity = "1";
      drawer.style.transform = "translateX(0)";
    });

    // ---- ESC CLOSE ----
    const escHandler = (e) => {
      if (e.key === "Escape") close("cancel");
    };
    document.addEventListener("keydown", escHandler);

    // initial
    recomputeNextEnabled();

    // ---- CLOSE HANDLER ----
    function close(action, payload) {
      drawer.style.transform = "translateX(100%)";
      backdrop.style.opacity = "0";

      setTimeout(() => {
        try {
          backdrop.remove();
          drawer.remove();
          document.body.style.overflow = prevOverflow;
          document.removeEventListener("keydown", escHandler);

          if (action === "next") resolve(payload);
          else reject("cancelled");
        } catch (err) {
          console.error(err);
          if (action === "next") resolve(payload);
          else reject("cancelled");
        }
      }, 225);
    }
  });
}
function createAutocompleteInput(column, nodeTypes, onAnyChange) {
  const root = document.createElement("div");
  root.className = "input-root";
  root.style.position = "relative";

  let secondInputContainer = null;

  function notify() {
    try {
      onAnyChange?.();
    } catch {}
  }

  function createSingleInput({ options, isSecondInput = false }) {
    const formControl = document.createElement("div");
    formControl.className =
      "MuiFormControl-root MuiFormControl-fullWidth MuiTextField-root";

    const inputBase = document.createElement("div");
    inputBase.className = isSecondInput
      ? "input-base second-input-base"
      : "input-base";

    // start adornment
    const startAdornment = document.createElement("div");
    startAdornment.className =
      "MuiInputAdornment-root MuiInputAdornment-positionStart MuiInputAdornment-outlined MuiInputAdornment-sizeSmall";

    const inputIcon = document.createElement("span");
    inputIcon.className = "material-icons input-icon";
    inputIcon.style.display = "none";
    startAdornment.appendChild(inputIcon);

    // input
    const input = document.createElement("input");
    input.type = "text";
    input.className = "input";
    input.dataset.column = column;
    if (isSecondInput) input.placeholder = "Select trigger";

    // end adornment
    const endAdornment = document.createElement("div");
    endAdornment.className = "MuiAutocomplete-endAdornment icon-wrap";
    endAdornment.style.display = "flex";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "clear-btn";
    clearBtn.textContent = "×";
    clearBtn.style.visibility = "hidden";

    const popupBtn = document.createElement("button");
    popupBtn.type = "button";
    popupBtn.className = "open-btn";
    popupBtn.innerHTML = "▾";

    endAdornment.append(clearBtn, popupBtn);

    // outline
    const notchedOutline = document.createElement("fieldset");
    notchedOutline.className = "input-outline";

    inputBase.append(startAdornment, input, endAdornment, notchedOutline);
    formControl.appendChild(inputBase);
    root.appendChild(formControl);

    // dropdown
    const dropdown = document.createElement("div");
    dropdown.className = "MuiAutocomplete-paper";
    dropdown.style.cssText = `
    position: absolute;
    background: #fff;
    border: 1px solid rgba(0,0,0,0.12);
    box-shadow: 0px 4px 12px rgba(0,0,0,0.08);
    margin-top: 4px;
    display: none;
    z-index: 1000;
  `;
    root.appendChild(dropdown);

    function closeDropdown() {
      dropdown.style.display = "none";
    }

    function updateDropdown(filter = "") {
      dropdown.innerHTML = "";

      options.forEach((opt) => {
        const optName = opt.name ?? opt;
        if (filter && !optName.toLowerCase().includes(filter.toLowerCase()))
          return;

        const item = document.createElement("div");
        item.className = "MuiAutocomplete-option dropdown-option";
        item.style.cssText =
          "padding: 4px 12px; cursor: pointer; display: flex; align-items: center;";

        if (!isSecondInput && opt.icon) {
          const iconEl = document.createElement("span");
          iconEl.className = "material-icons input-icon";
          iconEl.textContent = opt.icon;
          iconEl.style.marginRight = "8px";
          item.appendChild(iconEl);
        }

        const textEl = document.createElement("span");
        textEl.textContent = optName;
        item.appendChild(textEl);

        item.onmouseenter = () =>
          (item.style.backgroundColor = "rgba(0,0,0,0.04)");
        item.onmouseleave = () => (item.style.backgroundColor = "transparent)");

        item.onclick = () => {
          input.value = optName;
          clearBtn.style.visibility = "visible";
          closeDropdown();
          input.focus();

          if (!isSecondInput && opt.icon) {
            inputIcon.textContent = opt.icon;
            inputIcon.style.display = "flex";
          }

          // create second input for triggers
          if (!isSecondInput && opt.triggers) {
            if (secondInputContainer) secondInputContainer.remove();

            secondInputContainer = createSingleInput({
              options: opt.triggers,
              isSecondInput: true,
            });

            root.appendChild(secondInputContainer);

            const subInputEl = secondInputContainer.querySelector("input");
            subInputEl?.addEventListener("input", notify);
          }

          notify();
        };

        dropdown.appendChild(item);
      });

      dropdown.style.width = inputBase.getBoundingClientRect().width + "px";
      dropdown.style.display = dropdown.children.length ? "block" : "none";
    }

    // events
    input.addEventListener("focus", () => updateDropdown(input.value));
    input.addEventListener("input", () => {
      clearBtn.style.visibility = input.value ? "visible" : "hidden";
      updateDropdown(input.value);

      // remove second input if main cleared
      if (!isSecondInput && secondInputContainer && !input.value) {
        secondInputContainer.remove();
        secondInputContainer = null;
      }

      notify();
    });

    popupBtn.onclick = (e) => {
      e.stopPropagation();
      dropdown.style.display === "block"
        ? closeDropdown()
        : updateDropdown(input.value);
      input.focus();
    };

    clearBtn.onclick = () => {
      input.value = "";
      clearBtn.style.visibility = "hidden";
      inputIcon.style.display = "none";
      closeDropdown();

      if (!isSecondInput && secondInputContainer) {
        secondInputContainer.remove();
        secondInputContainer = null;
      }

      notify();
    };

    document.addEventListener("click", (e) => {
      if (!root.contains(e.target)) closeDropdown();
    });

    return formControl;
  }

  // Initialize main input with node types loaded by openTargetingPopup()
  createSingleInput({ options: nodeTypes || [] });
  return root;
}
// 8.5 main Auto-map
async function autoMap() {
  // ensure adsetData is present (needed for updateTargetingConfig)
  if (!adsetData && location.href.includes("/adset/")) {
    try {
      await fetchAdsetData();
    } catch {}
  }

  let allAdVariants;
  try {
    allAdVariants = await fetchAdVariants();
  } catch (err) {
    console.warn("[auto-map] fetchAdVariants failed:", err);
    return;
  }

  const targetingValues = extractTargetingValues(allAdVariants);
  if (!targetingValues || Object.keys(targetingValues).length === 0) return;

  try {
    const nodeTypeSelections = await openTargetingPopup(targetingValues);
    const payload = await buildTargetingPayload(nodeTypeSelections);
    await updateTargetingConfig(payload);
  } catch (err) {
    console.warn("[auto-map] cancelled/failed:", err);
  }
}

// =========================
// 9) UI Injection (buttons + iframe buttons)
// =========================

// 9.1 Helpers
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function findButtonByTextIncludes(text, root = document) {
  return $$("button", root).find((b) => b.textContent?.includes(text));
}

function findSpanByExactText(sel, exactText) {
  return $$(sel).find((el) => el.textContent?.trim() === exactText);
}

function ensureButton(opts) {
  const {
    id,
    parent,
    className,
    onClick,
    tag = "button",
    html = opts.html ?? opts.text ?? "",
    afterEl = opts.afterEl ?? opts.afterElement ?? null,
  } = opts;

  let el = document.getElementById(id);
  if (el) return el;

  el = document.createElement(tag);
  el.id = id;
  if (tag === "button") el.type = "button";
  el.className = className || "";
  el.innerHTML = html;
  if (onClick) el.addEventListener("click", onClick);

  // optional: MUI ripple placeholder
  const ripple = document.createElement("span");
  ripple.className = "MuiTouchRipple-root";
  el.appendChild(ripple);

  if (afterEl?.insertAdjacentElement)
    afterEl.insertAdjacentElement("afterend", el);
  else parent?.insertBefore(el, parent.firstChild);

  return el;
}

// 9.2 Button updates
const screenshotUI = {
  wired: false,
  btn: null,
  treeRoot: null,
  observer: null,
  onChange: null,
  seq: 0,
  schedule: null,
};

function debounce(func, wait, maxWait) {
  let timeout;
  let lastCallTime;
  let lastInvokeTime;

  return function (...args) {
    const now = Date.now();

    if (!lastCallTime) {
      lastCallTime = now;
    }

    const timeSinceLastInvoke = now - lastInvokeTime;

    const later = () => {
      timeout = null;
      lastInvokeTime = Date.now();
      func.apply(this, args);
      lastCallTime = null;
    };

    clearTimeout(timeout);

    timeout = setTimeout(later, wait);

    // Force execution if maxWait exceeded
    if (!lastInvokeTime || timeSinceLastInvoke >= maxWait) {
      later();
    }

    lastCallTime = now;
  };
}

function teardownScreenshotCountUpdater() {
  if (screenshotUI.treeRoot && screenshotUI.onChange) {
    screenshotUI.treeRoot.removeEventListener("change", screenshotUI.onChange);
  }
  screenshotUI.observer?.disconnect();

  screenshotUI.wired = false;
  screenshotUI.btn = null;
  screenshotUI.treeRoot = null;
  screenshotUI.observer = null;
  screenshotUI.onChange = null;
  screenshotUI.seq = 0;
  screenshotUI.schedule = null;
}

async function updateScreenshotBtnCount() {
  const btn = screenshotUI.btn;
  if (!btn) return;

  const seq = ++screenshotUI.seq;
  const previewVariants = await extractVariantsFromPreview(); // from Section 5
  const total = previewVariants.reduce(
    (sum, v) => sum + (v.sizes?.length || 0),
    0,
  );
  if (seq !== screenshotUI.seq) return;

  btn.innerHTML = `<span class="material-icons camera-icon">camera_alt</span> ${total}`;
  btn.disabled = total === 0;
}

function wireScreenshotCountUpdater(btn) {
  screenshotUI.btn = btn;
  if (screenshotUI.wired) return;

  screenshotUI.wired = true;
  screenshotUI.schedule = debounce(updateScreenshotBtnCount, 200);
  screenshotUI.treeRoot =
    document.querySelector(SEL.variantTreeRoot) || document.body;

  screenshotUI.onChange = (e) => {
    if (e.target?.matches?.('input[type="checkbox"]')) screenshotUI.schedule();
  };
  screenshotUI.treeRoot.addEventListener("change", screenshotUI.onChange);

  screenshotUI.observer = new MutationObserver(() => screenshotUI.schedule());
  screenshotUI.observer.observe(screenshotUI.treeRoot, {
    subtree: true,
    childList: true,
    attributes: true,
  });

  screenshotUI.schedule();
}

function removeScreenshotButton() {
  document.getElementById("screenshot-btn")?.remove();
  teardownScreenshotCountUpdater();
}

// 9.3 - inject buttons
async function injectButtons() {
  const url = location.href;
  const params = new URLSearchParams(location.search);

  const {
    screenshotsEnabled,
    videosEnabled,
    assetsZipEnabled,
    assetsCsvEnabled,
    autoMapEnabled,
  } = await storageGet({
    screenshotsEnabled: STORAGE_DEFAULTS.screenshotsEnabled,
    videosEnabled: STORAGE_DEFAULTS.videosEnabled,
    assetsZipEnabled: STORAGE_DEFAULTS.assetsZipEnabled,
    assetsCsvEnabled: STORAGE_DEFAULTS.assetsCsvEnabled,
    autoMapEnabled: STORAGE_DEFAULTS.autoMapEnabled,
  });
  // ---------- Screenshot button (preview) ----------
  const isPreview = params.get("ad-variants-preview") === "true";
  const shareButton = findButtonByTextIncludes(SEL.shareButtonText);

  if (shareButton && isPreview) {
    if (!screenshotsEnabled) {
      removeScreenshotButton();
    } else {
      const btn = ensureButton({
        id: "screenshot-btn",
        parent: shareButton.parentNode,
        afterElement: shareButton.previousSibling,
        className: "next-btn",
        text: `<span class="material-icons camera-icon">camera_alt</span>`,
        onClick: screenshotAll, // Section 5
      });
      wireScreenshotCountUpdater(btn);
    }
  }

  // ---------- Assets buttons (ZIP + CSV) ----------
  const uploadButton = document.querySelector(SEL.uploadButton);
  if (uploadButton && RE.assetsPage.test(url)) {
    if (assetsZipEnabled) {
      ensureButton({
        id: "download-zip-btn",
        parent: uploadButton.parentNode,
        afterElement: uploadButton.previousSibling,
        className:
          "MuiButtonBase-root MuiButton-root MuiButton-contained MuiButton-containedPrimary MuiButton-sizeMedium MuiButton-containedSizeMedium MuiButton-colorPrimary css-1u0y93f",
        text: `<span class="material-icons notranslate MuiIcon-root MuiIcon-colorDefault MuiIcon-fontSizeMedium css-cveorv" aria-hidden="true">cloud_download</span>Download All`,
        onClick: downloadAllAssetsZip, // Section 7
      });
    } else {
      document.getElementById("download-zip-btn")?.remove();
    }
    if (assetsCsvEnabled) {
      ensureButton({
        id: "export-csv-btn",
        parent: uploadButton.parentNode,
        afterElement: uploadButton.previousSibling,
        className:
          "MuiButtonBase-root MuiButton-root MuiButton-outlined MuiButton-outlinedPrimary MuiButton-sizeMedium MuiButton-outlinedSizeMedium MuiButton-colorPrimary css-1u0y93f",
        text: `<span class="material-icons notranslate MuiIcon-root MuiIcon-colorDefault MuiIcon-fontSizeMedium css-cveorv" aria-hidden="true">article</span>Export CSV`,
        onClick: exportUrlsToCsv, // Section 7
      });
    } else {
      document.getElementById("export-csv-btn")?.remove();
    }
  }

  // ---------- Video download button (ad-variants page + channel=video + enabled) ----------
  const stack = document
    .querySelector('input[placeholder="Search in identifier..."]')
    ?.closest(".MuiStack-root");
  const adVariantsButton = stack
    ? findButtonByTextIncludes("Manage ad variants", stack)
    : null;

  if (!videosEnabled) {
    document.getElementById("download-videos-btn")?.remove();
  } else if (adVariantsButton && RE.adVariantsPage.test(url)) {
    if (!adsetData && url.includes("/adset/")) {
      try {
        await fetchAdsetData();
      } catch {}
    }

    if (adsetData?.channel === "video") {
      ensureButton({
        id: "download-videos-btn",
        parent: adVariantsButton.parentNode,
        afterElement: adVariantsButton,
        className:
          "MuiButtonBase-root MuiButton-root MuiButton-outlined MuiButton-outlinedPrimary MuiButton-sizeMedium MuiButton-outlinedSizeMedium MuiButton-colorPrimary css-x5x149",
        text: `<span class="material-icons notranslate MuiIcon-root MuiIcon-colorDefault MuiIcon-fontSizeMedium css-cveorv" aria-hidden="true">cloud_download</span>Download Videos`,
        onClick: downloadVideos, // Section 6
      });
    } else {
      document.getElementById("download-videos-btn")?.remove();
    }
  }

  // ---------- Auto-map menu item ----------
  const genTreeSpan = findSpanByExactText(
    "span.MuiMenuItem-header",
    "Generate Tree",
  );
  const generateTreeLi = genTreeSpan?.closest("li") || null;

  if (!autoMapEnabled) {
    document.getElementById("auto-map-btn")?.remove();
  } else if (generateTreeLi && RE.adVariantsPage.test(url)) {
    ensureButton({
      id: "auto-map-btn",
      parent: generateTreeLi.parentNode,
      afterElement: generateTreeLi,
      tag: "li",
      className: "auto-map-btn",
      text: `<div class="MuiAvatar-root auto-map-icon">
            <span class="material-icons notranslate" aria-hidden="true">map</span>
          </div>
          <div class="MuiStack-root css-1q9ee12">
            <span class="MuiMenuItem-header">Auto-map</span>
            <span>Automatically map targeting columns with values from feed.</span>
          </div>`,
      onClick: () => {
        document.querySelector(".MuiBackdrop-root")?.click();
        autoMap(); // Section 8
      },
    });
  }
}

// 9.4 inject iframe buttons
async function injectIframeButtons() {
  const { screenshotsEnabled, individualReloadEnabled } = await storageGet({
    screenshotsEnabled: STORAGE_DEFAULTS.screenshotsEnabled,
    individualReloadEnabled: STORAGE_DEFAULTS.individualReloadEnabled,
  });

  const containers = document.querySelectorAll(
    "div.MuiStack-root.MuiPaper-root.MuiPaper-elevation1",
  );

  containers.forEach((container) => {
    const iframe = container.querySelector("iframe");
    const readyChip = container.querySelector(".MuiChip-root.MuiChip-subtle");
    if (!iframe || !readyChip) return;

    const existingReloadBtn = container.querySelector(".iframe-reload-btn");
    const existingShotBtn = container.querySelector(".iframe-screenshot-btn");

    // --- Reload button toggle ---
    if (!individualReloadEnabled) {
      // 🔴 Remove reload button if present
      if (existingReloadBtn) existingReloadBtn.remove();
    } else if (!existingReloadBtn) {
      // 🟢 Add reload button if enabled
      const reloadBtn = document.createElement("button");
      reloadBtn.className =
        "MuiButtonBase-root MuiIconButton-root MuiIconButton-colorGrey MuiIconButton-sizeMedium css-hmbvib iframe-reload-btn";
      reloadBtn.type = "button";
      reloadBtn.tabIndex = 0;
      reloadBtn.innerHTML = `<span class="material-icons">refresh</span><span class="MuiTouchRipple-root css-4mb1j7"></span>`;
      reloadBtn.addEventListener("click", () => (iframe.src = iframe.src));
      readyChip.insertAdjacentElement("afterend", reloadBtn);
    }

    // --- Screenshot button toggle ---
    if (!screenshotsEnabled) {
      // 🔴 Remove screenshot button if present
      if (existingShotBtn) existingShotBtn.remove();
      return; // skip adding new one
    }

    if (!existingShotBtn) {
      // 🟢 Create screenshot button if enabled
      const shotBtn = document.createElement("button");
      shotBtn.className =
        "MuiButtonBase-root MuiIconButton-root MuiIconButton-colorGrey MuiIconButton-sizeMedium css-hmbvib iframe-screenshot-btn";
      shotBtn.type = "button";
      shotBtn.tabIndex = 0;
      shotBtn.style.marginLeft = "4px";
      shotBtn.innerHTML = `<span class="material-icons">camera_alt</span><span class="MuiTouchRipple-root css-4mb1j7"></span>`;

      shotBtn.addEventListener("click", async () => {
        try {
          const ctx = getIframeContext(container);
          if (!ctx) {
            reportScreenshotError("Could not extract iframe context.", {
              where: "iframe-screenshot-btn",
            });
            return;
          }

          let variants;
          try {
            variants = await fetchAdVariants();
          } catch (err) {
            reportScreenshotError(err?.message || String(err), {
              phase: "fetchAdVariants",
              stack: err?.stack,
            });
            return;
          }

          const match =
            variants.find(
              (v) => v?.data?.["content-id"]?.trim() === ctx.contentId,
            ) || null;
          const result = await takeScreenshot(match, ctx);
          if (!result?.blob) return;

          const url = URL.createObjectURL(result.blob);
          const ext = result.blob.type.split("/")[1] || "png";

          const a = document.createElement("a");
          a.href = url;
          a.download = `${result.safeVariantName}_${result.sizeString}.${ext}`;
          document.body.appendChild(a);
          a.click();
          a.remove();

          setTimeout(() => URL.revokeObjectURL(url), 250);
        } catch (err) {
          reportScreenshotError(err?.message || String(err), {
            phase: "iframeSingleScreenshot",
            stack: err?.stack,
          });
        }
      });

      // Insert screenshot button after the reload button (if present) or readyChip
      (
        container.querySelector(".iframe-reload-btn") || readyChip
      ).insertAdjacentElement("afterend", shotBtn);
    }
  });
}
// =========================
// 10) Bootstrapping (observers + init)
// =========================

const scheduleInject = debounce(
  async () => {
    try {
      await injectIframeButtons();
      await injectButtons();
    } catch (err) {
      const msg = err?.message || String(err);

      if (msg.includes("Extension context invalidated")) {
        // This happens after extension reload/update; page needs refresh
        console.warn(
          "[inject] extension reloaded; refresh the page to reattach content script",
        );
        return;
      }

      console.warn("[inject] failed:", err);
    }
  },
  500,
  2000,
);

// DOM changes (SPA + MUI rerenders)
const observer = new MutationObserver(() => scheduleInject());
observer.observe(document.body, { childList: true, subtree: true });

// Settings changes from side panel
onStorageChanged(
  [
    "screenshotsEnabled",
    "videosEnabled",
    "assetsZipEnabled",
    "assetsCsvEnabled",
    "autoMapEnabled",
  ],
  () => {
    scheduleInject();
  },
);
// Initial run
scheduleInject();

// Fetch adset data once (needed to decide if channel === "video")
window.addEventListener("load", async () => {
  if (location.href.includes("/adset/")) {
    try {
      await fetchAdsetData();
      // After we know channel, re-inject buttons (e.g., Download Videos)
      scheduleInject();
    } catch (err) {
      console.warn("[adset] fetchAdsetData failed:", err);
    }
  }
});
