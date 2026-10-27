const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  selectRecordingType,
  recordingOptions,
  recordingRange,
  resolveRecordingRange,
  recordingFileName,
  recordingCrop,
} = require("../recording/recording-core.js");

test("recording requires explicit H.264 in MP4, never generic MP4 or WebM", () => {
  const type = selectRecordingType({
    isTypeSupported: (candidate) => candidate.includes("avc1.42001E"),
  });
  assert.equal(type, 'video/mp4;codecs="avc1.42001E"');
  assert.throws(
    () =>
      selectRecordingType({
        isTypeSupported: (candidate) =>
          candidate === "video/mp4" || candidate.includes("webm"),
      }),
    /H.264/,
  );
  assert.throws(() => selectRecordingType(undefined), /H.264/);
});

test("duration is bounded and recording defaults to 15 seconds at 30 FPS", () => {
  assert.deepEqual(recordingOptions(), { duration: 15, fps: 30 });
  assert.deepEqual(recordingOptions("10"), { duration: 10, fps: 30 });
  for (const value of [0, -1, 121, NaN, Infinity, "invalid"])
    assert.throws(() => recordingOptions(value), /duration/);
});

test("recording ranges support fractional seconds and validate their interval", () => {
  assert.deepEqual(resolveRecordingRange(recordingRange()), {
    start: 0,
    end: 15,
    duration: 15,
  });
  assert.deepEqual(
    resolveRecordingRange(
      recordingRange(
        { type: "seconds", value: 2.5 },
        { type: "seconds", value: 7.75 },
      ),
    ),
    { start: 2.5, end: 7.75, duration: 5.25 },
  );
  for (const [start, end] of [
    [3, 3],
    [4, 2],
    [0, 121],
    [-1, 3],
    [NaN, 3],
  ]) {
    assert.throws(() =>
      recordingRange(
        { type: "seconds", value: start },
        { type: "seconds", value: end },
      ),
    );
  }
});

test("frame endpoints resolve per creative and can mix with seconds", () => {
  const range = recordingRange(
    { type: "frame", value: 2 },
    { type: "frame", value: 4 },
  );
  assert.deepEqual(
    resolveRecordingRange(range, { "frame2-preview": 3, "frame4-preview": 8 }),
    { start: 3, end: 8, duration: 5 },
  );
  assert.deepEqual(
    resolveRecordingRange(range, { "frame2-preview": 5, "frame4-preview": 11 }),
    { start: 5, end: 11, duration: 6 },
  );
  assert.deepEqual(
    resolveRecordingRange(
      recordingRange(
        { type: "seconds", value: 1 },
        { type: "frame", value: 4 },
      ),
      { "frame4-preview": 8 },
    ),
    { start: 1, end: 8, duration: 7 },
  );
  assert.throws(
    () => resolveRecordingRange(range, { "frame2-preview": 3 }),
    /Frame 4 is not available/,
  );
  assert.throws(
    () =>
      resolveRecordingRange(range, {
        "frame2-preview": 8,
        "frame4-preview": 3,
      }),
    /end must be after/,
  );
  assert.throws(
    () =>
      recordingRange(
        { type: "frame", value: 0 },
        { type: "seconds", value: 5 },
      ),
    /start frame/,
  );
  assert.throws(
    () =>
      recordingRange({ type: "frame", value: 3 }, { type: "frame", value: 3 }),
    /end must be after/,
  );
});

test("recordings use safe PowerPoint MP4 filenames", () => {
  assert.equal(
    recordingFileName('Example: "Ad"/One', 300, 250),
    "Example AdOne_300x250.mp4",
  );
  assert.equal(recordingFileName("", 300, 250), "Unnamed Variant_300x250.mp4");
});

test("crop maps viewport coordinates to captured pixels and rejects clipped ads", () => {
  assert.deepEqual(
    recordingCrop(
      { width: 300, height: 250, viewportWidth: 800, viewportHeight: 600 },
      1600,
      1200,
    ),
    { left: 0, top: 0, width: 600, height: 500 },
  );
  assert.throws(
    () =>
      recordingCrop(
        { width: 970, height: 250, viewportWidth: 800, viewportHeight: 600 },
        1600,
        1200,
      ),
    /fit/,
  );
  assert.throws(
    () =>
      recordingCrop(
        { width: 300, height: 250, viewportWidth: 0, viewportHeight: 600 },
        1600,
        1200,
      ),
    /fit/,
  );
});

test("recording crops account for aspect-preserving capture padding", () => {
  const bounds = {
    left: 10,
    top: 6,
    width: 300,
    height: 250,
    viewportWidth: 800,
    viewportHeight: 600,
  };
  assert.deepEqual(recordingCrop(bounds, 1920, 1080), {
    left: 258,
    top: 10.8,
    width: 540,
    height: 450,
  });
  assert.deepEqual(recordingCrop(bounds, 800, 800), {
    left: 10,
    top: 106,
    width: 300,
    height: 250,
  });
});

test("fractional crop edges stay exact without including the surrounding page", () => {
  const crop = recordingCrop(
    {
      left: 0.25,
      top: 0.25,
      width: 299.5,
      height: 249.5,
      viewportWidth: 800,
      viewportHeight: 600,
    },
    1600,
    1200,
  );
  assert.deepEqual(crop, { left: 0.5, top: 0.5, width: 599, height: 499 });
});

test("a fractional 160x600 capture does not gain an extra right-edge pixel", () => {
  const crop = recordingCrop(
    {
      left: 12.25,
      top: 0,
      width: 160,
      height: 600,
      viewportWidth: 800,
      viewportHeight: 600,
    },
    1600,
    1200,
  );
  assert.deepEqual(crop, { left: 24.5, top: 0, width: 320, height: 1200 });
});

test("rounded viewport sizes are not treated as letterbox padding", () => {
  // innerHeight rounds 860.5 CSS px up to 861 while the capture is 1721 px tall.
  const crop = recordingCrop(
    {
      left: 0,
      top: 0,
      width: 160,
      height: 600,
      viewportWidth: 1512,
      viewportHeight: 861,
    },
    3024,
    1721,
  );
  assert.equal(crop.left, 0);
  assert.equal(crop.top, 0);
  assert.equal(crop.width, 320);
  assert.ok(Math.abs(crop.height - 600 * (1721 / 861)) < 1e-9);
});

function recordingBackgroundHarness() {
  const stored = {};
  const messages = [];
  const removedTabs = [];
  const captureRequests = [];
  const openedPanels = [];
  const badges = [];
  const titles = [];
  const prompts = [];
  let onMessage;
  let onRemoved;
  let onAction;
  const sandbox = {
    console,
    importScripts() {},
    RecordingCore: require("../recording/recording-core.js"),
    crypto: { randomUUID: () => "session-1" },
    chrome: {
      action: {
        onClicked: {
          addListener(listener) {
            onAction = listener;
          },
        },
        async setBadgeText(value) {
          badges.push(value);
        },
        async setTitle(value) {
          titles.push(value);
        },
        async setBadgeBackgroundColor() {},
        async setBadgeTextColor() {},
      },
      scripting: {
        async executeScript(value) {
          prompts.push(value);
          return [];
        },
      },
      sidePanel: {
        async open(options) {
          openedPanels.push(options.tabId);
        },
      },
      tabCapture: {
        async getMediaStreamId(options) {
          captureRequests.push(options);
          return "tab-stream-1";
        },
      },
      runtime: {
        id: "co-plus",
        getURL: (value) => `chrome-extension://co-plus/${value}`,
        async getContexts() {
          return [{ contextType: "OFFSCREEN_DOCUMENT" }];
        },
        onMessage: {
          addListener(listener) {
            onMessage = listener;
          },
        },
        async sendMessage(message) {
          messages.push(message);
          return { success: true };
        },
      },
      offscreen: {
        async createDocument() {},
        async closeDocument() {
          messages.push({ action: "closeOffscreen" });
        },
      },
      windows: { async update() {} },
      storage: {
        sync: {
          async get(defaults) {
            return defaults;
          },
          async set() {},
        },
        session: {
          async get(key) {
            return structuredClone(key ? { [key]: stored[key] } : stored);
          },
          async set(values) {
            Object.assign(stored, structuredClone(values));
          },
          async remove(key) {
            delete stored[key];
          },
        },
      },
      tabs: {
        async get(tabId) {
          return {
            id: tabId,
            windowId: 1,
            url:
              tabId === 30
                ? "blob:https://create.choreograph.com/preview-1"
                : "about:blank",
          };
        },
        async create(options) {
          messages.push(options);
          return { id: 30, windowId: 1 };
        },
        async update() {},
        async remove(tabId) {
          removedTabs.push(tabId);
        },
        async sendMessage(tabId, message) {
          messages.push({ tabId, ...message });
        },
        onRemoved: {
          addListener(listener) {
            onRemoved = listener;
          },
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "../recording/recording-host.js"),
      "utf8",
    ),
    sandbox,
  );
  sandbox.prepareRecordingPreview = async () => ({});
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "../recording/recording-background.js"),
      "utf8",
    ),
    sandbox,
  );
  const job = {
    name: "Example",
    width: 300,
    height: 250,
    blobUrl: "blob:https://create.choreograph.com/preview-1",
  };
  const sender = {
    tab: { id: 10, windowId: 1 },
    url: "https://create.choreograph.com/97/advertiser/755",
  };
  const send = (jobs = [job], from = sender, values = {}) =>
    new Promise((resolve) =>
      onMessage({ action: "openRecording", jobs, ...values }, from, resolve),
    );
  const command = (value, values = {}) =>
    new Promise((resolve) =>
      onMessage(
        {
          action: "recordingCommand",
          command: value,
          id: "session-1",
          duration: 15,
          ...values,
        },
        { id: "co-plus", url: "chrome-extension://co-plus/panel/panel.html" },
        resolve,
      ),
    );
  const request = (message, from) =>
    new Promise((resolve) => onMessage(message, from, resolve));
  return {
    stored,
    messages,
    removedTabs,
    captureRequests,
    openedPanels,
    badges,
    titles,
    prompts,
    job,
    sender,
    send,
    command,
    request,
    close: (tabId) => onRemoved(tabId),
    click: (tabId) => onAction({ id: tabId }),
    sandbox,
  };
}

