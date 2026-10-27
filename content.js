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
 * 8) Shared drawer popup
 * 9) Tools: Add external preview
 * 10) UI Injection (buttons + iframe buttons)
 * 11) Bootstrapping (observers + init)
 */

// =========================
// 1) Globals / constants
// =========================
// Read on every call: the app refreshes the token, so a value cached at load goes stale (401)
function getAccessToken() {
  try {
    return JSON.parse(localStorage.getItem("session") || "{}").token;
  } catch {
    return undefined;
  }
}
let adsetData = null; // filled later by fetchAdsetData()

// Tool options
const STORAGE_DEFAULTS = {
  delay: 500,
  scale: 2,
  imageType: "png", // "png" | "jpeg"
  screenshotFrames: [], // frame numbers to capture; [] = single capture after the delay
  screenshotsEnabled: true,
  recordingsEnabled: true,
  recordingDuration: 15,

  videoQuality: "1080p", // "1080p" | "720p" | "480p" | "270p"
  videosEnabled: true,

  assetsZipEnabled: true,
  assetsCsvEnabled: true,

  individualReloadEnabled: true,
  addTemplateEnabled: true,
  liveAdsetStatusEnabled: true,
};

const API = {
  dispatch: "https://api.lemonpi.io/dispatch",
  contentBuild: "https://api.lemonpi.io/content-build/v1",
  adsets2: "https://api.lemonpi.io/api/v0/adsets-2",
};

