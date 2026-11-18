import { DICTATION_BATCH_SAMPLES, DICTATION_RATE } from "../../../../shared/audio-transcription";

export async function startDictationCapture(
  signal: AbortSignal,
  onAudio: (pcm: Uint8Array) => void,
  onInterrupted: () => void,
): Promise<{ finish: () => Promise<void> }> {
  const microphone = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
  const tracks = microphone.getTracks();
  const stopTracks = () => {
    for (const track of tracks) {
      track.removeEventListener("ended", onInterrupted);
      track.stop();
    }
  };
  let context: AudioContext | undefined;
  const close = () => {
    stopTracks();
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    context = new AudioContext({ sampleRate: DICTATION_RATE });
    await context.audioWorklet.addModule(new URL("./dictation-capture.worklet.js?no-inline", import.meta.url).href);
    signal.throwIfAborted();
    const capture = new AudioWorkletNode(context, "pwragent-dictation", {
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { batchSamples: DICTATION_BATCH_SAMPLES },
    });
    const flushed = Promise.withResolvers<void>();
    capture.port.onmessage = ({ data }: MessageEvent<ArrayBuffer | string>) => {
      if (data instanceof ArrayBuffer) onAudio(new Uint8Array(data));
      if (data === "flushed") flushed.resolve();
    };
    capture.onprocessorerror = onInterrupted;
    for (const track of tracks) track.addEventListener("ended", onInterrupted, { once: true });
    context.createMediaStreamSource(microphone).connect(capture);
    // The worklet leaves its output silent.
    capture.connect(context.destination);
    await context.resume();
    signal.throwIfAborted();

    return { finish: async () => {
      stopTracks();
      capture.port.postMessage("flush");
      const timeout = setTimeout(flushed.resolve, 1_000);
      await flushed.promise;
      clearTimeout(timeout);
      capture.port.close();
      close();
    } };
  } catch (error) {
    close();
    throw error;
  }
}