test("selecting ads stages settings without opening a preview or configuring an encoder", async () => {
  const harness = recordingBackgroundHarness();
  assert.equal((await harness.send()).success, true);
  const session = harness.stored["coPlusRecording:session-1"];
  assert.equal(session.sourceTabId, 10);
  assert.equal(session.captureTabId, null);
  assert.equal(session.engineConfigured, false);
  assert.equal(session.status, "Ready");
  assert.equal(session.recorderTabId, undefined);
  assert.equal(session.jobs.length, 1);
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.prompts.length, 0);
  assert.equal((await harness.send()).success, false);
});

test("batch selection does not even initialize preview or offscreen resources", async () => {
  const harness = recordingBackgroundHarness();
  harness.sandbox.chrome.tabs.create = async () => {
    throw new Error("Preview opened before Start");
  };
  harness.sandbox.chrome.runtime.getContexts = async () => {
    throw new Error("Encoder inspected before Start");
  };
  assert.equal((await harness.send()).success, true);
  assert.equal(harness.stored["coPlusRecording:session-1"].status, "Ready");
});

test("a staged batch can be cleared before Start without contacting an encoder", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  harness.sandbox.chrome.runtime.getContexts = async () => [];
  assert.equal((await harness.command("clear")).success, true);
  assert.equal(harness.removedTabs.length, 0);
  assert(
    !harness.messages.some((message) => message.target === "recording-engine"),
  );
  assert(
    !harness.messages.some((message) => message.action === "closeOffscreen"),
  );
  assert(
    harness.messages.some(
      (message) =>
        message.action === "releaseRecording" && message.tabId === 10,
    ),
  );
  assert.equal(Object.keys(harness.stored).length, 0);
});

test("a new toolbar batch waits for an explicit Start even if an old caller requests auto-start", async () => {
  const harness = recordingBackgroundHarness();
  harness.sandbox.chrome.storage.sync.get = async () => ({
    recordingDuration: 8,
  });
  assert.equal(
    (await harness.send([harness.job], harness.sender, { autoStart: true }))
      .success,
    true,
  );
  const configured = harness.messages.findIndex(
    (message) => message.action === "configureRecording",
  );
  assert.equal(configured, -1);
  assert.equal(harness.stored["coPlusRecording:session-1"].status, "Ready");
  assert(
    !harness.messages.some((message) => message.action === "startRecording"),
  );
  assert.equal((await harness.command("start")).success, true);
  assert.equal(
    harness.messages.find((message) => message.action === "startRecording")
      .duration,
    15,
  );
  assert.deepEqual(harness.stored["coPlusRecording:session-1"].range, {
    start: { type: "seconds", value: 0 },
    end: { type: "seconds", value: 15 },
  });
  assert.equal(harness.captureRequests.length, 0);
});

test("Start opens the preview and configures the encoder before requesting capture", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  assert.equal(harness.prompts.length, 0);
  const sendMessage = harness.sandbox.chrome.runtime.sendMessage;
  harness.sandbox.chrome.runtime.sendMessage = async (message) => {
    if (message.action === "startRecording")
      assert.equal(harness.prompts.at(-1).args[0], false);
    return sendMessage(message);
  };
  assert.equal((await harness.command("start")).success, true);
  const created = harness.messages.findIndex(
    (message) => message.url === "about:blank",
  );
  const configured = harness.messages.findIndex(
    (message) => message.action === "configureRecording",
  );
  const started = harness.messages.findIndex(
    (message) => message.action === "startRecording",
  );
  assert(created >= 0 && configured > created && started > configured);
  assert.equal(harness.messages[created].windowId, 1);
});

test("record panel opening runs immediately for the clicking tab's window", async () => {
  const harness = recordingBackgroundHarness();
  const opened = [];
  harness.sandbox.chrome.sidePanel.open = async (options) => {
    opened.push(options.windowId);
  };
  const pending = harness.request(
    { action: "openRecordingPanel" },
    harness.sender,
  );
  assert.deepEqual(opened, [1]);
  assert.equal((await pending).success, true);
  assert.equal(harness.stored["coPlusPanelNavigation:1"].tab, "t-recordings");
  assert(
    !Object.keys(harness.stored).some((key) =>
      key.startsWith("coPlusRecording:"),
    ),
  );
  assert.equal(
    (
      await harness.request(
        { action: "openRecordingPanel" },
        { tab: { id: 99, windowId: 2 }, url: "https://example.com/" },
      )
    ).success,
    false,
  );
  assert.deepEqual(opened, [1]);
});

test("explicit Start applies selected recording endpoints", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  const range = {
    start: { type: "frame", value: 3 },
    end: { type: "seconds", value: 9 },
  };
  assert.equal((await harness.command("start", { range })).success, true);
  assert.deepEqual(harness.stored["coPlusRecording:session-1"].range, {
    start: { type: "frame", value: 3 },
    end: { type: "seconds", value: 9 },
  });
});

test("invalid selections and foreign blob URLs cannot launch recording sessions", async () => {
  const harness = recordingBackgroundHarness();
  for (const jobs of [
    [],
    [null],
    [{ ...harness.job, blobUrl: "blob:https://example.com/preview-1" }],
    [{ ...harness.job, width: 0 }],
    [{ ...harness.job, height: 4097 }],
    Array(501).fill(harness.job),
  ]) {
    assert.equal((await harness.send(jobs)).success, false);
  }
  assert.equal(
    (
      await harness.send([harness.job], {
        tab: { id: 10 },
        url: "https://example.com/",
      })
    ).success,
    false,
  );
  assert.equal(harness.messages.length, 0);
});

test("failed preview creation on Start preserves the selection for retry", async () => {
  const harness = recordingBackgroundHarness();
  harness.sandbox.chrome.tabs.create = async () => {
    throw new Error("Could not create tab");
  };
  assert.equal((await harness.send()).success, true);
  assert.equal((await harness.command("start")).success, false);
  assert.equal(harness.stored["coPlusRecording:session-1"].status, "Error");
  assert.equal(harness.stored["coPlusRecording:session-1"].jobs.length, 1);
});

test("clearing a selection removes its preview and releases source URLs and offscreen resources", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  await harness.command("start");
  harness.stored["coPlusRecording:session-1"].status = "Done";
  assert.equal((await harness.command("clear")).success, true);
  assert.deepEqual(harness.removedTabs, [30]);
  assert.equal(Object.keys(harness.stored).length, 0);
  assert(
    harness.messages.some(
      (message) =>
        message.action === "releaseRecording" && message.tabId === 10,
    ),
  );
  assert(
    harness.messages.some((message) => message.action === "closeOffscreen"),
  );
});

test("closing the source before Start cancels settings without opening recording resources", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  harness.close(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.removedTabs.length, 0);
  assert(
    !harness.messages.some((message) => message.target === "recording-engine"),
  );
  assert.equal(harness.stored["coPlusRecording:session-1"].sourceClosed, true);
});

test("closing an unrelated interface tab does not cancel the offscreen session", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  harness.close(20);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.removedTabs.length, 0);
  assert.equal(harness.stored["coPlusRecording:session-1"].status, "Ready");
});

test("toolbar authorization issues an extension-scoped token for the offscreen encoder", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  Object.assign(harness.stored["coPlusRecording:session-1"], {
    captureTabId: 30,
    status: "Awaiting toolbar authorization",
    captureAuthorization: "authorization-1",
  });
  await harness.sandbox.authorizeRecordingTab({ id: 30 });
  assert.equal(harness.captureRequests.length, 1);
  assert.equal(harness.captureRequests[0].targetTabId, 30);
  assert.equal(harness.captureRequests[0].consumerTabId, undefined);
  const result = harness.messages.find(
    (message) => message.action === "recordingTabCaptureResult",
  );
  assert.equal(result.streamId, "tab-stream-1");
  assert.equal(result.authorization, "authorization-1");
});

test("unrelated toolbar clicks open the side panel without acquiring capture", async () => {
  const harness = recordingBackgroundHarness();
  harness.click(99);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.openedPanels, [99]);
  assert.equal(harness.captureRequests.length, 0);
});

test("toolbar authorization refuses a preview that navigated away", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  Object.assign(harness.stored["coPlusRecording:session-1"], {
    captureTabId: 99,
    status: "Awaiting toolbar authorization",
    captureAuthorization: "authorization-1",
  });
  await harness.sandbox.authorizeRecordingTab({ id: 99 });
  assert.equal(harness.captureRequests.length, 0);
  assert.match(
    harness.messages.find(
      (message) => message.action === "recordingTabCaptureResult",
    ).error,
    /preview changed/,
  );
});

test("tab-capture denial is reported without falling back to desktop sharing", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  Object.assign(harness.stored["coPlusRecording:session-1"], {
    captureTabId: 30,
    status: "Awaiting toolbar authorization",
    captureAuthorization: "authorization-1",
  });
  harness.sandbox.chrome.tabCapture.getMediaStreamId = async () => {
    throw new Error("Blocked by policy");
  };
  await harness.sandbox.authorizeRecordingTab({ id: 30 });
  assert.match(
    harness.messages.find(
      (message) => message.action === "recordingTabCaptureResult",
    ).error,
    /Blocked by policy/,
  );
});

test("MP4 finalization rejects invalid media and honors cancellation", async () => {
  const { remuxRecording } = await import("../recording/mp4.mjs");
  await assert.rejects(remuxRecording(new Blob(["not a recording"])));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    remuxRecording(new Blob(["not a recording"]), controller.signal),
    { name: "AbortError" },
  );
});