const RE = {
  adVariantsPage:
    /^https:\/\/create\.choreograph\.com\/\d+\/advertiser\/\d+\/campaign\/\d+\/adset\/\d+\/ad-variants/,
  assetsPage:
    /^https:\/\/create\.choreograph\.com\/\d+\/advertiser\/\d+\/assets/,
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
  const { delay, scale, imageType, screenshotsEnabled, screenshotFrames } =
    await storageGet({
      delay: STORAGE_DEFAULTS.delay,
      scale: STORAGE_DEFAULTS.scale,
      imageType: STORAGE_DEFAULTS.imageType,
      screenshotsEnabled: STORAGE_DEFAULTS.screenshotsEnabled,
      screenshotFrames: STORAGE_DEFAULTS.screenshotFrames,
    });
  return {
    delay,
    scale,
    imageType,
    screenshotsEnabled,
    screenshotFrames: Array.isArray(screenshotFrames) ? screenshotFrames : [],
  };
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

function showToast(message) {
  document.getElementById("co-plus-toast")?.remove();
  const toast = document.createElement("div");
  toast.id = "co-plus-toast";
  toast.textContent = message;
  Object.assign(toast.style, {
    position: "fixed",
    bottom: "24px",
    left: "50%",
    transform: "translateX(-50%)",
    maxWidth: "70vw",
    padding: "10px 16px",
    background: "#b3261e",
    color: "#fff",
    borderRadius: "8px",
    font: "14px sans-serif",
    zIndex: "2147483647",
    boxShadow: "0 2px 8px rgba(0,0,0,.3)",
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 8000);
}

function reportScreenshotError(message, details = {}) {
  console.error("[screenshots]", message, details);
  showToast(`Screenshot failed: ${message}`);
  try {
    chrome.runtime.sendMessage({ action: "screenshotError", message, details });
  } catch (err) {
    console.warn("[screenshots] could not notify the extension", err);
  }
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

const liveAdsetChecks = new Map();

function removeLiveAdsetStatus() {
  document.getElementById("co-plus-live-adsets")?.remove();
  document.querySelectorAll(".co-plus-delivery-replaced").forEach((cell) => {
    cell.classList.remove("co-plus-delivery-replaced");
  });
  document.querySelectorAll(".co-plus-live-adset-status").forEach((badge) => {
    badge.parentElement?.classList.remove("co-plus-delivery-cell");
    badge.remove();
  });
}

function stopLiveAdsetChecks() {
  removeLiveAdsetStatus();
  for (const check of liveAdsetChecks.values()) check.controller.abort();
  liveAdsetChecks.clear();
}

function getLiveAdsetContext() {
  const match = location.pathname.match(
    /^\/(\d+)\/advertiser\/(\d+)\/campaign\/(\d+)(?:\/adset\/(\d+))?(?:\/|$)/,
  );
  if (!match) return null;
  const [, agencyId, advertiserId, campaignId, adsetId] = match;
  return { agencyId, advertiserId, campaignId, adsetId };
}

function getLiveAdsetDates(now = new Date()) {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const start = new Date(end.getTime() - 86400000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

async function fetchLiveAdsets(context, dates, signal) {
  let candidates;
  if (context.adsetId) {
    const response = await apiFetch(`${API.adsets2}/${context.adsetId}`, {
      signal,
    });
    candidates = [await response.json()];
  } else {
    const url = new URL(API.adsets2);
    url.searchParams.set(
      "filters",
      JSON.stringify({ campaignId: Number(context.campaignId) }),
    );
    url.searchParams.set("embed", JSON.stringify(["template_revisions"]));
    const response = await apiFetch(url.toString(), { signal });
    candidates = await response.json();
    if (!Array.isArray(candidates))
      throw new Error("Unexpected campaign adset response");
  }
  const adsets = candidates.filter((adset) => adset.archived === false);
  const results = new Array(adsets.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < adsets.length && !signal?.aborted) {
      const index = nextIndex++;
      const adset = adsets[index];
      try {
        const url = new URL(
          `https://api.lemonpi.io/analytics/v1/adset-insights/${adset.id}/stats`,
        );
        url.searchParams.set("start_date", dates.startDate);
        url.searchParams.set("end_date", dates.endDate);
        const response = await apiFetch(url.toString(), { signal });
        const data = await response.json();
        const impressions = data.impressions;
        if (!Number.isSafeInteger(impressions) || impressions < 0) {
          throw new Error("Impression total unavailable");
        }
        results[index] = {
          id: adset.id,
          name: adset.name,
          impressions,
          status: impressions > 1000 ? "Live" : "Not live",
        };
      } catch (error) {
        results[index] = {
          id: adset.id,
          name: adset.name,
          impressions: null,
          status: "Unknown",
          error: error.message,
        };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(3, adsets.length) }, () => worker()),
  );
  return results;
}

function renderLiveAdsetStatus(context, dates, check) {
  const targets = context.adsetId
    ? [document.querySelector("h1")].filter(Boolean).map((heading) => ({
        parent: heading.parentElement,
        heading,
        id: context.adsetId,
      }))
    : Array.from(document.querySelectorAll('[role="row"][data-id]'))
        .map((row) => ({
          parent: row.querySelector('[role="gridcell"][data-field="status"]'),
          id: row.getAttribute("data-id"),
        }))
        .filter((target) => target.parent);
  for (const { parent, heading, id } of targets) {
    const result = check.results?.get(String(id));
    let badge = parent.querySelector(".co-plus-live-adset-status");
    if (check.results && !result) {
      badge?.remove();
      parent.classList.remove("co-plus-delivery-cell");
      parent.classList.remove("co-plus-delivery-replaced");
      continue;
    }
    if (!context.adsetId)
      parent.classList.toggle(
        "co-plus-delivery-replaced",
        Boolean(check.showDelivery),
      );
    if (!check.showDelivery) {
      badge?.remove();
      badge = null;
    } else if (!badge) {
      badge = document.createElement("span");
      badge.className = "co-plus-live-adset-status";
      if (heading) {
        badge.classList.add("co-plus-delivery-title");
        heading.after(badge);
      } else parent.appendChild(badge);
      if (!context.adsetId) parent.classList.add("co-plus-delivery-cell");
    }
    const status = result?.status || (check.error ? "Unknown" : "Checking...");
    const day = `${dates.startDate} (UTC)`;
    const tooltip =
      result?.error || check.error
        ? `Delivery unknown: ${result?.error || check.error}`
        : !result
          ? "Checking impressions..."
          : `${status === "Live" ? "Live: more than 1,000" : "Not live: 1,000 or fewer"} impressions in the last full UTC day.\n${result.impressions.toLocaleString()} impressions on ${day}`;
    if (badge && badge.textContent !== status) badge.textContent = status;
    if (badge && badge.dataset.tooltip !== tooltip) {
      badge.dataset.tooltip = tooltip;
      badge.setAttribute("aria-label", `${status}. ${tooltip}`);
      badge.tabIndex = 0;
    }
    if (badge && badge.dataset.status !== status) badge.dataset.status = status;
    if (!context.adsetId)
      parent.classList.toggle("co-plus-delivery-cell", Boolean(badge));
  }
}

function wireDeliveryTooltip() {
  let tip = null;
  const hide = () => tip?.remove();
  const show = (event) => {
    const badge = event.target.closest?.(".co-plus-live-adset-status");
    if (!badge?.dataset.tooltip) return;
    tip ||= Object.assign(document.createElement("div"), {
      className: "co-plus-tooltip",
      role: "tooltip",
    });
    tip.textContent = badge.dataset.tooltip;
    document.body.appendChild(tip);
    const rect = badge.getBoundingClientRect();
    const width = tip.offsetWidth;
    tip.style.left = `${Math.max(4, Math.min(innerWidth - width - 4, rect.left + rect.width / 2 - width / 2))}px`;
    tip.style.top = `${rect.bottom + 8}px`;
  };
  document.addEventListener("mouseover", show);
  document.addEventListener("focusin", show);
  document.addEventListener("mouseout", (event) => {
    if (event.target.closest?.(".co-plus-live-adset-status")) hide();
  });
  document.addEventListener("focusout", hide);
  addEventListener("scroll", hide, true);
}
wireDeliveryTooltip();

async function injectLiveAdsetStatus() {
  const context = getLiveAdsetContext();
  if (!context) {
    removeLiveAdsetStatus();
    return;
  }
  const { liveAdsetStatusEnabled } = await storageGet({
    liveAdsetStatusEnabled: STORAGE_DEFAULTS.liveAdsetStatusEnabled,
  });
  if (!liveAdsetStatusEnabled) {
    stopLiveAdsetChecks();
    return;
  }
  const current = getLiveAdsetContext();
  if (
    current?.advertiserId !== context.advertiserId ||
    current?.campaignId !== context.campaignId ||
    current?.adsetId !== context.adsetId
  )
    return;
  document.getElementById("co-plus-live-adsets")?.remove();
  const dates = getLiveAdsetDates();
  const key = `${context.advertiserId}:${context.campaignId}:${context.adsetId || "all"}:${dates.startDate}`;
  let check = liveAdsetChecks.get(key);
  if (!check || Date.now() - check.createdAt > 300000) {
    check?.controller.abort();
    const controller = new AbortController();
    check = { createdAt: Date.now(), controller, results: null, error: null };
    check.promise = fetchLiveAdsets(context, dates, controller.signal).then(
      (results) => {
        check.results = new Map(
          results.filter(Boolean).map((result) => [String(result.id), result]),
        );
      },
      (error) => {
        check.error = error.message;
      },
    );
    liveAdsetChecks.set(key, check);
    if (liveAdsetChecks.size > 20) {
      const oldest = liveAdsetChecks.keys().next().value;
      liveAdsetChecks.get(oldest).controller.abort();
      liveAdsetChecks.delete(oldest);
    }
  }
  check.showDelivery = liveAdsetStatusEnabled;
  renderLiveAdsetStatus(context, dates, check);
  if (!check.results && !check.error) await check.promise;
  const latest = getLiveAdsetContext();
  if (
    liveAdsetChecks.get(key) !== check ||
    latest?.advertiserId !== context.advertiserId ||
    latest?.campaignId !== context.campaignId ||
    latest?.adsetId !== context.adsetId
  )
    return;
  renderLiveAdsetStatus(context, dates, check);
}

function isTokenExpired(token, skewSeconds = 30) {
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return typeof payload.exp === "number"
      ? payload.exp * 1000 - skewSeconds * 1000 < Date.now()
      : false;
  } catch {
    return false; // not a decodable JWT: let the server decide
  }
}

// The most reliable token is the one the app itself last sent from this tab (recorded by page-auth.js).
// localStorage is shared by every Choreograph window, so its session can belong to another advertiser
// (403) or have been refreshed since this page loaded (401): those are only fallbacks.
let lastGoodAuth = null;

function getAuthCandidates() {
  const fromPage = document.documentElement.getAttribute("data-co-plus-auth");
  const stored = getAccessToken();
  return [
    ...new Set(
      [fromPage, lastGoodAuth, stored && `lemonpi ${stored}`].filter(Boolean),
    ),
  ];
}

async function apiFetch(
  url,
  { method = "GET", headers = {}, body, signal } = {},
) {
  const candidates = getAuthCandidates();
  if (!candidates.length) throw new Error("Access token not available");

  let res;
  let usedAuth;
  for (const auth of candidates) {
    usedAuth = auth;
    res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...headers,
        Authorization: auth,
      },
      body,
      signal,
    });
    if (res.status !== 401 && res.status !== 403) break;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 && isTokenExpired(usedAuth.split(/\s+/).pop(), 0)) {
      throw new Error(
        "Your Choreograph session has expired. Reload the page (or log in again) and retry.",
      );
    }
    if (res.status === 403 && text.includes("no-permission-for-advertiser")) {
      throw new Error(
        "This tab's session no longer matches its advertiser (another Choreograph window changed the login). Reload this page and retry.",
      );
    }
    throw new Error(
      `HTTP ${res.status} ${res.statusText} - ${text.slice(0, 300)}`,
    );
  }

  lastGoodAuth = usedAuth;
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

    // auto open lis
    /*if (parentLi.getAttribute("aria-expanded") === "false") {
      node.click();
      await new Promise((r) => setTimeout(r, 200));
    } */

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

// 5.4 Frame detection (GSAP "frameN-preview" labels, read in a hidden tab)
const frameCache = new Map(); // `${adsetId}:${WxH}` -> number[] (empty = creative has no frame labels)
let frameInfoCache = null; // { adsetId, sizes: { "300x250": [1, 2, 3] } }
let frameInfoInflight = null;

function getRenderData(match, ctx) {
  const variant = (match?.data?.["ad-variants"] || []).find((v) =>
    v["ad-formats"]?.some(
      (f) => f.width === ctx.width && f.height === ctx.height,
    ),
  );
  if (!variant)
    throw new Error(`No matching ad format for ${ctx.width}x${ctx.height}`);

  const renderData =
    variant.components?.["urn:lemonpi:artefact:display:content+template"]
      ?.value;
  if (!renderData) throw new Error("Render data missing");
  return renderData;
}

function collectUrls(value, out = []) {
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value)) out.push(value);
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((v) => collectUrls(v, out));
  }
  return out;
}

