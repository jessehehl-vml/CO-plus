(function (root) {
  const MP4_TYPES = [
    'video/mp4;codecs="avc1.42E01E"',
    'video/mp4;codecs="avc1.42001E"',
    'video/mp4;codecs="avc1.4D0028"',
  ];

  function selectRecordingType(recorder) {
    const type = MP4_TYPES.find((candidate) =>
      recorder?.isTypeSupported(candidate),
    );
    if (!type)
      throw new Error(
        "MP4/H.264 recording is unavailable. Update Chrome or use a Chrome installation with H.264 encoding support.",
      );
    return type;
  }

  function recordingOptions(duration = 15) {
    const seconds = Number(duration);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) {
      throw new Error("Recording duration must be between 1 and 120 seconds.");
    }
    return { duration: seconds, fps: 30 };
  }

  function recordingRange(
    start = { type: "seconds", value: 0 },
    end = { type: "seconds", value: 15 },
  ) {
    const endpoint = (value, name) => {
      if (
        !value ||
        !["seconds", "frame"].includes(value.type) ||
        value.value === "" ||
        value.value === null
      )
        throw new Error(`Choose a valid ${name} endpoint.`);
      const number = Number(value.value);
      if (
        !Number.isFinite(number) ||
        number < 0 ||
        (value.type === "frame" && (!Number.isInteger(number) || number < 1))
      )
        throw new Error(
          `Choose a valid ${name} ${value.type === "frame" ? "frame" : "time"}.`,
        );
      return { type: value.type, value: number };
    };
    const range = {
      start: endpoint(start, "start"),
      end: endpoint(end, "end"),
    };
    if (range.start.type === "seconds" && range.end.type === "seconds")
      validateRecordingInterval(range.start.value, range.end.value);
    if (
      range.start.type === "frame" &&
      range.end.type === "frame" &&
      range.start.value === range.end.value
    )
      throw new Error("The end must be after the start.");
    return range;
  }

  function validateRecordingInterval(start, end) {
    const duration = end - start;
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("The end must be after the start.");
    if (duration > 120)
      throw new Error(
        "The selected recording interval cannot exceed 120 seconds.",
      );
    return { start, end, duration };
  }

  function resolveRecordingRange(range, labels = {}) {
    const normalized = recordingRange(range.start, range.end);
    const time = (endpoint) => {
      if (endpoint.type === "seconds") return endpoint.value;
      const label = `frame${endpoint.value}-preview`;
      const seconds = Object.hasOwn(labels, label) ? labels[label] : undefined;
      if (
        typeof seconds !== "number" ||
        !Number.isFinite(seconds) ||
        seconds < 0
      )
        throw new Error(
          `Frame ${endpoint.value} is not available in this creative size.`,
        );
      return seconds;
    };
    return validateRecordingInterval(
      time(normalized.start),
      time(normalized.end),
    );
  }

  function recordingFileName(name, width, height) {
    const safe =
      String(name || "Unnamed Variant")
        .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "")
        .trim() || "Unnamed Variant";
    return `${safe}_${width}x${height}.mp4`;
  }

  function recordingCrop(bounds, videoWidth, videoHeight) {
    const {
      width,
      height,
      viewportWidth,
      viewportHeight,
      left = 0,
      top = 0,
    } = bounds;
    if (
      ![
        width,
        height,
        viewportWidth,
        viewportHeight,
        videoWidth,
        videoHeight,
      ].every((value) => Number.isFinite(value) && value > 0) ||
      left < 0 ||
      top < 0 ||
      left + width > viewportWidth ||
      top + height > viewportHeight
    ) {
      throw new Error(
        "The complete ad must fit inside the recording window. Enlarge the window and retry.",
      );
    }
    let scaleX = videoWidth / viewportWidth;
    let scaleY = videoHeight / viewportHeight;
    const scale = Math.min(scaleX, scaleY);
    let offsetX = (videoWidth - viewportWidth * scale) / 2;
    let offsetY = (videoHeight - viewportHeight * scale) / 2;
    // innerWidth/innerHeight are rounded CSS pixels and capture frames are
    // rounded device pixels, so a sub-pixel aspect mismatch is not a real
    // letterbox. Treating it as one shifts the crop and exposes a page edge.
    if (offsetX <= scale && offsetY <= scale) {
      offsetX = 0;
      offsetY = 0;
    } else {
      scaleX = scale;
      scaleY = scale;
    }
    const cropLeft = Math.max(0, offsetX + left * scaleX);
    const cropTop = Math.max(0, offsetY + top * scaleY);
    const cropRight = Math.min(videoWidth, offsetX + (left + width) * scaleX);
    const cropBottom = Math.min(videoHeight, offsetY + (top + height) * scaleY);
    return {
      left: cropLeft,
      top: cropTop,
      width: cropRight - cropLeft,
      height: cropBottom - cropTop,
    };
  }

  const api = {
    selectRecordingType,
    recordingOptions,
    recordingRange,
    resolveRecordingRange,
    recordingFileName,
    recordingCrop,
  };
  if (typeof module !== "undefined") module.exports = api;
  else root.RecordingCore = api;
})(globalThis);