test("seconds-only recording trims reload time and pre-roll while capturing through the end", async () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../recording/recorder.js"),
    "utf8",
  );
  const payload = new Uint8Array(64);
  payload.set([0, 0, 0, 20, 102, 116, 121, 112]);
  const blob = new Blob([payload]);
  let now = 1000;
  let trim;
  let deadline;
  let stopped = false;
  const bounds = {
    width: 300,
    height: 250,
    viewportWidth: 800,
    viewportHeight: 600,
  };
  class Recorder {
    constructor(_stream, options) {
      this.mimeType = options.mimeType;
      this.state = "inactive";
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable({ data: blob });
      this.onstop();
    }
  }
  const sandbox = {
    Blob,
    Uint8Array,
    MediaRecorder: Recorder,
    Date: { now: () => now },
    recordingCrop,
    recordingController: new AbortController(),
    ui: {
      capture: { readyState: 2, videoWidth: 800, videoHeight: 600 },
      canvas: {
        getContext: () => ({ fillRect() {}, drawImage() {} }),
        captureStream: () => ({
          getTracks: () => [
            {
              stop() {
                stopped = true;
              },
            },
          ],
        }),
      },
    },
    checkCancelled() {},
    verifyCapture: () => true,
    async recordingHost(operation) {
      return operation === "watch" ? bounds : undefined;
    },
    async resumeCreative() {
      now = 1300;
      return { startedAt: now, bounds, realTime: true };
    },
    async setStatus() {},
    async remuxRecording(value, _signal, range) {
      trim = range;
      return value;
    },
    setInterval: () => 1,
    clearInterval() {},
    clearTimeout() {},
    setTimeout(callback, delay) {
      deadline = delay;
      queueMicrotask(callback);
      return 1;
    },
  };
  vm.runInNewContext(
    source.slice(
      source.indexOf("async function recordAd"),
      source.indexOf("async function offerDownload"),
    ),
    sandbox,
  );
  await sandbox.recordAd(
    { width: 300, height: 250, name: "No timeline" },
    { ...bounds },
    'video/mp4;codecs="avc1.42001E"',
    { start: 2, end: 5, duration: 3, fps: 30, realTime: true },
  );
  assert.equal(deadline, 5000);
  assert.equal(trim.start, 2.3);
  assert.equal(trim.end, 5.3);
  assert.equal(stopped, true);
});

test("seconds-only MP4 finalization validates trim bounds before conversion", async () => {
  const { remuxRecording } = await import("../recording/mp4.mjs");
  for (const trim of [
    { start: -1, end: 2 },
    { start: 2, end: 2 },
    { start: 2, end: 1 },
    { start: 0, end: NaN },
  ]) {
    await assert.rejects(
      remuxRecording(new Blob(["invalid"]), undefined, trim),
      /trim range/,
    );
  }
});

function recordingSourceHarness() {
  const requests = [];
  const calls = [];
  const revoked = [];
  const errors = [];
  let release;
  const selected = [{ variant: "Example", sizes: ["300x250"] }];
  const sandbox = {
    STORAGE_DEFAULTS: { recordingsEnabled: true },
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            release = listener;
          },
        },
      },
    },
    URL: {
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
    async storageGet() {
      calls.push("storage");
      return { recordingsEnabled: true };
    },
    async fetchAdVariants() {
      calls.push("variants");
      return [{ data: { "content-id": "Example" } }];
    },
    async extractVariantsFromPreview() {
      return selected;
    },
    getRenderData(_match, context) {
      return context;
    },
    buildAdBlob() {
      return "blob:https://create.choreograph.com/preview-1";
    },
    async runtimeSend(message) {
      calls.push(message.action);
      if (message.action !== "openRecordingPanel") requests.push(message);
      return { success: true, id: "session-1" };
    },
    showToast(message) {
      errors.push(message);
    },
  };
  const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
  const start = source.indexOf("const recordingUrls = new Map()");
  vm.runInNewContext(
    source.slice(start, source.indexOf("// 6) Tools: Videos", start)),
    sandbox,
  );
  return {
    sandbox,
    requests,
    calls,
    revoked,
    errors,
    selected,
    release: (id) => release({ action: "releaseRecording", id }),
  };
}

test("selected ads and a single ad use the same recording job path", async () => {
  for (const context of [
    null,
    { contentId: "Example", width: 300, height: 250 },
  ]) {
    const harness = recordingSourceHarness();
    await harness.sandbox.openAdRecordings(context);
    assert.equal(harness.errors.length, 0);
    assert.equal(harness.requests[0].action, "openRecording");
    assert.equal(harness.requests[0].jobs[0].width, 300);
    assert.equal(harness.requests[0].jobs[0].height, 250);
    assert.equal(harness.revoked.length, 0);
    harness.release("session-1");
    assert.deepEqual(harness.revoked, [
      "blob:https://create.choreograph.com/preview-1",
    ]);
  }
});

test("bulk and single-ad buttons prepare a selection without requesting auto-start", async () => {
  const harness = recordingSourceHarness();
  await harness.sandbox.openAdRecordings();
  assert.equal(harness.requests[0].autoStart, undefined);
  const single = recordingSourceHarness();
  await single.sandbox.openAdRecordings({
    contentId: "Example",
    width: 300,
    height: 250,
  });
  assert.equal(single.requests[0].autoStart, undefined);
});

test("the top record click requests its panel before settings or variant fetches", async () => {
  const harness = recordingSourceHarness();
  const pending = harness.sandbox.openAdRecordings();
  assert.deepEqual(harness.calls, ["openRecordingPanel"]);
  await pending;
  assert.deepEqual(harness.calls, [
    "openRecordingPanel",
    "storage",
    "variants",
    "openRecording",
  ]);
});

test("panel-opening failures stop batch preparation and return a useful error", async () => {
  const background = recordingBackgroundHarness();
  background.sandbox.chrome.sidePanel.open = async () => {
    throw new Error("Panel opening blocked");
  };
  const response = await background.request(
    { action: "openRecordingPanel" },
    background.sender,
  );
  assert.equal(response.success, false);
  assert.match(response.error, /Panel opening blocked/);
  const source = recordingSourceHarness();
  source.sandbox.runtimeSend = async () => response;
  await source.sandbox.openAdRecordings();
  assert.equal(source.calls.length, 0);
  assert.equal(source.requests.length, 0);
  assert.match(source.errors[0], /Panel opening blocked/);
});

test("empty selections do not launch a recorder and failed launches release blobs", async () => {
  const empty = recordingSourceHarness();
  empty.selected.length = 0;
  await empty.sandbox.openAdRecordings();
  assert.equal(empty.requests.length, 0);
  assert.match(empty.errors[0], /Select at least one/);
  const failed = recordingSourceHarness();
  failed.sandbox.runtimeSend = async (message) =>
    message.action === "openRecordingPanel"
      ? { success: true }
      : { success: false, error: "Recorder unavailable" };
  await failed.sandbox.openAdRecordings();
  assert.deepEqual(failed.revoked, [
    "blob:https://create.choreograph.com/preview-1",
  ]);
  assert.match(failed.errors[0], /Recorder unavailable/);
});