const templateFrameCache = new Map(); // template URLs -> { frames, complete } from the static scan

// Fast path: read the frame labels straight from the template's source, no rendering needed
async function scanFramesStatically(renderData) {
  const urls = [...new Set(collectUrls(renderData.template))];
  if (!urls.length) {
    console.info("[frames] no URLs in template data", renderData.template);
    return { frames: [], complete: false };
  }

  const key = urls.join("|");
  if (templateFrameCache.has(key)) return templateFrameCache.get(key);

  const resp = await runtimeSend({
    action: "scanTemplateFrames",
    payload: { urls },
  });
  const result = resp?.success
    ? { frames: resp.frames, complete: !!resp.complete }
    : { frames: [], complete: false };
  if (!result.frames.length)
    console.info("[frames] static scan found nothing", urls, resp);
  templateFrameCache.set(key, result);
  return result;
}

const frameInflight = new Map(); // key -> Promise, so a click joins a detection already running

function getSizeFrames(match, ctx) {
  const adsetId = getIdsFromUrl()?.adsetId;
  const key = `${adsetId}:${ctx.width}x${ctx.height}`;
  if (frameCache.has(key)) return Promise.resolve(frameCache.get(key));
  if (frameInflight.has(key)) return frameInflight.get(key);

  const promise = detectSizeFrames(match, ctx, key).finally(() =>
    frameInflight.delete(key),
  );
  frameInflight.set(key, promise);
  return promise;
}

async function detectSizeFrames(match, ctx, key) {
  const renderData = getRenderData(match, ctx);

  try {
    const { frames, complete } = await scanFramesStatically(renderData);
    // A fully read template with no labels has no frames: no need to render it to find out
    if (frames.length || complete) {
      frameCache.set(key, frames);
      return frames;
    }
  } catch (err) {
    console.warn("[frames] static scan failed, falling back to render", err);
  }

  // Fallback: render the creative in a hidden tab/popup and read its live timeline
  const blobUrl = buildAdBlob(renderData);
  try {
    const resp = await runtimeSend({
      action: "probeFrames",
      payload: { blobUrl },
    });
    if (!resp?.success)
      throw new Error(resp?.error || "Frame detection failed");
    if (!resp.frames.length)
      console.warn("[frames] none found for", key, resp.debug);
    frameCache.set(key, resp.frames);
    return resp.frames;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

// Frames to capture for this size: [] means no labels / nothing selected -> plain delayed capture
async function resolveFrames(match, ctx, selected) {
  if (!selected.length) return { legacy: true, frames: [] };
  const available = await getSizeFrames(match, ctx);
  if (!available.length) return { legacy: true, frames: [] };
  return {
    legacy: false,
    frames: selected.filter((f) => available.includes(f)),
    available,
  };
}

// Detects frames for every size in the adset (frames are the same across variants, not across sizes)
function detectAllFrames({ force = false } = {}) {
  const ids = getIdsFromUrl();
  if (!ids) {
    return Promise.reject(new Error("Open an adset's ad-variants page."));
  }
  if (!force && frameInfoCache?.adsetId === ids.adsetId) {
    return Promise.resolve(frameInfoCache);
  }
  if (frameInfoInflight) return frameInfoInflight;

  frameInfoInflight = (async () => {
    if (force) {
      for (const k of [...frameCache.keys()]) {
        if (k.startsWith(`${ids.adsetId}:`)) frameCache.delete(k);
      }
    }

    const variants = await fetchAdVariants();
    const bySize = new Map();
    for (const match of variants) {
      for (const av of match.data?.["ad-variants"] || []) {
        for (const f of av["ad-formats"] || []) {
          const size = `${f.width}x${f.height}`;
          if (!bySize.has(size))
            bySize.set(size, {
              match,
              ctx: { width: f.width, height: f.height },
            });
        }
      }
    }

    const sizes = {};
    const queue = [...bySize];
    const worker = async () => {
      while (queue.length) {
        const [size, { match, ctx }] = queue.shift();
        try {
          sizes[size] = await getSizeFrames(match, ctx);
        } catch (err) {
          console.warn("[frames] detection failed for", size, err);
        }
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker)); // a few sizes at a time

    frameInfoCache = { adsetId: ids.adsetId, sizes };
    return frameInfoCache;
  })().finally(() => {
    frameInfoInflight = null;
  });

  return frameInfoInflight;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action !== "getFrameInfo") return;
  detectAllFrames({ force: !!msg.force })
    .then((info) => sendResponse({ success: true, sizes: info.sizes }))
    .catch((err) =>
      sendResponse({ success: false, error: err?.message || String(err) }),
    );
  return true;
});

// 5.5 Core Capture
// Returns one entry per captured frame: [{ blob, safeVariantName, sizeString, frame }]
async function takeScreenshots(match, ctx) {
  if (!match) throw new Error("No matching ad variant found");

  const renderData = getRenderData(match, ctx);
  const { scale, imageType, screenshotFrames } = await getScreenshotSettings();
  const { legacy, frames } = await resolveFrames(match, ctx, screenshotFrames);
  if (!legacy && frames.length === 0) return []; // none of the selected frames exist at this size

  const mime =
    imageType === "jpeg" || imageType === "jpg" ? "image/jpeg" : "image/png";
  const safeName = sanitizeName(
    match.data?.["content-id"] || "Unnamed Variant",
  );
  const sizeString = `${ctx.width}x${ctx.height}`;
  const blobUrl = buildAdBlob(renderData);

  const toBlob = (url, factor) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = Object.assign(document.createElement("canvas"), {
          width: ctx.width * scale,
          height: ctx.height * scale,
        });
        const ctx2d = canvas.getContext("2d");
        if (!ctx2d) return reject(new Error("No canvas context"));
        ctx2d.imageSmoothingQuality = "high";

        ctx2d.drawImage(
          img,
          0,
          0,
          ctx.width * factor,
          ctx.height * factor, // source crop: the ad as rendered, whatever the display's pixel ratio
          0,
          0,
          ctx.width * scale,
          ctx.height * scale, // destination size
        );

        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error("Failed to create blob")),
          mime,
          1,
        );
      };
      img.onerror = () => reject(new Error("Image decode failed"));
      img.src = url;
    });

  try {
    const { success, shots, error, cancelled } = await runtimeSend({
      action: "captureAdBlob",
      payload: { blobUrl, frames },
    });
    if (!success)
      throw new Error(error || (cancelled ? "Cancelled" : "Capture failed"));

    const results = [];
    for (const shot of shots) {
      results.push({
        blob: await toBlob(shot.dataUrl, shot.factor || scale),
        safeVariantName: safeName,
        sizeString,
        frame: shot.frame,
      });
    }
    return results;
  } finally {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {}
  }
}

