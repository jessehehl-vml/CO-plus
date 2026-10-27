export async function acquireTabCapture({
  sessionId,
  authorization,
  previewTabId,
  signal,
  onWaiting,
  chromeApi = globalThis.chrome,
  mediaDevices = globalThis.navigator?.mediaDevices,
}) {
  if (!chromeApi?.runtime?.onMessage || !mediaDevices?.getUserMedia) {
    throw new Error(
      "Tab capture is unavailable. Reload the updated extension and allow its tab-capture permission.",
    );
  }
  signal.throwIfAborted();
  let finish;
  const response = new Promise((resolve, reject) => {
    finish = (error, streamId) => (error ? reject(error) : resolve(streamId));
  });
  void response.catch(() => {});
  const onMessage = (message, sender) => {
    if (
      sender.id !== chromeApi.runtime.id ||
      sender.tab ||
      message?.action !== "recordingTabCaptureResult" ||
      message.id !== sessionId ||
      message.authorization !== authorization ||
      message.captureTabId !== previewTabId
    )
      return;
    if (message.error) finish(new Error(message.error));
    else if (typeof message.streamId === "string" && message.streamId)
      finish(null, message.streamId);
    else
      finish(
        new Error(
          "Chrome did not provide a tab-capture stream. Retry using CO Plus in the preview toolbar.",
        ),
      );
  };
  const onAbort = () =>
    finish(signal.reason || new Error("Recording cancelled."));
  const timer = setTimeout(
    () =>
      finish(
        new Error(
          "Recording did not start because CO Plus was not clicked in Chrome's toolbar. Retry, keep the CO Plus - Ad Recording tab active, then click CO Plus at the top right. If the icon is hidden, open the Extensions menu (puzzle piece) and choose CO Plus.",
        ),
      ),
    120000,
  );
  chromeApi.runtime.onMessage.addListener(onMessage);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await onWaiting();
    signal.throwIfAborted();
    const streamId = await response;
    signal.throwIfAborted();
    const stream = await mediaDevices.getUserMedia({
      audio: false,
      video: {
        // Unequal min/max aspect ratios select Chrome's ANY_WITHIN_LIMIT policy;
        // the default FIXED_RESOLUTION rescales and letterboxes the tab.
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
          minWidth: 2,
          minHeight: 2,
          maxWidth: 4096,
          maxHeight: 2304,
        },
      },
    });
    if (signal.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      signal.throwIfAborted();
    }
    return stream;
  } finally {
    clearTimeout(timer);
    chromeApi.runtime.onMessage.removeListener(onMessage);
    signal.removeEventListener("abort", onAbort);
  }
}