function recordingPreviewHarness({
  tabUrl,
  documentUrl,
  readyState = "interactive",
  range,
  labels = {},
} = {}) {
  const job = {
    blobUrl: "blob:https://create.choreograph.com/preview-1",
    width: 300,
    height: 250,
  };
  const waits = [];
  let pauses = 0;
  const positions = [];
  const navigations = [];
  const markers = new Map();
  const session = { id: "session-1", captureTabId: 30, jobs: [job], range };
  const preview = {
    location: { href: documentUrl || job.blobUrl },
    document: {
      readyState,
      title: "",
      documentElement: {
        style: {},
        append(marker) {
          markers.set(marker.id, marker);
        },
      },
      body: { style: {} },
      fonts: { status: "loaded" },
      images: [],
      querySelector: () => null,
      getElementById: (id) => markers.get(id),
      querySelectorAll: () => [],
      createElement() {
        return {
          style: {},
          setAttribute() {},
          remove() {
            markers.delete(this.id);
          },
          getBoundingClientRect() {
            return {
              left: preview.innerWidth - 20,
              top: preview.innerHeight - 20,
              width: 16,
              height: 16,
            };
          },
        };
      },
    },
    innerWidth: 640,
    innerHeight: 480,
    devicePixelRatio: 2,
    requestAnimationFrame(callback) {
      callback();
    },
    addEventListener() {},
    window: {
      Creative: {
        timeline: {
          labels,
          paused: () => false,
          time: () => 1,
          pause(value) {
            pauses++;
            positions.push(value);
          },
          play(value) {
            positions.push(value);
          },
        },
      },
    },
  };
  const sandbox = {
    console,
    setTimeout,
    Date,
    RecordingCore: require("../recording/recording-core.js"),
    chrome: {
      storage: {
        session: {
          async get() {
            return { "coPlusRecording:session-1": session };
          },
          async set(values) {
            Object.assign(session, values["coPlusRecording:session-1"]);
          },
        },
      },
      tabs: {
        async update(_id, options) {
          navigations.push(options.url);
        },
        async get() {
          return { status: "loading", url: tabUrl || job.blobUrl };
        },
      },
      scripting: {
        async executeScript({ func, args }) {
          preview.args = args || [];
          return [
            {
              result: await vm.runInNewContext(
                `(${func.toString()})(...args)`,
                preview,
              ),
            },
          ];
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "../recording/recording-host.js"),
      "utf8",
    ),
    sandbox,
  );
  sandbox.waitForRecordingPreview = async (
    _id,
    predicate,
    _timeout,
    message,
  ) => {
    waits.push(message);
    if (!(await predicate({ captureTabId: 30 }))) throw new Error(message);
  };
  sandbox.preparePreview = () =>
    sandbox.prepareRecordingPreview("session-1", 0);
  sandbox.measurePreview = () =>
    sandbox.measureRecordingPreview("session-1", 0);
  return {
    sandbox,
    job,
    waits,
    preview,
    positions,
    navigations,
    pauses: () => pauses,
  };
}

test("preview preparation accepts an interactive document while Chrome is still loading subresources", async () => {
  const harness = recordingPreviewHarness();
  const bounds = await harness.sandbox.preparePreview(harness.job);
  assert.equal(bounds.width, 300);
  assert.equal(bounds.height, 250);
  assert.equal(harness.pauses(), 1);
  assert.match(harness.waits[0], /preview document/);
});

test("preview preparation rejects the old document during navigation", async () => {
  for (const state of [
    { tabUrl: "about:blank" },
    { documentUrl: "about:blank" },
    { readyState: "loading" },
  ]) {
    const harness = recordingPreviewHarness(state);
    await assert.rejects(
      harness.sandbox.preparePreview(harness.job),
      /preview document did not open/,
    );
    assert.equal(harness.pauses(), 0);
  }
});

test("same-URL reload waits for a new document instead of accepting the old frame", async () => {
  const harness = recordingPreviewHarness();
  const execute = harness.sandbox.chrome.scripting.executeScript;
  let calls = 0;
  let checks = 0;
  harness.sandbox.chrome.scripting.executeScript = async (options) => {
    const results = await execute(options);
    calls++;
    results[0].documentId = calls <= 2 ? "old-document" : "new-document";
    return results;
  };
  harness.sandbox.waitForRecordingPreview = async (
    _id,
    predicate,
    _timeout,
    message,
  ) => {
    if (checks === 0) {
      checks++;
      assert.equal(await predicate({ captureTabId: 30 }), false);
      assert.equal(await predicate({ captureTabId: 30 }), true);
      return;
    }
    if (!(await predicate({ captureTabId: 30 }))) throw new Error(message);
  };
  const bounds = await harness.sandbox.preparePreview();
  assert.equal(bounds.width, 300);
  assert.equal(harness.pauses(), 1);
});

test("a new preview navigates away from about:blank before attempting script injection", async () => {
  const harness = recordingPreviewHarness();
  const execute = harness.sandbox.chrome.scripting.executeScript;
  let navigated = false;
  harness.sandbox.chrome.tabs.get = async () => ({
    url: navigated ? harness.job.blobUrl : "about:blank",
  });
  harness.sandbox.chrome.tabs.update = async () => {
    navigated = true;
  };
  harness.sandbox.chrome.scripting.executeScript = async (options) => {
    assert.equal(navigated, true);
    return execute(options);
  };
  const bounds = await harness.sandbox.preparePreview();
  assert.equal(bounds.width, 300);
});

test("readiness retries transient removed frames but does not hide permission errors", async () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../recording/recording-host.js"),
    "utf8",
  );
  const sandbox = {
    Date,
    setTimeout(resolve) {
      resolve();
    },
    async getRecordingSession() {
      return { id: "session-1" };
    },
  };
  vm.runInNewContext(
    source.slice(
      source.indexOf("function recordingFrameWasRemoved"),
      source.indexOf("async function executeRecordingPreview"),
    ),
    sandbox,
  );
  let calls = 0;
  await sandbox.waitForRecordingPreview(
    "session-1",
    async () => {
      if (++calls === 1) throw new Error("Frame with ID 0 was removed.");
      return true;
    },
    1000,
    "Timed out",
  );
  assert.equal(calls, 2);
  await assert.rejects(
    sandbox.waitForRecordingPreview(
      "session-1",
      async () => {
        throw new Error("Cannot access contents of the page");
      },
      1000,
      "Timed out",
    ),
    /Cannot access contents/,
  );
  sandbox.getRecordingSession = async () => ({ cancelled: true });
  await assert.rejects(
    sandbox.waitForRecordingPreview(
      "session-1",
      async () => true,
      1000,
      "Timed out",
    ),
    /cancelled/,
  );
  let now = 0;
  sandbox.Date = { now: () => now };
  sandbox.setTimeout = (resolve, delay) => {
    now += delay;
    resolve();
  };
  sandbox.getRecordingSession = async () => ({});
  calls = 0;
  await assert.rejects(
    sandbox.waitForRecordingPreview(
      "session-1",
      async () => {
        calls++;
        throw new Error("Frame with ID 0 was removed.");
      },
      200,
      "Timed out",
    ),
    /Timed out/,
  );
  assert.equal(calls, 2);
});

test("a loaded creative without Creative or a timeline is ready for seconds-only recording", async () => {
  const harness = recordingPreviewHarness({
    readyState: "complete",
    range: recordingRange(
      { type: "seconds", value: 2 },
      { type: "seconds", value: 5 },
    ),
  });
  delete harness.preview.window.Creative;
  await harness.sandbox.preparePreview();
  const session = await harness.sandbox.getRecordingSession("session-1");
  assert.equal(session.playbackMode, "realtime");
  const clip = await harness.sandbox.resolveRecordingPreviewRange("session-1");
  assert.equal(clip.realTime, true);
  assert.equal(clip.start, 2);
  assert.equal(clip.duration, 3);
  const playback = await harness.sandbox.resumeRecordingPreview("session-1");
  assert.equal(harness.navigations.length, 2);
  assert.equal(playback.realTime, true);
  assert.equal(typeof playback.startedAt, "number");
  assert.equal(harness.positions.length, 0);
  await harness.sandbox.pauseRecordingPreview("session-1");
});

test("seconds-only readiness still waits for the document and assets", async () => {
  for (const state of ["document", "fonts", "images"]) {
    const harness = recordingPreviewHarness({ readyState: "complete" });
    delete harness.preview.window.Creative;
    if (state === "document")
      harness.preview.document.readyState = "interactive";
    if (state === "fonts") harness.preview.document.fonts.status = "loading";
    if (state === "images")
      harness.preview.document.images = [{ complete: false }];
    await assert.rejects(
      harness.sandbox.preparePreview(),
      /did not finish loading/,
    );
  }
});

test("creatives without a timeline reject frame endpoints with a seconds-specific error", async () => {
  const harness = recordingPreviewHarness({
    readyState: "complete",
    range: recordingRange(
      { type: "frame", value: 2 },
      { type: "seconds", value: 5 },
    ),
  });
  delete harness.preview.window.Creative;
  await assert.rejects(
    harness.sandbox.resolveRecordingPreviewRange("session-1"),
    /Choose seconds for both Start and End/,
  );
});

test("preview crop is remeasured after opening the toolbar side panel", async () => {
  const harness = recordingPreviewHarness();
  await harness.sandbox.preparePreview(harness.job);
  harness.preview.innerHeight -= 40;
  const bounds = await harness.sandbox.measurePreview(harness.job);
  assert.equal(bounds.viewportHeight, 440);
});

test("preview geometry measures the creative offset and removes iframe borders", async () => {
  const harness = recordingPreviewHarness();
  const frame = {
    style: {},
    getBoundingClientRect() {
      const transform = harness.preview.document.body.style.transform;
      const scale = transform === "none" ? 1 : Number(transform.slice(6, -1));
      return {
        left: 7.25 * scale,
        top: 4.5 * scale,
        width: 300 * scale,
        height: 250 * scale,
        right: 307.25 * scale,
        bottom: 254.5 * scale,
      };
    },
  };
  harness.preview.document.querySelector = (selector) =>
    selector === "ins iframe" ? frame : null;
  const bounds = await harness.sandbox.measurePreview(harness.job);
  assert.equal(bounds.left, 7.25);
  assert.equal(bounds.top, 4.5);
  assert.equal(bounds.width, 300);
  assert.equal(frame.style.border, "0");
  harness.preview.innerWidth = 200;
  const resized = await harness.sandbox.measurePreview(harness.job);
  assert(Math.abs(resized.left + resized.width - 176) < 0.000001);
  assert(resized.top > 0);
});

test("2x recordings enlarge the preview on 1x displays and stay native on Retina", async () => {
  const harness = recordingPreviewHarness();
  const frame = {
    style: {},
    getBoundingClientRect() {
      const transform = harness.preview.document.body.style.transform;
      const scale = transform === "none" ? 1 : Number(transform.slice(6, -1));
      return {
        left: 0,
        top: 0,
        width: 300 * scale,
        height: 250 * scale,
        right: 300 * scale,
        bottom: 250 * scale,
      };
    },
  };
  harness.preview.document.querySelector = (selector) =>
    selector === "ins iframe" ? frame : null;
  harness.preview.innerHeight = 1000;
  await harness.sandbox.chrome.storage.session.set({
    "coPlusRecording:session-1": { scale: 2 },
  });
  assert.equal((await harness.sandbox.measurePreview(harness.job)).width, 300);
  harness.preview.devicePixelRatio = 1;
  assert.equal((await harness.sandbox.measurePreview(harness.job)).width, 600);
});

test("frame ranges seek and resume at each size's actual label time instead of restarting at zero", async () => {
  const harness = recordingPreviewHarness({
    range: recordingRange(
      { type: "frame", value: 2 },
      { type: "frame", value: 4 },
    ),
    labels: { "frame2-preview": 3.5, "frame4-preview": 9 },
  });
  const clip = await harness.sandbox.resolveRecordingPreviewRange("session-1");
  assert.equal(clip.start, 3.5);
  assert.equal(clip.end, 9);
  assert.equal(clip.duration, 5.5);
  const playback = await harness.sandbox.resumeRecordingPreview("session-1");
  assert.equal(typeof playback.startedAt, "number");
  await harness.sandbox.pauseRecordingPreview("session-1");
  assert.deepEqual(harness.positions, [3.5, 3.5, 9]);
});

test("start-frame synchronization uses a fresh marker outside the exported creative", async () => {
  const harness = recordingPreviewHarness();
  harness.job.width = 640;
  harness.job.height = 480;
  const bounds = await harness.sandbox.measurePreview(harness.job);
  const first = await harness.sandbox.resolveRecordingPreviewRange("session-1");
  const second =
    await harness.sandbox.resolveRecordingPreviewRange("session-1");
  assert.notDeepEqual(first.syncMarker.color, second.syncMarker.color);
  const marker = second.syncMarker;
  assert(
    bounds.left + bounds.width <= marker.left ||
      bounds.top + bounds.height <= marker.top,
  );
  assert.equal(marker.width, 16);
  assert.equal(marker.height, 16);
});

test("a missing or reversed frame endpoint fails before playback", async () => {
  const range = recordingRange(
    { type: "frame", value: 2 },
    { type: "frame", value: 4 },
  );
  for (const labels of [
    { "frame2-preview": 3 },
    { "frame2-preview": 10, "frame4-preview": 4 },
  ]) {
    const harness = recordingPreviewHarness({ range, labels });
    await assert.rejects(
      harness.sandbox.resolveRecordingPreviewRange("session-1"),
    );
    assert.equal(harness.positions.length, 0);
  }
});

