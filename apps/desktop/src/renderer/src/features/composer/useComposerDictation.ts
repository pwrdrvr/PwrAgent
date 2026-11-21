import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { DictationApi } from "../../../../shared/audio-transcription";
import { startDictationCapture } from "./dictation-capture";

export type ComposerDictationView = {
  phase: "idle" | "connecting" | "listening" | "finishing";
  text?: string;
  error?: string;
};
export type DictationLevelListener = (level: number) => void;
type Recording = {
  id: string;
  abort: AbortController;
  unsubscribe?: () => void;
  captureStarted: boolean;
  capture?: Awaited<ReturnType<typeof startDictationCapture>>;
  // The provider session accepts audio.
  apiReady: boolean;
  // The microphone has delivered audio, not merely been opened.
  microphoneLive: boolean;
  // Audio captured before the provider session was ready.
  held: Uint8Array[];
  flushingHeld: boolean;
  silence?: ReturnType<typeof setTimeout>;
  inFlight: Promise<void>;
  queued: number;
  announced: boolean;
  finishing: boolean;
};

const MAX_AUDIO_BATCHES = 10;
// Two seconds of 100 ms batches: enough to keep the first words spoken while
// the provider session finishes connecting, small enough to send in one burst.
const MAX_HELD_BATCHES = 20;
const MICROPHONE_SILENT_MS = 5_000;

