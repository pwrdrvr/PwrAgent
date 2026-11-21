import { DICTATION_BATCH_SAMPLES, DICTATION_RATE } from "../../../../shared/audio-transcription";

export async function startDictationCapture(
  signal: AbortSignal,
  onAudio: (pcm: Uint8Array) => void,
  onInterrupted: () => void,
): Promise<{ finish: () => Promise<void>; playReadyTone: () => void }> {
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
    signal.removeEventListener("abort", close);
    stopTracks();
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  };
  const checkMicrophone = () => {
    signal.throwIfAborted();
    if (tracks.some((track) => track.readyState === "ended")) {
      throw new Error("The microphone stopped.");
    }
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    for (const track of tracks) track.addEventListener("ended", onInterrupted, { once: true });
    checkMicrophone();
    context = new AudioContext({ sampleRate: DICTATION_RATE });
    await context.audioWorklet.addModule(new URL("./dictation-capture.worklet.js?no-inline", import.meta.url).href);
    checkMicrophone();
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
    context.createMediaStreamSource(microphone).connect(capture);
    // The worklet leaves its output silent.
    capture.connect(context.destination);
    await context.resume();
    checkMicrophone();

    const audio = context;
    return { playReadyTone: () => {
      if (audio.state !== "running") return;
      // Two short rising notes, quiet enough to sit under speech.
      const gain = audio.createGain();
      gain.connect(audio.destination);
      const start = audio.currentTime;
      for (const [index, frequency] of [660, 880].entries()) {
        const at = start + index * 0.09;
        const note = audio.createOscillator();
        note.frequency.value = frequency;
        note.connect(gain);
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.08, at + 0.01);
        gain.gain.linearRampToValueAtTime(0, at + 0.08);
        note.start(at);
        note.stop(at + 0.09);
      }
    }, finish: async () => {
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