function captureVerificationHarness() {
  const state = { muted: false, readyState: "live", polls: 0 };
  const track = {
    get readyState() {
      return state.readyState;
    },
    get muted() {
      return state.muted;
    },
  };
  const sandbox = {
    captureTab: { id: 30 },
    authorizedCaptureTabId: 30,
    captureFailure: null,
    sharedStream: { getVideoTracks: () => [track] },
    async waitFor(predicate, _timeout, message) {
      for (let attempt = 0; attempt < 3; attempt++) {
        state.polls++;
        if (await predicate()) return;
        if (state.unmute) state.muted = false;
      }
      throw new Error(message);
    },
  };
  const source = fs.readFileSync(
    path.join(__dirname, "../recording/recorder.js"),
    "utf8",
  );
  vm.runInNewContext(
    source.slice(
      source.indexOf("function verifyCapture"),
      source.indexOf("async function recordAd"),
    ),
    sandbox,
  );
  return { sandbox, state };
}

test("capture verification waits for the authorized tab to unmute after navigation", async () => {
  const harness = captureVerificationHarness();
  harness.state.muted = true;
  harness.state.unmute = true;
  await harness.sandbox.waitForCapture();
  assert.equal(harness.state.polls, 2);
  assert.equal(harness.sandbox.verifyCapture(), true);
});

test("capture verification rejects unauthorized tabs, ended streams, and resized previews", async () => {
  for (const values of [
    { authorizedCaptureTabId: 99 },
    { captureFailure: new Error("Preview resized") },
    { captureTab: null },
  ]) {
    const harness = captureVerificationHarness();
    Object.assign(harness.sandbox, values);
    await assert.rejects(harness.sandbox.waitForCapture());
    assert.equal(harness.state.polls, 1);
  }
  const ended = captureVerificationHarness();
  ended.state.readyState = "ended";
  await assert.rejects(ended.sandbox.waitForCapture(), /capture has stopped/);
});

test("tab capture does not depend on desktop-sharing metadata or Capture Handle", async () => {
  const harness = captureVerificationHarness();
  await harness.sandbox.waitForCapture();
  assert.equal(harness.sandbox.verifyCapture(), true);
  harness.state.muted = true;
  await assert.rejects(harness.sandbox.waitForCapture(), /not ready/);
});

function captureFrameHarness() {
  const state = {
    frames: 1,
    readyState: 2,
    polls: 0,
    cancelled: false,
    verified: true,
    pixel: [255, 255, 255, 255],
  };
  const sandbox = {
    recordingCrop,
    document: {
      createElement() {
        return {
          getContext() {
            return {
              drawImage() {},
              getImageData: () => ({ data: state.pixel }),
            };
          },
        };
      },
    },
    ui: {
      capture: {
        get readyState() {
          return state.readyState;
        },
        videoWidth: 800,
        videoHeight: 600,
        getVideoPlaybackQuality: () => ({ totalVideoFrames: state.frames }),
        requestVideoFrameCallback() {
          throw new Error("A paused creative may not deliver another frame.");
        },
      },
    },
    verifyCapture: () => state.verified,
    async waitFor(predicate, _timeout, message) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (state.cancelled) throw new Error("Recording cancelled.");
        state.polls++;
        if (await predicate()) return;
        if (state.deliverFrame) state.frames++;
        if (state.deliverMarker) state.pixel = [96, 32, 32, 255];
      }
      throw new Error(message);
    },
  };
  const source = fs.readFileSync(
    path.join(__dirname, "../recording/recorder.js"),
    "utf8",
  );
  vm.runInNewContext(
    source.slice(
      source.indexOf("async function nextCaptureFrame"),
      source.indexOf("async function preparePreview"),
    ),
    sandbox,
  );
  return { sandbox, state };
}

test("a paused second ad accepts the frame already delivered during navigation", async () => {
  const harness = captureFrameHarness();
  await harness.sandbox.nextCaptureFrame(0);
  const beforeNavigation = harness.state.frames;
  harness.state.frames++;
  await harness.sandbox.nextCaptureFrame(beforeNavigation);
  assert.equal(harness.state.polls, 2);
});

test("the second ad cannot reuse a stale frame from the first ad", async () => {
  const harness = captureFrameHarness();
  await assert.rejects(
    harness.sandbox.nextCaptureFrame(harness.state.frames),
    /next ad/,
  );
  harness.state.deliverFrame = true;
  harness.state.polls = 0;
  await harness.sandbox.nextCaptureFrame(harness.state.frames);
  assert.equal(harness.state.polls, 2);
});

test("frame readiness still requires decoded data, capture verification, and no cancellation", async () => {
  for (const state of [
    { readyState: 1 },
    { verified: false },
    { cancelled: true },
  ]) {
    const harness = captureFrameHarness();
    Object.assign(harness.state, state);
    await assert.rejects(harness.sandbox.nextCaptureFrame(0));
  }
});

test("the selected-start marker rejects an already-decoded loaded-state frame", async () => {
  const harness = captureFrameHarness();
  harness.state.frames = 100;
  const marker = {
    left: 780,
    top: 580,
    width: 16,
    height: 16,
    viewportWidth: 800,
    viewportHeight: 600,
    color: [96, 32, 32],
  };
  await assert.rejects(
    harness.sandbox.nextCaptureFrame(0, marker),
    /selected start frame/,
  );
  harness.state.polls = 0;
  harness.state.deliverMarker = true;
  await harness.sandbox.nextCaptureFrame(0, marker);
  assert.equal(harness.state.polls, 2);
});

test("an already-delivered selected frame is accepted without waiting for another static frame", async () => {
  const harness = captureFrameHarness();
  harness.state.pixel = [98, 31, 34, 255];
  const marker = {
    left: 780,
    top: 580,
    width: 16,
    height: 16,
    viewportWidth: 800,
    viewportHeight: 600,
    color: [96, 32, 32],
  };
  await harness.sandbox.nextCaptureFrame(harness.state.frames, marker);
  assert.equal(harness.state.polls, 1);
});

test("an offscreen two-size batch completes without any visible interface or non-runtime Chrome APIs", async () => {
  const harness = captureFrameHarness();
  const statuses = [];
  const recordedSizes = [];
  const recordedDurations = [];
  const downloads = [];
  const hostOperations = [];
  const jobs = [
    { name: "Example", width: 300, height: 250 },
    { name: "Example", width: 728, height: 90 },
  ];
  const track = { addEventListener() {}, stop() {} };
  const sandbox = Object.assign(harness.sandbox, {
    console,
    AbortController,
    MediaRecorder: {},
    crypto: { randomUUID: () => "authorization-1" },
    sessionId: "session-1",
    running: false,
    cancelled: false,
    captureTab: { id: 3 },
    session: { jobs },
    files: [],
    selectRecordingType: () => 'video/mp4;codecs="avc1.42001E"',
    recordingOptions,
    recordingFileName,
    async acquireTabCapture({ onWaiting }) {
      await onWaiting();
      return { getVideoTracks: () => [track], getTracks: () => [track] };
    },
    chrome: { runtime: {} },
    checkCancelled() {
      if (sandbox.cancelled) throw new Error("Recording cancelled.");
    },
    cancelRecording() {},
    async waitForCapture() {},
    async setStatus(value) {
      statuses.push(value);
    },
    async measurePreview(job) {
      return { width: job.width, height: job.height };
    },
    async preparePreview() {
      harness.state.frames++;
    },
    async recordAd(job, _bounds, _type, options) {
      recordedDurations.push(options.duration);
      recordedSizes.push(`${job.width}x${job.height}`);
      return new Blob(["recording"]);
    },
    async offerDownload() {
      downloads.push(...sandbox.files);
    },
    async recordingHost(operation) {
      hostOperations.push(operation);
      if (operation === "range")
        return {
          start: 2,
          end: 3 + recordedSizes.length,
          duration: 1 + recordedSizes.length,
        };
    },
  });
  sandbox.ui.capture.play = async () => {};
  const source = fs.readFileSync(
    path.join(__dirname, "../recording/recorder.js"),
    "utf8",
  );
  vm.runInNewContext(
    source.slice(
      source.indexOf("async function runRecording"),
      source.indexOf("function configureRecording"),
    ),
    sandbox,
  );
  await sandbox.runRecording(1);
  assert.deepEqual(recordedSizes, ["300x250", "728x90"]);
  assert.deepEqual(recordedDurations, [1, 2]);
  assert.equal(downloads.length, 2);
  assert.equal(statuses.at(-1), "Done");
  assert.deepEqual(hostOperations, ["range", "range", "closePreview"]);
});

test("the encoder initializes with only runtime and adapts geometry without cancelling when the panel closes", () => {
  const elements = [];
  let listener;
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    RecordingCore: require("../recording/recording-core.js"),
    MediaRecorder: { isTypeSupported: () => true },
    navigator: { mediaDevices: { getUserMedia() {} } },
    document: {
      getElementById(id) {
        elements.push(id);
        return {};
      },
    },
    chrome: {
      runtime: {
        id: "co-plus",
        onMessage: {
          addListener(value) {
            listener = value;
          },
        },
      },
    },
    URL: { revokeObjectURL() {} },
  };
  const source = fs.readFileSync(
    path.join(__dirname, "../recording/recorder.js"),
    "utf8",
  );
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("const {")), sandbox);
  sandbox.configureRecording({
    id: "session-1",
    captureTabId: 30,
    jobs: [{ name: "Example", width: 300, height: 250 }],
  });
  assert.deepEqual(elements, ["capture", "canvas"]);
  assert.equal(typeof listener, "function");
  sandbox.testBounds = {
    width: 300,
    height: 250,
    viewportWidth: 800,
    viewportHeight: 600,
  };
  vm.runInContext("activeBounds = testBounds; running = true;", sandbox);
  listener(
    {
      target: "recording-engine",
      action: "recordingPreviewGeometry",
      id: "session-1",
      bounds: {
        width: 300,
        height: 250,
        viewportWidth: 1100,
        viewportHeight: 600,
      },
    },
    { id: "co-plus" },
    () => {},
  );
  assert.equal(sandbox.testBounds.viewportWidth, 1100);
  assert.equal(vm.runInContext("cancelled", sandbox), false);
});