function screenshotFileName(shot) {
  const ext = shot.blob.type.split("/")[1] || "png";
  const frame = shot.frame != null ? `_frame${shot.frame}` : "";
  return `${shot.safeVariantName}_${shot.sizeString}${frame}.${ext}`;
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

  const merged = mergeComponents(variants, previewVariants);
  const { screenshotFrames } = await getScreenshotSettings();

  // Shots expected per variant/size: selected frames that exist at that size, else a single capture
  const expected = new Map(); // `${variant}|${size}` -> count
  let total = 0;
  for (const pv of previewVariants) {
    for (const size of pv.sizes || []) {
      let count = 1;
      const component = merged[pv.variant];
      if (component && screenshotFrames.length) {
        try {
          const [width, height] = size.split("x").map(Number);
          const { legacy, frames } = await resolveFrames(
            component,
            { width, height },
            screenshotFrames,
          );
          count = legacy ? 1 : frames.length;
        } catch (err) {
          console.warn(
            "[frames] could not resolve frames",
            pv.variant,
            size,
            err,
          );
        }
      }
      expected.set(`${pv.variant}|${size}`, count);
      total += count;
    }
  }

  if (state.cancelScreenshots) return;

  if (!total) {
    reportScreenshotError(
      "Nothing to screenshot: no sizes selected, or the selected frames don't exist at the selected sizes.",
      { phase: "count", screenshotFrames },
    );
    return;
  }

  // 3) Run
  const zip = new window.JSZip();
  let filesAdded = 0;

  initScreenshotProgress(total);

  for (const pv of previewVariants) {
    if (state.cancelScreenshots) return;

    const component = merged[pv.variant];
    const sizes = pv.sizes || [];

    // if missing component, still increment progress for the sizes so UI doesn't freeze
    if (!component) {
      for (const size of sizes) {
        for (let i = 0; i < expected.get(`${pv.variant}|${size}`); i++)
          incScreenshotProgress();
      }
      continue;
    }

    for (const size of sizes) {
      if (state.cancelScreenshots) return;

      const [width, height] = size.split("x").map(Number);

      try {
        const results = await takeScreenshots(component, {
          width,
          height,
          contentId: pv.variant,
        });

        for (const result of results) {
          zip.file(screenshotFileName(result), result.blob);
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
        if (!state.cancelScreenshots) {
          for (let i = 0; i < expected.get(`${pv.variant}|${size}`); i++)
            incScreenshotProgress();
        }
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

const recordingUrls = new Map();
let preparingRecording = false;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action !== "releaseRecording") return;
  for (const url of recordingUrls.get(message.id) || [])
    URL.revokeObjectURL(url);
  recordingUrls.delete(message.id);
});

async function openAdRecordings(context = null) {
  if (preparingRecording) return;
  preparingRecording = true;
  const urls = [];
  try {
    if (!context) {
      const panel = await runtimeSend({ action: "openRecordingPanel" });
      if (!panel?.success)
        throw new Error(
          panel?.error || "Could not open the recording side panel.",
        );
    }
    const { recordingsEnabled } = await storageGet({
      recordingsEnabled: STORAGE_DEFAULTS.recordingsEnabled,
    });
    if (!recordingsEnabled)
      throw new Error("Recordings are disabled in the side panel.");
    const variants = await fetchAdVariants();
    const selected = context
      ? [
          {
            variant: context.contentId,
            sizes: [`${context.width}x${context.height}`],
          },
        ]
      : await extractVariantsFromPreview();
    if (!selected.length)
      throw new Error("Select at least one ad size to record.");
    const jobs = [];
    for (const item of selected) {
      const match = variants.find(
        (variant) =>
          variant?.data?.["content-id"]?.trim() === item.variant.trim(),
      );
      if (!match)
        throw new Error(
          `No matching variant found for ${item.variant}. Refresh the preview and retry.`,
        );
      for (const size of item.sizes) {
        const [width, height] = size.split("x").map(Number);
        if (
          ![width, height].every(
            (value) => Number.isInteger(value) && value > 0 && value <= 4096,
          )
        )
          throw new Error(`Unsupported recording size: ${size}.`);
        const blobUrl = buildAdBlob(getRenderData(match, { width, height }));
        urls.push(blobUrl);
        jobs.push({ blobUrl, name: item.variant, width, height });
      }
    }
    if (!jobs.length || jobs.length > 500)
      throw new Error("Select between 1 and 500 ads to record.");
    const response = await runtimeSend({
      action: "openRecording",
      jobs,
    });
    if (!response?.success)
      throw new Error(response?.error || "Could not open the recorder.");
    recordingUrls.set(response.id, urls);
  } catch (error) {
    urls.forEach((url) => URL.revokeObjectURL(url));
    showToast(`Recording failed: ${error.message}`);
  } finally {
    preparingRecording = false;
  }
}

// =========================
// 6) Tools: Videos
// =========================

// 6.1 Video component parsing + picking

function parseVastVideoKeys(components = {}) {
  const out = [];
  for (const [key, component] of Object.entries(components)) {
    const url = component?.value;
    const meta = component?.metadata || {};
    const vast = key.match(/vast:video(?::scale:([^:]+))?(?::kbps:(\d+))?/);
    const isVideo =
      vast ||
      /^video\//.test(meta["mime-type"] || "") ||
      /\.mp4(?:[?#]|$)/i.test(typeof url === "string" ? url : "");
    if (!isVideo || typeof url !== "string" || !url) continue;
    out.push({
      key,
      scale: vast?.[1] ?? null,
      kbps: Number(vast?.[2] ?? meta.bitrate ?? 0) || 0,
      height: Number(meta.height) || scaleHeight(vast?.[1]),
    });
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
  const desired = desiredHeightFromQuality(videoQuality);
  const distance = (c) => (c.height ? Math.abs(c.height - desired) : Infinity);
  return (
    parseVastVideoKeys(components).sort(
      (a, b) => distance(a) - distance(b) || b.kbps - a.kbps,
    )[0]?.key ?? null
  );
}
async function collectMediaForMeta(adVariantsData) {
  const mediaFiles = [];

  for (const item of adVariantsData) {
    const contentId = item?.data?.["content-id"];
    const variants = item?.data?.["ad-variants"] || [];

    for (const variant of variants) {
      const components = variant?.components || {};

      // Prefer video if available
      const videoComp = components["urn:meta:single-video"];
      if (videoComp?.value) {
        const meta = videoComp.metadata || {};
        const w = meta.width ?? variant.dimensions?.width;
        const h = meta.height ?? variant.dimensions?.height;
        const fileName = `${contentId}_${w}x${h}.mp4`;

        mediaFiles.push({ url: videoComp.value, fileName });
        continue; // skip image if we got a video
      }

      // Otherwise, use single-image
      const imgComp = components["urn:meta:single-image"];
      if (imgComp?.value) {
        const meta = imgComp.metadata || {};
        const ext = meta["mime-type"] === "image/png" ? "png" : "jpg";
        const w = meta.width ?? variant.dimensions?.width;
        const h = meta.height ?? variant.dimensions?.height;
        const fileName = `${contentId}_${w}x${h}.${ext}`;

        mediaFiles.push({ url: imgComp.value, fileName });
      }
    }
  }
  return mediaFiles;
}

// 6.2 Collect video files for the chosen quality

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
async function downloadVideos(channel) {
  state.cancelVideos = false;

  const { videosEnabled, videoQuality } = await getVideoSettings();
  if (!videosEnabled) return;

  let adVariantsData;
  try {
    adVariantsData = await fetchAdVariants();
  } catch (err) {
    reportVideoError(err?.message || String(err), { phase: "fetchAdVariants" });
    return;
  }

  if (!Array.isArray(adVariantsData) || !adVariantsData.length) {
    reportVideoError("No ad variants found", { phase: "fetchAdVariants" });
    return;
  }

  let mediaFiles;
  if (channel === "meta") {
    // Smart meta media collection
    mediaFiles = await collectMediaForMeta(adVariantsData);
  } else {
    // Normal video collection
    const { videoFiles } = await collectVideoFilesForQuality(
      adVariantsData,
      videoQuality,
    );
    mediaFiles = videoFiles;
  }

  if (!mediaFiles.length) {
    const variants = adVariantsData.flatMap(
      (item) => item?.data?.["ad-variants"] || [],
    );
    const keys = [
      ...new Set(variants.flatMap((v) => Object.keys(v?.components || {}))),
    ];
    reportVideoError(
      `No ${channel === "meta" ? "media" : "videos"} found in ${variants.length} variant(s). Component keys: ${keys.slice(0, 8).join(", ") || "none"}`,
      { phase: "collect", keys },
    );
    return;
  }

  let runId;
  try {
    runId = await initVideoProgress(mediaFiles.length);
  } catch (err) {
    reportVideoError(
      `Failed to init progress: ${err?.message || String(err)}`,
      { phase: "initVideoProgress" },
    );
    return;
  }

  try {
    await zipAndDownloadVideos(mediaFiles, runId); // works for both mp4 and img
    chrome.runtime.sendMessage({ action: "videoFinished", runId });
  } catch (err) {
    reportVideoError(err?.message || String(err), {
      phase: "zipAndDownloadVideos",
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
// 8) Shared drawer popup
// =========================
async function openDrawerPopup({
  title,
  buildContent, // function(formContainer, enableNextCallback)
  onNext, // function(payload)
}) {
  return new Promise((resolve, reject) => {
    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";

    const drawer = document.createElement("div");
    drawer.className = "drawer";
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");

    backdrop.onclick = (e) => {
      if (!drawer.contains(e.target)) close("cancel");
    };

    // HEADER
    const header = document.createElement("div");
    header.className = "header";
    const titleEl = document.createElement("h2");
    titleEl.className = "title";
    titleEl.textContent = title;
    const closeBtn = document.createElement("button");
    closeBtn.className = "close-btn";
    closeBtn.type = "button";
    closeBtn.innerHTML = "✕";
    closeBtn.onclick = () => close("cancel");
    header.append(titleEl, closeBtn);

    // CONTENT
    const content = document.createElement("div");
    content.className = "content";
    content.style.cssText = "flex: 1; overflow-y: auto; padding: 16px;";

    // FOOTER
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

    // Enable Next logic
    function enableNext(enabled) {
      nextBtn.disabled = !enabled;
      nextBtn.style.opacity = enabled ? "1" : "0.5";
    }

    // Build custom inputs
    buildContent(content, enableNext);

    // Next button handler
    nextBtn.onclick = () => {
      try {
        const payload = onNext();
        close("next", payload);
      } catch (err) {
        console.error(err);
        close("cancel");
      }
    };

    drawer.append(header, content, footer);
    document.body.append(backdrop, drawer);

    // Lock body scroll
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Animate in
    requestAnimationFrame(() => {
      backdrop.style.opacity = "1";
      drawer.style.transform = "translateX(0)";
    });

    // ESC close
    const keyHandler = (e) => {
      if (e.key === "Escape") {
        close("cancel");
      } else if (e.key === "Enter") {
        // Only trigger Next if it's enabled
        if (!nextBtn.disabled) {
          try {
            const payload = onNext();
            close("next", payload);
          } catch (err) {
            console.error(err);
            close("cancel");
          }
        }
      }
    };
    document.addEventListener("keydown", keyHandler);
    function close(action, payload) {
      drawer.style.transform = "translateX(100%)";
      backdrop.style.opacity = "0";
      setTimeout(() => {
        backdrop.remove();
        drawer.remove();
        document.body.style.overflow = prevOverflow;
        document.removeEventListener("keydown", keyHandler);
        if (action === "next") resolve(payload);
        else reject("cancelled");
      }, 225);
    }
  });
}
// =========================
// 9) Add External Preview
// =========================
// Store parameters globally
window.externalTemplateParams = null;
window.viewButtonAdded = false; // track if addViewButton is already done
window.viewToggleSetup = false;
window.customViewWasActive = false;

// === Helper: create element quickly ===
function createEl(tag, className, innerHTML) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (innerHTML !== undefined) el.innerHTML = innerHTML;
  return el;
}

// === Popup ===
function openExternalPreviewPopup() {
  return openDrawerPopup({
    title: "Add External Template",
    buildContent: (content, enableNext) => {
      const formFields = [
        { label: "Template URL", name: "templateUrl", type: "text", value: "" },
        { label: "Width", name: "width", type: "number", value: "" },
        { label: "Height", name: "height", type: "number", value: "" },
      ];

      formFields.forEach((field) => {
        const wrap = createEl("div", "form-field");
        const label = createEl("label", "popup-label", field.label);
        const inputBase = createEl("div", "popup-input-base");
        const input = createEl("input", "popup-input");
        input.type = field.type;
        input.name = field.name;
        input.value = field.value;

        // Validate before enabling Next
        input.addEventListener("input", () => {
          const inputs = Array.from(
            content.querySelectorAll(".form-field input"),
          );
          const allFilled = inputs.every((inp) => inp.value.trim() !== "");
          const allValid = inputs.every(
            (inp) => inp.type !== "number" || Number(inp.value) > 0,
          );
          enableNext(allFilled && allValid);
        });

        // Focus styling
        input.addEventListener("focus", () =>
          inputBase.classList.add("focussed"),
        );
        input.addEventListener("blur", () =>
          inputBase.classList.remove("focussed"),
        );

        const fieldset = createEl("fieldset", "popup-input-outline");
        inputBase.append(input, fieldset);
        wrap.append(label, inputBase);
        content.appendChild(wrap);
      });
    },
    onNext: () => {
      const payload = {};
      document.querySelectorAll(".form-field input").forEach((input) => {
        payload[input.name] = input.value.trim();
      });
      return payload;
    },
  }).then((payload) => {
    addExternalTemplate(
      parseInt(payload.width, 10),
      parseInt(payload.height, 10),
      payload.templateUrl,
    );
  });
}

// === External tree injection ===
async function addExternalTemplate(width, height, templateUrl) {
  // store parameters for reuse
  window.externalTemplateParams = { width, height, templateUrl };

  const variants = await fetchAdVariants();
  const existingTree = document.querySelector('ul[role="tree"]')?.parentElement;
  if (existingTree) {
    existingTree.style.display = "none";
  }

  const myTree = buildVariantTree(variants, width, height, templateUrl);
  if (existingTree?.parentElement) {
    existingTree.parentElement.insertBefore(myTree, existingTree);
  }

  // ✅ Auto-click top variant after tree is built
  const firstVariant = myTree.querySelector("#my-variant-tree li");
  if (firstVariant) {
    firstVariant.click(); // triggers li click handler
  }

  // Add custom view button once
  if (!window.viewButtonAdded) {
    addViewButton();
    window.viewButtonAdded = true;
  }

  // Set up view toggle listeners once
  if (!window.viewToggleSetup) {
    setupViewToggleListener();
    window.viewToggleSetup = true;
  }
}
function addViewButton() {
  const toggleGroup = document.querySelector(".MuiToggleButtonGroup-root");
  if (!toggleGroup) {
    console.warn("Toggle button group not found");
    return;
  }

  // Deactivate existing buttons initially
  const existingButtons = toggleGroup.querySelectorAll("button");
  existingButtons.forEach((btn) => {
    btn.classList.remove("Mui-selected", "btn-active");
    btn.setAttribute("aria-pressed", "false");
  });

  // Create custom button
  const customButton = document.createElement("button");
  customButton.className = "custom-view-btn btn-active";
  customButton.type = "button";
  customButton.setAttribute("aria-label", "Custom view");
  customButton.setAttribute("aria-pressed", "true");
  customButton.tabIndex = 0;

  const iconSpan = document.createElement("span");
  iconSpan.className = "material-icons";
  iconSpan.textContent = "dashboard_customize";

  const rippleSpan = document.createElement("span");
  rippleSpan.className = "MuiTouchRipple-root css-4mb1j7";

  customButton.append(iconSpan, rippleSpan);
  window.customViewWasActive = true;
  // ✅ Click handler: activate and re-run addExternalTemplate() with saved params
  customButton.addEventListener("click", () => {
    // deactivate all buttons
    toggleGroup.querySelectorAll("button").forEach((btn) => {
      btn.classList.remove("btn-active", "Mui-selected");
      btn.setAttribute("aria-pressed", "false");
    });
    // activate this one
    customButton.classList.add("btn-active");
    customButton.setAttribute("aria-pressed", "true");
    window.customViewWasActive = true;

    // ✅ Re-run addExternalTemplate with saved params
    if (window.externalTemplateParams) {
      addExternalTemplate(
        window.externalTemplateParams.width,
        window.externalTemplateParams.height,
        window.externalTemplateParams.templateUrl,
      );
    }
  });

  // Append new button
  toggleGroup.appendChild(customButton);

  // Give the button just before new button a class
  const prevButton = customButton.previousElementSibling;
  if (prevButton && prevButton.tagName.toLowerCase() === "button") {
    prevButton.classList.add("before-custom-btn");
  }

  // Clicking other buttons removes custom active state
  toggleGroup.querySelectorAll("button").forEach((btn) => {
    if (btn !== customButton) {
      btn.addEventListener("click", () => {
        customButton.classList.remove("btn-active");
        customButton.setAttribute("aria-pressed", "false");
      });
    }
  });
}

// === View toggle listener ===
function setupViewToggleListener() {
  const toggleButtons = document.querySelectorAll(
    'button[aria-label="List view"], button[aria-label="Gallery view"], button[aria-label="Canvas view"]',
  );

  toggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (!window.customViewWasActive) {
        return;
      }
      window.customViewWasActive = false;

      button.classList.add("Mui-selected");
      button.setAttribute("aria-pressed", "true");

      // Remove custom tree
      document.querySelector("#my-variant-tree")?.parentElement?.remove();

      // Show old tree
      const oldTreeParent =
        document.querySelector('ul[role="tree"]')?.parentElement;
      if (!oldTreeParent) return;

      oldTreeParent.style.display = "";

      // ✅ Find the first child variant using working selector
      const firstChildLi = document.querySelector(
        'ul[role="tree"] > li > ul > div > div > li',
      );
      if (!firstChildLi) {
        console.warn("First child variant not found");
        return;
      }

      // Click its checkbox if present
      const checkbox = firstChildLi.querySelector('input[type="checkbox"]');
      if (checkbox) {
        checkbox.click();
      } else {
        firstChildLi.querySelector(".MuiTreeItem-content")?.click();
      }
    });
  });
}

// === Add custom iframe preview ===
async function addCustomIframe(template, variants) {
  const previewRoot = document
    .querySelector(
      'button[aria-label="Fit to view"], button[aria-label="Actual size"], button[aria-label="Reload"]',
    )
    ?.closest(".MuiPaper-root")?.previousElementSibling.firstChild;

  if (!previewRoot) {
    console.warn("Preview root not found");
    return;
  }

  // Safely remove all children
  while (previewRoot.firstChild) {
    previewRoot.removeChild(previewRoot.firstChild);
  }

  const previewWrap = createEl("div", "preview-wrap");
  const customCard = await buildCustomIframeCard(template, variants);
  if (!customCard) {
    console.warn("Failed to build custom card for", template.contentId);
    return;
  }

  customCard.setAttribute("aria-label", template.contentId);
  customCard.setAttribute("data-template-width", template.width);
  customCard.setAttribute("data-template-height", template.height);

  previewWrap.appendChild(customCard);
  previewRoot.appendChild(previewWrap);
}

// === Variant tree ===
function buildVariantTree(variants, formWidth, formHeight, templateUrl) {
  const parentVariants = variants.filter(
    (v) => !(v.data.label || "").includes("HTML5"),
  );

  const container = createEl("div", "variant-tree-wrapper");

  // MUI search input
  const muiInputWrapper = createEl(
    "div",
    "MuiInputBase-root MuiOutlinedInput-root MuiInputBase-colorPrimary MuiInputBase-fullWidth MuiInputBase-formControl MuiInputBase-sizeSmall MuiInputBase-adornedEnd css-1dh3m2g",
  );
  const searchInput = createEl(
    "input",
    "MuiInputBase-input MuiOutlinedInput-input MuiInputBase-inputSizeSmall MuiInputBase-inputAdornedEnd css-u9e8k",
  );
  searchInput.type = "text";
  searchInput.placeholder = "Search variants";
  searchInput.id = "_r_c_";
  searchInput.addEventListener("focus", () =>
    muiInputWrapper.classList.add("focused"),
  );
  searchInput.addEventListener("blur", () =>
    muiInputWrapper.classList.remove("focused"),
  );

  const searchIcon = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  );
  searchIcon.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  searchIcon.setAttribute("width", "24");
  searchIcon.setAttribute("height", "24");
  searchIcon.setAttribute("fill", "none");
  searchIcon.setAttribute("viewBox", "0 0 24 24");
  searchIcon.classList.add(
    "MuiSvgIcon-root",
    "MuiSvgIcon-colorDefault",
    "MuiSvgIcon-fontSizeMedium",
    "css-11kbvuf",
  );

  const path1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path1.setAttribute("fill", "#fff");
  path1.setAttribute("fill-opacity", "0.01");
  path1.setAttribute("d", "M0 0h24v24H0z");

  const path2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path2.setAttribute("fill", "currentColor");
  path2.setAttribute(
    "d",
    "m19.647 18.237-3.041-3.042a7 7 0 0 0 1.4-4.192A7 7 0 0 0 11.004 4 7 7 0 0 0 4 11.003a6.998 6.998 0 0 0 11.195 5.603l3.042 3.041c.2.2.3.3.41.33.1.03.21.03.31 0 .05-.02.1-.04.15-.09.07-.06.15-.14.26-.25l.28-.28c.2-.2.3-.3.33-.41.03-.1.03-.21 0-.31-.04-.11-.14-.21-.33-.41zm-8.644-2.231a5.004 5.004 0 0 1-5.002-5.003 5.004 5.004 0 0 1 5.002-5.002 5.004 5.004 0 0 1 5.003 5.002 5.004 5.004 0 0 1-5.003 5.003",
  );

  searchIcon.append(path1, path2);

  const fieldset = createEl(
    "fieldset",
    "MuiOutlinedInput-notchedOutline css-5v2ak0",
  );
  fieldset.setAttribute("aria-hidden", "true");
  const legend = createEl("legend", "css-w4cd9x");
  const spanSpace = createEl("span", "notranslate", "\u200B");
  spanSpace.setAttribute("aria-hidden", "true");
  legend.appendChild(spanSpace);
  fieldset.appendChild(legend);

  muiInputWrapper.append(searchInput, searchIcon, fieldset);
  container.appendChild(muiInputWrapper);

  // Title
  container.appendChild(
    createEl(
      "span",
      "MuiTypography-root MuiTypography-body1 MuiTypography-noWrap css-1f1wxvc",
      "Ad variants",
    ),
  );

  // Tree
  const tree = createEl("ul");
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-multiselectable", "false");
  tree.id = "my-variant-tree";

  parentVariants.forEach((variant) => {
    const contentId = variant.data["content-id"];
    const li = createEl("li", "variant-tree-item");
    li.setAttribute("role", "treeitem");
    li.tabIndex = -1;
    li.dataset.contentId = contentId;

    const row = createEl("div", "variant-tree-content", contentId);
    li.appendChild(row);

    li.addEventListener("click", () => {
      tree
        .querySelectorAll(".selected")
        .forEach((el) => el.classList.remove("selected"));
      li.classList.add("selected");

      const template = {
        contentId,
        width: parseInt(formWidth, 10) || 0,
        height: parseInt(formHeight, 10) || 0,
        templateUrl,
      };
      addCustomIframe(template, variants);
    });

    tree.appendChild(li);
  });

  container.appendChild(tree);

  // Search filter
  searchInput.addEventListener("input", () => {
    const term = searchInput.value.toLowerCase();
    tree.querySelectorAll("li").forEach((li) => {
      const match = li.dataset.contentId.toLowerCase().includes(term);
      li.classList.toggle("hidden", !match);
    });
  });

  return container;
}

// === Preview card ===
async function buildCustomIframeCard(template, variants) {
  const match = variants.find(
    (v) => v.data["content-id"].trim() === template.contentId,
  );
  if (!match) return console.warn("Variant not found:", template.contentId);

  const adVariant = match.data["ad-variants"].find((v) =>
    v["ad-formats"]?.some(
      (f) => f.width === template.width && f.height === template.height,
    ),
  );
  if (!adVariant)
    return console.warn("Size not found:", template.width, template.height);

  const renderData =
    adVariant.components["urn:lemonpi:artefact:display:content+template"]
      ?.value;

  const cardDiv = createEl("div", "local-preview-card");
  const iframe = createEl("iframe");
  Object.assign(iframe, {
    width: template.width,
    height: template.height,
    src: `${template.templateUrl}?_lemonpiPreview`,
  });
  iframe.style.border = "none";

  // --- Define the handler once ---
  const messageHandler = (event) => {
    if (
      event.data?.type === "lemonpi-awaiting-config" &&
      event.source === iframe.contentWindow
    ) {
      sendConfig();
    }
  };

  // Send config to iframe
  const sendConfig = () => {
    const configMsg = {
      type: "lemonpi-config",
      config: { exportContent: renderData.content },
    };
    iframe.contentWindow.postMessage(configMsg, "*");
  };

  // Attach listener (ensuring duplicates aren't created)
  const attachHandshakeListener = () => {
    window.removeEventListener("message", messageHandler); // remove old one if exists
    window.addEventListener("message", messageHandler);
  };

  // Initial attach
  attachHandshakeListener();

  cardDiv.appendChild(iframe);

  // --- Info area ---
  const infoOuter = createEl("div", "info-outer");
  const upperInfo = createEl("div", "info-upper");
  const statusAndButtons = createEl("div", "status-and-buttons");

  const chipDiv = createEl(
    "div",
    "info-status",
    `<span class=""><div class="info-chip">Draft</div></span>`,
  );
  statusAndButtons.appendChild(chipDiv);

  const reloadBtn = createEl(
    "button",
    "iframe-reload-btn",
    `<span class="material-icons">refresh</span>`,
  );
  reloadBtn.type = "button";
  reloadBtn.addEventListener("click", () => {
    iframe.src = `${template.templateUrl}?_lemonpiPreview`; // reload content
    attachHandshakeListener(); // reattach handshake fresh
  });
  statusAndButtons.appendChild(reloadBtn);

  upperInfo.appendChild(statusAndButtons);
  infoOuter.appendChild(upperInfo);

  const lowerInfo = createEl(
    "div",
    "lower-info",
    `
  <div class="lower-info-wrap">
    <div class="template-info">
      <p class="template-contentId" aria-label="${template.contentId}">${template.contentId}</p>
    </div>
    <span class="template-details">CUSTOM · ${template.width}x${template.height}</span>
  </div>
`,
  );
  infoOuter.appendChild(lowerInfo);

  cardDiv.appendChild(infoOuter);
  return cardDiv;
}
// =========================
// 10) UI Injection (buttons + iframe buttons)
// =========================

// 10.1 Helpers
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function findButtonByTextIncludes(text, root = document) {
  return $$("button", root).find((b) => b.textContent?.includes(text));
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

// 10.2 Button updates
const screenshotUI = {
  wired: false,
  btn: null,
  recordBtn: null,
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
  screenshotUI.recordBtn = null;
  screenshotUI.treeRoot = null;
  screenshotUI.observer = null;
  screenshotUI.onChange = null;
  screenshotUI.seq = 0;
  screenshotUI.schedule = null;
}

async function updateScreenshotBtnCount() {
  const btn = screenshotUI.btn;
  const recordBtn = screenshotUI.recordBtn;
  if (!btn && !recordBtn) return;

  const seq = ++screenshotUI.seq;
  const previewVariants = await extractVariantsFromPreview(); // from Section 5
  const total = previewVariants.reduce(
    (sum, v) => sum + (v.sizes?.length || 0),
    0,
  );
  if (seq !== screenshotUI.seq) return;

  // Only touch the DOM when the count changed: rewriting the button is itself a mutation that
  // re-triggers this updater, and replacing the icon between mousedown and mouseup swallows the click
  if (btn && btn.dataset.count !== String(total)) {
    btn.dataset.count = String(total);
    btn.innerHTML = `<span class="material-icons camera-icon">camera_alt</span> ${total}`;
    btn.disabled = total === 0;
  }
  if (recordBtn && recordBtn.dataset.count !== String(total)) {
    recordBtn.dataset.count = String(total);
    recordBtn.innerHTML = `<span class="material-icons" aria-hidden="true">videocam</span> ${total}`;
    recordBtn.disabled = total === 0;
  }
}

function wireScreenshotCountUpdater(btn) {
  screenshotUI.btn = btn;
  wirePreviewCountUpdater();
}

function wireRecordingCountUpdater(btn) {
  screenshotUI.recordBtn = btn;
  wirePreviewCountUpdater();
}

function wirePreviewCountUpdater() {
  if (screenshotUI.wired) {
    screenshotUI.schedule();
    return;
  }

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
  screenshotUI.btn = null;
  if (!screenshotUI.recordBtn) teardownScreenshotCountUpdater();
}

function removeRecordingButton() {
  document.getElementById("record-ads-btn")?.remove();
  screenshotUI.recordBtn = null;
  if (!screenshotUI.btn) teardownScreenshotCountUpdater();
}

// 10.3 - inject buttons
async function injectButtons() {
  const url = location.href;
  const params = new URLSearchParams(location.search);

  const {
    screenshotsEnabled,
    recordingsEnabled,
    videosEnabled,
    assetsZipEnabled,
    assetsCsvEnabled,
    addTemplateEnabled,
  } = await storageGet({
    screenshotsEnabled: STORAGE_DEFAULTS.screenshotsEnabled,
    recordingsEnabled: STORAGE_DEFAULTS.recordingsEnabled,
    videosEnabled: STORAGE_DEFAULTS.videosEnabled,
    assetsZipEnabled: STORAGE_DEFAULTS.assetsZipEnabled,
    assetsCsvEnabled: STORAGE_DEFAULTS.assetsCsvEnabled,
    addTemplateEnabled: STORAGE_DEFAULTS.addTemplateEnabled,
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
    if (recordingsEnabled) {
      const recordButton = ensureButton({
        id: "record-ads-btn",
        parent: shareButton.parentNode,
        afterElement: shareButton.previousSibling,
        className: "next-btn",
        text: `<span class="material-icons" aria-hidden="true">videocam</span>`,
        onClick: () => openAdRecordings(),
      });
      recordButton.title = "Record selected ads (MP4/H.264)";
      recordButton.setAttribute("aria-label", recordButton.title);
      wireRecordingCountUpdater(recordButton);
    } else {
      removeRecordingButton();
    }
    if (addTemplateEnabled) {
      ensureButton({
        id: "preview-btn",
        parent: shareButton.parentNode,
        afterElement: shareButton.previousSibling,
        className: "preview-btn next-btn",
        text: `Add template`,
        onClick: openExternalPreviewPopup, // Section 5
      });
    } else {
      document.getElementById("preview-btn")?.remove();
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

    if (adsetData?.channel === "video" || adsetData?.channel === "meta") {
      ensureButton({
        id: "download-videos-btn",
        parent: adVariantsButton.parentNode,
        afterElement: adVariantsButton,
        className: "download-ads-btn",
        text: `<span class="material-icons" aria-hidden="true">cloud_download</span>Download ads`,
        onClick: () => downloadVideos(adsetData.channel),
      });
    } else {
      document.getElementById("download-videos-btn")?.remove();
    }
  }
}

// 10.4 inject iframe buttons
async function injectIframeButtons() {
  const { screenshotsEnabled, recordingsEnabled, individualReloadEnabled } =
    await storageGet({
      screenshotsEnabled: STORAGE_DEFAULTS.screenshotsEnabled,
      recordingsEnabled: STORAGE_DEFAULTS.recordingsEnabled,
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
    const existingRecordBtn = container.querySelector(".iframe-record-btn");

    if (!recordingsEnabled) {
      existingRecordBtn?.remove();
    } else if (!existingRecordBtn) {
      const recordButton = document.createElement("button");
      recordButton.className =
        "MuiButtonBase-root MuiIconButton-root MuiIconButton-colorGrey MuiIconButton-sizeMedium css-hmbvib iframe-record-btn";
      recordButton.type = "button";
      recordButton.title = "Record this ad (MP4/H.264)";
      recordButton.setAttribute("aria-label", recordButton.title);
      recordButton.innerHTML = `<span class="material-icons" aria-hidden="true">videocam</span>`;
      recordButton._run = async () => {
        if (recordButton.disabled) return;
        const context = getIframeContext(container);
        if (!context)
          return showToast(
            "Recording failed: could not extract the ad context.",
          );
        recordButton.disabled = true;
        try {
          await openAdRecordings(context);
        } finally {
          recordButton.disabled = false;
        }
      };
      recordButton.addEventListener("click", () => {
        if (Date.now() - (recordButton._lastPress || 0) > 1000)
          void recordButton._run();
      });
      readyChip.insertAdjacentElement("afterend", recordButton);
    }

    // --- Reload button toggle ---
    if (!individualReloadEnabled) {
      // 🔴 Remove reload button if present
      if (existingReloadBtn) existingReloadBtn.remove();
    } else if (!existingReloadBtn) {
      // 🟢 Add reload button if enabled
      const reloadBtn = document.createElement("button");
      reloadBtn.className = "iframe-reload-btn";
      reloadBtn.type = "button";
      reloadBtn.tabIndex = 0;
      reloadBtn.innerHTML = `<span class="material-icons">refresh</span>`;
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

      const runShot = async () => {
        if (shotBtn.dataset.busy) return; // ignore repeat clicks while a capture is running
        shotBtn.dataset.busy = "1";
        shotBtn.style.opacity = "0.5";
        const icon = shotBtn.querySelector(".material-icons");
        if (icon) icon.textContent = "hourglass_top";

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
          const results = await takeScreenshots(match, ctx);
          if (!results.length) {
            reportScreenshotError(
              `None of the selected frames exist at ${ctx.width}x${ctx.height}.`,
              { phase: "iframeSingleScreenshot" },
            );
            return;
          }

          // Several frames are bundled so the browser doesn't prompt for multiple downloads
          let fileBlob = results[0].blob;
          let fileName = screenshotFileName(results[0]);
          if (results.length > 1) {
            const zip = new window.JSZip();
            results.forEach((r) => zip.file(screenshotFileName(r), r.blob));
            fileBlob = await zip.generateAsync({ type: "blob" });
            fileName = `${results[0].safeVariantName}_${results[0].sizeString}_frames.zip`;
          }

          const url = URL.createObjectURL(fileBlob);
          const a = document.createElement("a");
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          a.remove();

          setTimeout(() => URL.revokeObjectURL(url), 250);
        } catch (err) {
          reportScreenshotError(err?.message || String(err), {
            phase: "iframeSingleScreenshot",
            stack: err?.stack,
          });
        } finally {
          delete shotBtn.dataset.busy;
          shotBtn.style.opacity = "";
          if (icon) icon.textContent = "camera_alt";
        }
      };

      // Presses are handled by the window-level listener below; click only covers keyboard activation
      shotBtn._run = runShot;
      shotBtn.addEventListener("click", () => {
        if (Date.now() - (shotBtn._lastPress || 0) > 1000) runShot();
      });

      // Insert screenshot button after the reload button (if present) or readyChip
      (
        container.querySelector(".iframe-reload-btn") || readyChip
      ).insertAdjacentElement("afterend", shotBtn);
    }
  });
}
// =========================
// 11) Bootstrapping (observers + init)
// =========================

const scheduleInject = debounce(
  async () => {
    try {
      await injectIframeButtons();
      await injectButtons();
      void injectLiveAdsetStatus();
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

// Start screenshots on press, at window level and by pointer position. The page re-renders its
// cards and can overlay them, so the press may not target the button (or the button may be swapped
// before the click completes).
window.addEventListener(
  "pointerdown",
  (e) => {
    if (e.button !== 0) return;
    const btn = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find(
        (el) =>
          el.classList?.contains("iframe-screenshot-btn") ||
          el.classList?.contains("iframe-record-btn"),
      );
    if (!btn?._run) return;
    btn._lastPress = Date.now();
    btn._run();
  },
  true,
);

// DOM changes (SPA + MUI rerenders)
const observer = new MutationObserver(() => scheduleInject());
observer.observe(document.body, { childList: true, subtree: true });

// Settings changes from side panel
onStorageChanged(
  [
    "screenshotsEnabled",
    "recordingsEnabled",
    "videosEnabled",
    "assetsZipEnabled",
    "assetsCsvEnabled",
    "liveAdsetStatusEnabled",
  ],
  (changes) => {
    if (changes.liveAdsetStatusEnabled) stopLiveAdsetChecks();
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