export function useComposerDictation(
  api: DictationApi | undefined,
  scope: string,
  insert: (text: string) => boolean,
) {
  const [view, setView] = useState<ComposerDictationView>({ phase: "idle" });
  const recording = useRef<Recording>(undefined);
  const latest = useRef({ scope, insert });
  latest.current = { scope, insert };
  // The input level changes ten times a second; listeners draw it without
  // rendering the composer.
  const levelListeners = useRef(new Set<DictationLevelListener>());
  const onLevel = useCallback((listener: DictationLevelListener) => {
    levelListeners.current.add(listener);
    return () => { levelListeners.current.delete(listener); };
  }, []);

  // Revoke capture in the same commit that hides or replaces its controls.
  useLayoutEffect(() => {
    setView({ phase: "idle" });
    return () => {
      const active = recording.current;
      if (!active) return;
      recording.current = undefined;
      stopRecording(api, active);
    };
  }, [api, scope]);

  async function toggle(): Promise<void> {
    if (!api) return;
    const previous = recording.current;
    const isCurrent = (current: Recording) => recording.current === current && latest.current.scope === scope;
    const release = (current: Recording) => {
      if (recording.current === current) recording.current = undefined;
      stopRecording(api, current);
    };
    const fail = (current: Recording, error: string) => {
      if (!isCurrent(current)) return;
      release(current);
      setView((state) => ({ ...state, phase: "idle", error }));
    };

    if (previous) {
      if (previous.finishing) return;
      if (!previous.capture || !previous.apiReady || !previous.microphoneLive) {
        release(previous);
        setView({ phase: "idle" });
        return;
      }
      previous.finishing = true;
      setView((state) => ({ ...state, phase: "finishing" }));
      try {
        await previous.capture.finish();
        await previous.inFlight;
        if (!isCurrent(previous)) return;
        const text = await api.finish(previous.id);
        if (!isCurrent(previous)) return;
        release(previous);
        if (text && !latest.current.insert(text)) {
          setView({ phase: "idle", text, error: "The draft is unavailable. You can copy your transcript." });
        } else {
          setView(text ? { phase: "idle" } : { phase: "idle", error: "No speech was transcribed." });
        }
      } catch (error) {
        fail(previous, dictationError(error));
      }
      return;
    }

    const current: Recording = {
      id: crypto.randomUUID(),
      abort: new AbortController(),
      captureStarted: false,
      apiReady: false,
      microphoneLive: false,
      held: [],
      flushingHeld: false,
      inFlight: Promise.resolve(),
      queued: 0,
      announced: false,
      finishing: false,
    };
    recording.current = current;
    setView({ phase: "connecting" });

    const send = (work: () => Promise<void>) => {
      current.queued++;
      current.inFlight = current.inFlight.then(async () => {
        if (isCurrent(current)) await work();
      }).catch((error: unknown) => fail(current, dictationError(error))).finally(() => {
        current.queued--;
      });
    };
    // Listening is announced only once both halves work: the provider accepts
    // audio and the microphone is delivering it.
    const announceListening = () => {
      if (!isCurrent(current) || current.finishing) return;
      if (!current.capture || !current.apiReady || !current.microphoneLive) return;
      if (current.announced) return;
      current.announced = true;
      current.capture.playReadyTone();
      setView((state) => ({ ...state, phase: "listening" }));
    };
    const startCapture = async () => {
      if (current.captureStarted) return;
      current.captureStarted = true;
      try {
        const capture = await startDictationCapture(current.abort.signal, (pcm) => {
          if (!isCurrent(current)) return;
          publishLevel(levelListeners.current, pcm);
          current.microphoneLive = true;
          clearTimeout(current.silence);
          if (!current.apiReady) {
            current.held.push(pcm);
            if (current.held.length > MAX_HELD_BATCHES) current.held.shift();
            return;
          }
          // Live audio queues behind the held audio while that is sent, which
          // is not the provider falling behind.
          if (!current.flushingHeld && current.queued >= MAX_AUDIO_BATCHES) {
            fail(current, "Live transcription could not keep up with the microphone.");
            return;
          }
          send(() => api.audio(current.id, pcm));
          announceListening();
        }, () => fail(current, "The microphone stopped."));
        if (!isCurrent(current)) return;
        current.capture = capture;
        if (!current.microphoneLive) {
          current.silence = setTimeout(
            () => fail(current, "The microphone is not delivering audio. Check the input device in system settings."),
            MICROPHONE_SILENT_MS,
          );
        }
        announceListening();
      } catch (error) {
        fail(current, dictationError(error));
      }
    };
    current.unsubscribe = api.onEvent((event) => {
      if (event.id !== current.id || !isCurrent(current)) return;
      if (event.kind === "error") fail(current, event.message);
      else if (event.kind === "connecting") void startCapture();
      else setView((state) => ({ ...state, text: (state.text ?? "") + event.text }));
    });

    try {
      await api.start(current.id);
      if (!isCurrent(current)) return;
      current.apiReady = true;
      const held = current.held.splice(0);
      if (held.length) {
        current.flushingHeld = true;
        send(async () => {
          try {
            for (const pcm of held) {
              if (!isCurrent(current)) return;
              await api.audio(current.id, pcm);
            }
          } finally {
            current.flushingHeld = false;
          }
        });
      }
      void startCapture();
      announceListening();
    } catch (error) {
      fail(current, dictationError(error));
    }
  }

  /** Stops capture and discards the transcript, in any live phase. */
  function cancel(): void {
    const active = recording.current;
    if (!active) return;
    recording.current = undefined;
    stopRecording(api, active);
    setView({ phase: "idle" });
  }

  return { ...view, toggle, cancel, onLevel };
}

function stopRecording(api: DictationApi | undefined, active: Recording): void {
  clearTimeout(active.silence);
  active.unsubscribe?.();
  active.abort.abort();
  void api?.cancel(active.id).catch(() => undefined);
}

function publishLevel(listeners: Set<DictationLevelListener>, pcm: Uint8Array): void {
  if (!listeners.size) return;
  const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - pcm.byteLength % 2);
  let peak = 0;
  for (let offset = 0; offset < samples.byteLength; offset += 2) {
    peak = Math.max(peak, Math.abs(samples.getInt16(offset, true)));
  }
  // Speech peaks sit well below full scale; the square root keeps quiet
  // speech visible.
  const level = Math.min(1, Math.sqrt(peak / 32768));
  for (const listener of listeners) listener(level);
}

function dictationError(error: unknown): string {
  if (!(error instanceof Error)) return "Could not start dictation.";
  if (error.name === "NotAllowedError") return "Allow microphone access to dictate.";
  if (error.name === "NotFoundError") return "PwrAgent could not find a microphone.";
  // Electron adds an invocation prefix to errors it passes back from main.
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