function tabAcquisitionHarness() {
  const listeners = new Set();
  const requests = [];
  const controller = new AbortController();
  const state = { stopped: false, waiting: false };
  const stream = {
    getTracks: () => [
      {
        stop() {
          state.stopped = true;
        },
      },
    ],
  };
  const sender = { id: "co-plus" };
  const result = {
    action: "recordingTabCaptureResult",
    id: "session-1",
    authorization: "authorization-1",
    captureTabId: 30,
    streamId: "tab-stream-1",
  };
  const chromeApi = {
    runtime: {
      id: "co-plus",
      onMessage: {
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        },
      },
    },
  };
  const mediaDevices = {
    async getUserMedia(options) {
      requests.push(options);
      return stream;
    },
  };
  const options = {
    sessionId: "session-1",
    authorization: "authorization-1",
    previewTabId: 30,
    previewWindowId: 3,
    signal: controller.signal,
    async onWaiting() {
      state.waiting = true;
    },
    chromeApi,
    mediaDevices,
  };
  return {
    listeners,
    requests,
    controller,
    state,
    stream,
    options,
    result,
    sender,
    reply(message = result, from = sender) {
      listeners.forEach((listener) => listener(message, from));
    },
  };
}

test("tab acquisition consumes only the authorized token as muted tab video", async () => {
  const { acquireTabCapture } = await import("../recording/tab-capture.mjs");
  const harness = tabAcquisitionHarness();
  const pending = acquireTabCapture(harness.options);
  harness.reply();
  assert.equal(await pending, harness.stream);
  assert.equal(harness.state.waiting, true);
  const constraints = harness.requests.find((request) => request.video);
  assert.equal(constraints.audio, false);
  assert.equal(constraints.video.mandatory.chromeMediaSource, "tab");
  assert.equal(constraints.video.mandatory.chromeMediaSourceId, "tab-stream-1");
  const { minWidth, minHeight, maxWidth, maxHeight } =
    constraints.video.mandatory;
  assert.ok(
    minWidth > 1 && minHeight > 1 && maxWidth < 8192 && maxHeight < 8192,
  );
  assert.notEqual(
    Math.floor((100 * minWidth) / minHeight),
    Math.floor((100 * maxWidth) / maxHeight),
  );
  assert.equal(harness.listeners.size, 0);
});

test("tab acquisition ignores foreign, stale, and wrong-target authorization messages", async () => {
  const { acquireTabCapture } = await import("../recording/tab-capture.mjs");
  const harness = tabAcquisitionHarness();
  const pending = acquireTabCapture(harness.options);
  harness.reply(harness.result, { id: "another-extension" });
  harness.reply(harness.result, { id: "co-plus", tab: { id: 30 } });
  harness.reply({ ...harness.result, id: "another-session" });
  harness.reply({ ...harness.result, authorization: "old-authorization" });
  harness.reply({ ...harness.result, captureTabId: 99 });
  assert.equal(
    harness.requests.some((request) => request.video),
    false,
  );
  harness.reply();
  assert.equal(await pending, harness.stream);
});

test("cancelling toolbar authorization removes listeners and acquires no media", async () => {
  const { acquireTabCapture } = await import("../recording/tab-capture.mjs");
  const harness = tabAcquisitionHarness();
  const pending = acquireTabCapture(harness.options);
  harness.controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(harness.listeners.size, 0);
  assert.equal(
    harness.requests.some((request) => request.video),
    false,
  );
});

test("a stream that arrives after cancellation is stopped immediately", async () => {
  const { acquireTabCapture } = await import("../recording/tab-capture.mjs");
  const harness = tabAcquisitionHarness();
  harness.options.mediaDevices.getUserMedia = async () => {
    harness.controller.abort();
    return harness.stream;
  };
  const pending = acquireTabCapture(harness.options);
  harness.reply();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(harness.state.stopped, true);
  assert.equal(harness.listeners.size, 0);
});

test("permission errors do not request desktop capture or leave a waiting listener", async () => {
  const { acquireTabCapture } = await import("../recording/tab-capture.mjs");
  const harness = tabAcquisitionHarness();
  const pending = acquireTabCapture(harness.options);
  harness.reply({
    ...harness.result,
    error: "Capture blocked by administrator",
  });
  await assert.rejects(pending, /blocked by administrator/);
  assert.equal(
    harness.requests.some((request) => request.video),
    false,
  );
  assert.equal(harness.listeners.size, 0);
  delete harness.options.chromeApi.runtime;
  await assert.rejects(
    acquireTabCapture(harness.options),
    /allow its tab-capture permission/,
  );
});

test("recording uses tab-only permissions and never requests desktop sharing", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"),
  );
  assert(manifest.permissions.includes("tabCapture"));
  assert(!manifest.permissions.includes("desktopCapture"));
  for (const filename of [
    "recording/recorder.js",
    "recording/tab-capture.mjs",
    "recording/recording-background.js",
  ]) {
    assert(
      !fs
        .readFileSync(path.join(__dirname, "..", filename), "utf8")
        .includes("getDisplayMedia"),
    );
  }
});

test("concurrent recording initialization creates only one offscreen document", async () => {
  const created = [];
  const sandbox = {
    chrome: {
      runtime: {
        getURL: (value) => `chrome-extension://co-plus/${value}`,
        async getContexts() {
          return [];
        },
      },
      offscreen: {
        async createDocument(options) {
          created.push(options);
        },
      },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../recording/recording-host.js"),
      "utf8",
    ),
    sandbox,
  );
  await Promise.all([
    sandbox.ensureRecordingDocument(),
    sandbox.ensureRecordingDocument(),
  ]);
  assert.equal(created.length, 1);
  assert.equal(created[0].url, "recording/recorder.html");
  assert(created[0].reasons.includes("USER_MEDIA"));
  assert(created[0].reasons.includes("BLOBS"));
  sandbox.chrome.runtime.getContexts = async () => [
    { contextType: "OFFSCREEN_DOCUMENT" },
  ];
  await sandbox.ensureRecordingDocument();
  assert.equal(created.length, 1);
});

test("side-panel commands start, prevent duplicate starts, and cancel the offscreen batch", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  assert.equal((await harness.command("start")).success, true);
  assert(
    harness.messages.some(
      (message) =>
        message.target === "recording-engine" &&
        message.action === "startRecording" &&
        message.duration === 15,
    ),
  );
  assert.equal((await harness.command("start")).success, false);
  assert.equal((await harness.command("clear")).success, false);
  assert.equal((await harness.command("cancel")).success, true);
  assert(
    harness.messages.some((message) => message.action === "cancelRecording"),
  );
});

test("concurrent Start requests cannot launch duplicate batches", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  const responses = await Promise.all([
    harness.command("start"),
    harness.command("start"),
  ]);
  assert.equal(responses.filter((response) => response.success).length, 1);
  assert.equal(
    harness.messages.filter((message) => message.action === "startRecording")
      .length,
    1,
  );
});

test("repeating a finished selection creates a fresh preview but no interface tab", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  await harness.command("start");
  Object.assign(harness.stored["coPlusRecording:session-1"], {
    status: "Done",
    captureTabId: null,
  });
  assert.equal((await harness.command("start")).success, true);
  const tabs = harness.messages.filter((message) => message.url);
  assert.equal(tabs.length, 2);
  assert(tabs.every((tab) => tab.url === "about:blank"));
});

test("page scripts cannot impersonate panel commands or offscreen progress", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  for (const action of ["recordingCommand", "recordingHost"]) {
    const response = await harness.request(
      {
        action,
        command: "clear",
        operation: "status",
        id: "session-1",
        status: "Done",
        completed: 1,
      },
      { id: "co-plus", tab: { id: 10 }, url: harness.sender.url },
    );
    assert.equal(response.success, false);
  }
  assert(harness.stored["coPlusRecording:session-1"]);
});

test("offscreen download metadata survives panel closure and rejects foreign URLs", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  const sender = {
    id: "co-plus",
    url: "chrome-extension://co-plus/recording/recorder.html",
  };
  const message = {
    action: "recordingHost",
    operation: "download",
    id: "session-1",
    download: {
      url: "blob:chrome-extension://co-plus/recording-download",
      name: "Example_300x250.mp4",
    },
  };
  assert.equal((await harness.request(message, sender)).success, true);
  harness.close(99);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    harness.stored["coPlusRecording:session-1"].download.name,
    "Example_300x250.mp4",
  );
  assert.equal(
    (
      await harness.request(
        {
          ...message,
          download: { url: "https://example.com/file.mp4", name: "file.mp4" },
        },
        sender,
      )
    ).success,
    false,
  );
});

async function panelNavigationHarness(initial = {}) {
  const selected = [];
  const listeners = [];
  const sandbox = {
    console,
    setActiveTab(tab) {
      selected.push(tab);
    },
    chrome: {
      windows: {
        async getCurrent() {
          return { id: 1 };
        },
      },
      storage: {
        onChanged: {
          addListener(listener) {
            listeners.push(listener);
          },
        },
        session: {
          async get() {
            return initial;
          },
        },
      },
    },
  };
  const source = fs.readFileSync(
    path.join(__dirname, "../panel/panel.js"),
    "utf8",
  );
  vm.runInNewContext(
    source.slice(
      source.indexOf("function wirePanelNavigation"),
      source.indexOf("function wireTabs"),
    ),
    sandbox,
  );
  sandbox.wirePanelNavigation();
  await new Promise((resolve) => setImmediate(resolve));
  return {
    selected,
    notify(windowId = 1, area = "session") {
      listeners.forEach((listener) =>
        listener(
          {
            [`coPlusPanelNavigation:${windowId}`]: {
              newValue: { tab: "t-recordings", requestId: "new-click" },
            },
          },
          area,
        ),
      );
    },
  };
}

