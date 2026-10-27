import {
  Input,
  BlobSource,
  ALL_FORMATS,
  Output,
  BufferTarget,
  Mp4OutputFormat,
  Conversion,
  QUALITY_VERY_HIGH,
  VideoSampleSink,
} from "./mediabunny-1.61.6.min.mjs";

export async function posterFrame(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("The recording contains no video track.");
    const canvas = new OffscreenCanvas(
      await track.getDisplayWidth(),
      await track.getDisplayHeight(),
    );
    const sample = await new VideoSampleSink(track).getSample(
      await track.getFirstTimestamp(),
    );
    if (!sample) throw new Error("The recording contains no frames.");
    try {
      sample.draw(canvas.getContext("2d"), 0, 0);
    } finally {
      sample.close();
    }
    return canvas.convertToBlob({ type: "image/png" });
  } finally {
    input.dispose();
  }
}

// Re-encodes heartbeat per decoded frame; copy remuxes only report start/end progress.
const STALL_TIMEOUT = { transcode: 20000, copy: 60000 };

class FinalizationStalled extends Error {}

export async function remuxRecording(blob, signal, trim = null) {
  if (
    trim &&
    (!Number.isFinite(trim.start) ||
      !Number.isFinite(trim.end) ||
      trim.start < 0 ||
      trim.end <= trim.start)
  )
    throw new Error("Invalid seconds-only recording trim range.");
  try {
    return await convert(blob, signal, trim, "no-preference");
  } catch (error) {
    if (!(error instanceof FinalizationStalled)) throw error;
    // Another app (e.g. a macOS screen recorder) can hold the hardware H.264 encoder.
    if (trim) return convert(blob, signal, trim, "prefer-software");
    return new Blob([blob], { type: "video/mp4" });
  }
}

async function convert(blob, signal, trim, hardwareAcceleration) {
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  const output = new Output({
    target: new BufferTarget(),
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
  });
  let conversion;
  let stalled = false;
  let watchdog;
  let lastProgress = Date.now();
  const heartbeat = () => {
    lastProgress = Date.now();
  };
  const timeout = trim ? STALL_TIMEOUT.transcode : STALL_TIMEOUT.copy;
  const cancel = () => {
    void conversion?.cancel().catch(() => {});
  };
  try {
    signal?.throwIfAborted();
    const tracks = await input.getVideoTracks();
    if (tracks.length !== 1 || (await tracks[0].getCodec()) !== "avc")
      throw new Error("The recording must contain one H.264 video track.");
    const duration = await input.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("The recording contains no playable video.");
    conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      audio: { discard: true },
      copy: trim ? false : { mode: "forced" },
      ...(trim
        ? {
            trim,
            video: {
              codec: "avc",
              bitrate: QUALITY_VERY_HIGH,
              hardwareAcceleration,
              process: (sample) => {
                heartbeat();
                return sample;
              },
            },
          }
        : {}),
    });
    if (!conversion.isValid || conversion.utilizedTracks.length !== 1)
      throw new Error(
        trim
          ? "This browser cannot encode the seconds-only recording as H.264. Update Chrome or use an installation with H.264 encoding support."
          : "Could not finalize the H.264 MP4 recording.",
      );
    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancel, { once: true });
    heartbeat();
    conversion.onProgress = heartbeat;
    // cancel() can itself wait on a stuck encoder, so the watchdog rejects directly.
    const stall = new Promise((_, reject) => {
      watchdog = setInterval(() => {
        if (Date.now() - lastProgress < timeout) return;
        stalled = true;
        cancel();
        reject(
          new FinalizationStalled(
            "Finalizing stopped responding. Another app may be using the video encoder (for example a screen recorder); stop it and record again.",
          ),
        );
      }, 1000);
    });
    await Promise.race([conversion.execute(), stall]);
    signal?.throwIfAborted();
    return new Blob([output.target.buffer], { type: "video/mp4" });
  } finally {
    clearInterval(watchdog);
    signal?.removeEventListener("abort", cancel);
    input.dispose();
    if (output.state !== "finalized" && output.state !== "canceled") {
      const cancelled = output.cancel();
      if (stalled) void cancelled.catch(() => {});
      else await cancelled;
    }
  }
}