test("a newly opened panel restores the requested Recordings tab before a batch exists", async () => {
  const panel = await panelNavigationHarness({
    "coPlusPanelNavigation:1": {
      tab: "t-recordings",
      requestId: "record-click",
    },
  });
  assert.deepEqual(panel.selected, ["t-recordings"]);
});

test("an already-open panel switches to Recordings only for its own window's click", async () => {
  const panel = await panelNavigationHarness();
  assert.deepEqual(panel.selected, []);
  panel.notify(2);
  panel.notify(1, "sync");
  assert.deepEqual(panel.selected, []);
  panel.notify();
  assert.deepEqual(panel.selected, ["t-recordings"]);
});

function recordingPanelHarness(record, options = {}) {
  const elements = new Map();
  const commands = [];
  const changed = [];
  const state = { record, frames: options.frames || {}, saved: [] };
  const element = () => ({
    checked: true,
    value: "15",
    disabled: false,
    hidden: false,
    children: [],
    listeners: {},
    textContent: "",
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    replaceChildren() {
      this.children = [];
    },
    append(...values) {
      this.children.push(...values);
    },
    removeAttribute(name) {
      delete this[name];
    },
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const publish = () =>
    changed.forEach((listener) =>
      listener({ "coPlusRecording:session-1": {} }, "session"),
    );
  const sandbox = {
    console,
    Date,
    setInterval: () => 1,
    clearInterval() {},
    RecordingCore: require("../recording/recording-core.js"),
    document: {
      getElementById: get,
      createElement(tag) {
        if (tag !== "option")
          throw new Error("Recording progress must not render a variant list.");
        return element();
      },
    },
    setActiveTab() {},
    toggleGroup() {},
    chrome: {
      storage: {
        sync: {
          get(_defaults, callback) {
            callback({
              recordingsEnabled: true,
              recordingDuration: 15,
              ...options.settings,
            });
          },
          async set(values) {
            state.saved.push(values);
          },
        },
        session: {
          async get() {
            return state.record
              ? { "coPlusRecording:session-1": state.record }
              : {};
          },
        },
        onChanged: {
          addListener(listener) {
            changed.push(listener);
          },
        },
      },
      tabs: {
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} },
        async query() {
          return [
            {
              id: 10,
              url: "https://create.choreograph.com/97/advertiser/755/ad-variants",
            },
          ];
        },
        async get() {
          return {
            id: 10,
            url: "https://create.choreograph.com/97/advertiser/755/ad-variants",
          };
        },
        async sendMessage() {
          if (options.detectFrames) return options.detectFrames();
          return { success: true, sizes: state.frames };
        },
      },
      runtime: {
        async sendMessage(message) {
          commands.push(message);
          if (message.command === "start")
            state.record.status = "Awaiting toolbar authorization";
          if (message.command === "cancel") state.record.status = "Cancelled";
          if (message.command === "clear") state.record = null;
          return { success: true };
        },
      },
    },
  };
  const source = fs.readFileSync(
    path.join(__dirname, "../panel/panel.js"),
    "utf8",
  );
  vm.runInNewContext(
    source.slice(
      source.indexOf("function wireRecordings()"),
      source.indexOf('document.addEventListener("DOMContentLoaded"'),
    ),
    sandbox,
  );
  sandbox.wireRecordings();
  return {
    get,
    state,
    commands,
    publish,
    sync(values) {
      changed.forEach((listener) =>
        listener(
          Object.fromEntries(
            Object.entries(values).map(([key, newValue]) => [
              key,
              { newValue },
            ]),
          ),
          "sync",
        ),
      );
    },
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("side panel owns Start, Cancel, progress, retained downloads, and Clear", async () => {
  const record = {
    id: "session-1",
    status: "Ready",
    completed: 0,
    jobs: [{ name: "Example", width: 300, height: 250 }],
  };
  const panel = recordingPanelHarness(record);
  await panel.settle();
  assert.equal(panel.get("recordingStart").disabled, false);
  panel.get("recordingStart").listeners.click();
  await panel.settle();
  assert.equal(panel.commands[0].command, "start");
  assert.equal(
    panel.get("recordingStatus").textContent,
    "Click CO Plus to start",
  );
  assert.equal(panel.get("recordingAuthorization").hidden, false);
  assert.equal(panel.get("recordingCancel").disabled, false);
  panel.get("recordingCancel").listeners.click();
  await panel.settle();
  assert.equal(panel.commands[1].command, "cancel");
  assert.equal(panel.get("recordingAuthorization").hidden, true);
  Object.assign(record, {
    status: "Done",
    completed: 1,
    download: {
      url: "blob:chrome-extension://co-plus/file",
      name: "Example_300x250.mp4",
    },
  });
  panel.publish();
  await panel.settle();
  assert.equal(panel.get("recordingCount").textContent, "1 / 1");
  assert.equal(panel.get("recordingProgress").value, 1);
  assert.equal(panel.get("recordingDownload").hidden, false);
  const reopened = recordingPanelHarness(record);
  await reopened.settle();
  assert.equal(reopened.get("recordingDownload").href, record.download.url);
  assert.equal(reopened.commands.length, 0);
  reopened.get("recordingClear").listeners.click();
  await reopened.settle();
  assert.equal(reopened.get("recordingDownload").hidden, true);
  assert.equal(reopened.get("recordingStatus").textContent, "Idle");
});

test("recording progress shows only the active variant and done/total counts", async () => {
  const panel = recordingPanelHarness({
    id: "session-1",
    status: "Recording Summer campaign (300x250)",
    completed: 2,
    jobs: Array.from({ length: 5 }, () => ({
      name: "Summer campaign",
      width: 300,
      height: 250,
    })),
  });
  await panel.settle();
  assert.equal(
    panel.get("recordingStatus").textContent,
    "Recording Summer campaign (300x250)",
  );
  assert.equal(panel.get("recordingCount").textContent, "2 / 5");
  assert.equal(panel.get("recordingProgress").value, 2);
  assert.equal(panel.get("recordingProgress").max, 5);
  assert.equal(panel.get("recordingClip").hidden, false);
  assert.equal(panel.get("recordingClipTime").textContent, "Preparing...");
  assert.equal(panel.get("recordingClipProgress").value, undefined);
});

test("current ad progress uses the resolved clip duration for frame ranges", async () => {
  const record = {
    id: "session-1",
    status: "Recording Summer campaign (300x250)",
    completed: 0,
    jobs: [{ name: "Summer campaign", width: 300, height: 250 }],
    clipProgress: { startedAt: Date.now() - 3000, duration: 6.5 },
  };
  const panel = recordingPanelHarness(record);
  await panel.settle();
  const clip = panel.get("recordingClipProgress");
  assert.equal(clip.max, 6.5);
  assert(clip.value >= 3 && clip.value < 3.5);
  assert.match(panel.get("recordingClipTime").textContent, /^3\.\d \/ 6\.5 s$/);
  Object.assign(record, {
    status: "Finalizing Summer campaign (300x250)",
    clipProgress: null,
  });
  panel.publish();
  await panel.settle();
  assert.equal(panel.get("recordingClipTime").textContent, "Finalizing...");
  Object.assign(record, { status: "Done", completed: 1 });
  panel.publish();
  await panel.settle();
  assert.equal(panel.get("recordingClip").hidden, true);
});

test("recording endpoints default to 0 and 15 seconds and reject reversed seconds", async () => {
  const panel = recordingPanelHarness(
    { id: "session-1", status: "Ready", completed: 0, jobs: [] },
    { settings: { recordingDuration: 22 } },
  );
  await panel.settle();
  assert.equal(panel.get("recordingStartSeconds").value, "0");
  assert.equal(panel.get("recordingEndSeconds").value, "15");
  assert.equal(panel.get("recordingStartFrameMode").disabled, true);
  panel.get("recordingStartSeconds").value = "5";
  panel.get("recordingEndSeconds").value = "3";
  panel.get("recordingEndSeconds").listeners.input();
  assert.equal(panel.get("recordingStart").disabled, true);
  assert.match(
    panel.get("recordingSettingsStatus").textContent,
    /end must be after/,
  );
  panel.get("recordingEndSeconds").value = "8.5";
  panel.get("recordingEndSeconds").listeners.input();
  panel.get("recordingSave").listeners.click();
  await panel.settle();
  assert.equal(panel.state.saved[0].recordingStart.value, 5);
  assert.equal(panel.state.saved[0].recordingEnd.value, 8.5);
});

test("detected frame menus preserve real label IDs and submit mixed endpoints", async () => {
  const panel = recordingPanelHarness(
    { id: "session-1", status: "Ready", completed: 0, jobs: [] },
    { frames: { "300x250": [1, 3], "728x90": [3, 5] } },
  );
  await panel.settle();
  assert.deepEqual(
    panel.get("recordingStartFrame").children.map((option) => option.value),
    ["0", "1", "3", "5"],
  );
  assert.equal(panel.get("recordingStartFrameMode").disabled, false);
  panel.get("recordingStartMode").value = "frame";
  panel.get("recordingStartMode").listeners.change();
  panel.get("recordingStartFrame").value = "3";
  panel.get("recordingStartFrame").listeners.change();
  panel.get("recordingEndSeconds").value = "12";
  panel.get("recordingEndSeconds").listeners.input();
  panel.get("recordingStart").listeners.click();
  await panel.settle();
  assert.equal(panel.get("recordingStartSeconds").hidden, true);
  assert.deepEqual(panel.commands[0].range, {
    start: { type: "frame", value: 3 },
    end: { type: "seconds", value: 12 },
  });
});

test("saved frame endpoints restore without silently selecting the first detected frame", async () => {
  const panel = recordingPanelHarness(
    { id: "session-1", status: "Ready", completed: 0, jobs: [] },
    {
      frames: { "300x250": [1, 3, 5] },
      settings: {
        recordingStart: { type: "frame", value: 3 },
        recordingEnd: { type: "frame", value: 5 },
      },
    },
  );
  await panel.settle();
  assert.equal(panel.get("recordingStartFrame").value, "3");
  assert.equal(panel.get("recordingEndFrame").value, "5");
  assert.equal(panel.get("recordingStart").disabled, false);
});

test("an unavailable saved start frame falls back to zero seconds", async () => {
  const panel = recordingPanelHarness(
    { id: "session-1", status: "Ready", completed: 0, jobs: [] },
    {
      frames: { "300x250": [1, 3] },
      settings: {
        recordingStart: { type: "frame", value: 5 },
        recordingEnd: { type: "seconds", value: 10 },
      },
    },
  );
  await panel.settle();
  assert.equal(panel.get("recordingStartMode").value, "seconds");
  assert.equal(panel.get("recordingStartSeconds").value, "0");
  assert.equal(panel.get("recordingStart").disabled, false);
  assert(
    !panel
      .get("recordingStartFrame")
      .children.some((option) => option.textContent.includes("unavailable")),
  );
});

test("end frame options contain only frames after the selected start", async () => {
  const panel = recordingPanelHarness(
    { id: "session-1", status: "Ready", completed: 0, jobs: [] },
    { frames: { "300x250": [1, 2, 3] } },
  );
  await panel.settle();
  panel.get("recordingStartMode").value = "frame";
  panel.get("recordingStartMode").listeners.change();
  panel.get("recordingStartFrame").value = "1";
  panel.get("recordingStartFrame").listeners.change();
  panel.get("recordingEndMode").value = "frame";
  panel.get("recordingEndMode").listeners.change();
  assert.deepEqual(
    panel.get("recordingEndFrame").children.map((option) => option.value),
    ["2", "3"],
  );
  panel.get("recordingStartFrame").value = "2";
  panel.get("recordingStartFrame").listeners.change();
  assert.deepEqual(
    panel.get("recordingEndFrame").children.map((option) => option.value),
    ["3"],
  );
  assert.equal(panel.get("recordingEndFrame").value, "3");
  assert.equal(panel.get("recordingEndMode").value, "frame");
});

test("Banner start is available in the start frame menu and records from zero seconds", async () => {
  const panel = recordingPanelHarness(
    { id: "session-1", status: "Ready", completed: 0, jobs: [] },
    { frames: { "300x250": [1, 2, 3] } },
  );
  await panel.settle();
  const banner = panel.get("recordingStartFrame").children[0];
  assert.equal(banner.textContent, "Banner start");
  assert.equal(banner.value, "0");
  panel.get("recordingStartMode").value = "frame";
  panel.get("recordingStartMode").listeners.change();
  panel.get("recordingStartFrame").value = "2";
  panel.get("recordingStartFrame").listeners.change();
  panel.get("recordingStartFrame").value = "0";
  panel.get("recordingStartFrame").listeners.change();
  panel.get("recordingEndMode").value = "frame";
  panel.get("recordingEndMode").listeners.change();
  assert.deepEqual(
    panel.get("recordingEndFrame").children.map((option) => option.value),
    ["1", "2", "3"],
  );
  assert(
    !panel
      .get("recordingEndFrame")
      .children.some((option) => option.value === "0"),
  );
  panel.get("recordingEndFrame").value = "3";
  panel.get("recordingEndFrame").listeners.change();
  panel.get("recordingSave").listeners.click();
  await panel.settle();
  assert.equal(panel.state.saved[0].recordingStart.type, "seconds");
  assert.equal(panel.state.saved[0].recordingStart.value, 0);
  panel.sync(panel.state.saved[0]);
  await panel.settle();
  assert.equal(panel.get("recordingStartMode").value, "frame");
  assert.equal(panel.get("recordingStartFrame").value, "0");
  panel.get("recordingStart").listeners.click();
  await panel.settle();
  assert.deepEqual(panel.commands[0].range, {
    start: { type: "seconds", value: 0 },
    end: { type: "frame", value: 3 },
  });
});

test("an unavailable end frame or a start at the last frame falls back to fifteen seconds", async () => {
  const panel = recordingPanelHarness(
    { id: "session-1", status: "Ready", completed: 0, jobs: [] },
    {
      frames: { "300x250": [1, 2, 3] },
      settings: {
        recordingStart: { type: "frame", value: 1 },
        recordingEnd: { type: "frame", value: 5 },
      },
    },
  );
  await panel.settle();
  assert.equal(panel.get("recordingEndMode").value, "seconds");
  assert.equal(panel.get("recordingEndSeconds").value, "15");
  panel.get("recordingEndMode").value = "frame";
  panel.get("recordingEndMode").listeners.change();
  panel.get("recordingStartFrame").value = "3";
  panel.get("recordingStartFrame").listeners.change();
  assert.equal(panel.get("recordingEndMode").value, "seconds");
  assert.equal(panel.get("recordingEndFrameMode").disabled, true);
  assert.equal(panel.get("recordingEndSeconds").value, "15");
});

test("no detected labels reset saved frame endpoints to 0 and 15 seconds", async () => {
  const panel = recordingPanelHarness(
    { id: "session-1", status: "Ready", completed: 0, jobs: [] },
    {
      settings: {
        recordingStart: { type: "frame", value: 1 },
        recordingEnd: { type: "frame", value: 3 },
      },
    },
  );
  await panel.settle();
  assert.equal(panel.get("recordingStartMode").value, "seconds");
  assert.equal(panel.get("recordingEndMode").value, "seconds");
  assert.equal(panel.get("recordingStartSeconds").value, "0");
  assert.equal(panel.get("recordingEndSeconds").value, "15");
  assert.equal(panel.get("recordingStart").disabled, false);
});

test("pending detection preserves saved frames until actual labels arrive", async () => {
  let finishDetection;
  const detected = new Promise((resolve) => {
    finishDetection = resolve;
  });
  const panel = recordingPanelHarness(
    { id: "session-1", status: "Ready", completed: 0, jobs: [] },
    {
      settings: {
        recordingStart: { type: "frame", value: 2 },
        recordingEnd: { type: "frame", value: 3 },
      },
      detectFrames: () => detected,
    },
  );
  await panel.settle();
  assert.equal(panel.get("recordingStartMode").value, "frame");
  assert.equal(panel.get("recordingStartFrame").disabled, true);
  assert.equal(panel.get("recordingStart").disabled, true);
  finishDetection({ success: true, sizes: { "300x250": [1, 2, 3] } });
  await panel.settle();
  assert.equal(panel.get("recordingStartFrame").value, "2");
  assert.deepEqual(
    panel.get("recordingEndFrame").children.map((option) => option.value),
    ["3"],
  );
  assert.equal(panel.get("recordingStart").disabled, false);
});

test("waiting for the extension click highlights the icon and removes the preview prompt before capture", async () => {
  const harness = recordingBackgroundHarness();
  await harness.send();
  await harness.command("start");
  const sender = {
    id: "co-plus",
    url: "chrome-extension://co-plus/recording/recorder.html",
  };
  assert.equal(
    (
      await harness.request(
        {
          action: "recordingHost",
          operation: "status",
          id: "session-1",
          status: "Awaiting toolbar authorization",
          completed: 0,
          captureAuthorization: "authorization-1",
        },
        sender,
      )
    ).success,
    true,
  );
  assert.equal(harness.badges.at(-1).text, "GO");
  assert.match(harness.titles.at(-1).title, /Click CO Plus/);
  assert.equal(harness.prompts.at(-1).args[0], true);
  harness.sandbox.chrome.tabCapture.getMediaStreamId = async () => {
    assert.equal(harness.badges.at(-1).text, "");
    assert.equal(harness.prompts.at(-1).args[0], false);
    return "tab-stream-1";
  };
  await harness.sandbox.authorizeRecordingTab({ id: 30 });
  assert.equal(harness.titles.at(-1).title, "Open Panel");
});

function toolbarCountHarness() {
  const selected = [
    { variant: "A", sizes: ["300x250", "728x90"] },
    { variant: "B", sizes: ["300x250"] },
  ];
  const state = { observers: 0, disconnected: 0 };
  const root = { addEventListener() {}, removeEventListener() {} };
  const sandbox = {
    SEL: { variantTreeRoot: "#variant-tree-root" },
    document: {
      body: root,
      querySelector: () => root,
      getElementById: () => null,
    },
    MutationObserver: class {
      constructor() {
        state.observers++;
      }
      observe() {}
      disconnect() {
        state.disconnected++;
      }
    },
    setTimeout: () => 1,
    clearTimeout() {},
    Date,
    async extractVariantsFromPreview() {
      return selected;
    },
  };
  const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
  vm.runInNewContext(
    source.slice(
      source.indexOf("const screenshotUI ="),
      source.indexOf("// 10.3 - inject buttons"),
    ),
    sandbox,
  );
  const button = () => ({
    dataset: {},
    disabled: false,
    writes: 0,
    set innerHTML(value) {
      this.html = value;
      this.writes++;
    },
  });
  return { sandbox, state, selected, button };
}

test("recording toolbar count matches screenshot selections without rewriting unchanged buttons", async () => {
  const harness = toolbarCountHarness();
  const screenshot = harness.button();
  const recording = harness.button();
  harness.sandbox.wireScreenshotCountUpdater(screenshot);
  harness.sandbox.wireRecordingCountUpdater(recording);
  await harness.sandbox.updateScreenshotBtnCount();
  assert.equal(screenshot.dataset.count, "3");
  assert.equal(recording.dataset.count, "3");
  assert.match(recording.html, /videocam<\/span> 3$/);
  assert.equal(harness.state.observers, 1);
  const writes = recording.writes;
  await harness.sandbox.updateScreenshotBtnCount();
  assert.equal(recording.writes, writes);
  harness.selected.length = 0;
  await harness.sandbox.updateScreenshotBtnCount();
  assert.equal(recording.dataset.count, "0");
  assert.equal(recording.disabled, true);
  assert.equal(screenshot.disabled, true);
});

test("recording counts still update with screenshots disabled and release their observer on removal", async () => {
  const harness = toolbarCountHarness();
  const recording = harness.button();
  harness.sandbox.wireRecordingCountUpdater(recording);
  harness.sandbox.removeScreenshotButton();
  await harness.sandbox.updateScreenshotBtnCount();
  assert.equal(recording.dataset.count, "3");
  assert.equal(harness.state.disconnected, 0);
  harness.sandbox.removeRecordingButton();
  assert.equal(harness.state.disconnected, 1);
});
