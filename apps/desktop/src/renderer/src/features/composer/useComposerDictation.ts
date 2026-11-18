import { useEffect, useRef, useState } from "react";
import type { DictationApi } from "../../../../shared/audio-transcription";
import { startDictationCapture } from "./dictation-capture";

type View = { phase: "idle" | "connecting" | "listening" | "finishing"; text?: string; error?: string };
type Recording = {
  id: string;
  abort: AbortController;
  unsubscribe?: () => void;
  capture?: Awaited<ReturnType<typeof startDictationCapture>>;
  inFlight: Promise<void>;
  queued: number;
  finishing: boolean;
};

const MAX_AUDIO_BATCHES = 10;

export function useComposerDictation(
  api: DictationApi | undefined,
  scope: string,
  insert: (text: string) => boolean,
) {
  const [view, setView] = useState<View>({ phase: "idle" });
  const recording = useRef<Recording>(undefined);
  const latest = useRef({ scope, insert });
  latest.current = { scope, insert };

  useEffect(() => {
    setView({ phase: "idle" });
    return () => {
      const active = recording.current;
      if (!active) return;
      recording.current = undefined;
      active.unsubscribe?.();
      active.abort.abort();
      void api?.cancel(active.id).catch(() => undefined);
    };
  }, [api, scope]);

  async function toggle(): Promise<void> {
    if (!api) return;
    const previous = recording.current;
    const isCurrent = (current: Recording) => recording.current === current && latest.current.scope === scope;
    const release = (current: Recording) => {
      current.unsubscribe?.();
      current.abort.abort();
      if (recording.current === current) recording.current = undefined;
      void api.cancel(current.id).catch(() => undefined);
    };
    const fail = (current: Recording, error: string) => {
      if (!isCurrent(current)) return;
      release(current);
      setView((state) => ({ ...state, phase: "idle", error }));
    };

    if (previous) {
      if (previous.finishing) return;
      if (!previous.capture) {
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
      inFlight: Promise.resolve(),
      queued: 0,
      finishing: false,
    };
    recording.current = current;
    setView({ phase: "connecting" });
    current.unsubscribe = api.onEvent((event) => {
      if (event.id !== current.id || !isCurrent(current)) return;
      if (event.kind === "error") fail(current, event.message);
      else setView((state) => ({ ...state, text: (state.text ?? "") + event.text }));
    });

    try {
      await api.start(current.id);
      if (!isCurrent(current)) return;
      current.capture = await startDictationCapture(current.abort.signal, (pcm) => {
        if (!isCurrent(current)) return;
        if (current.queued >= MAX_AUDIO_BATCHES) {
          fail(current, "Live transcription could not keep up with the microphone.");
          return;
        }
        current.queued++;
        current.inFlight = current.inFlight.then(async () => {
          if (isCurrent(current)) await api.audio(current.id, pcm);
        }).catch((error: unknown) => fail(current, dictationError(error))).finally(() => {
          current.queued--;
        });
      }, () => fail(current, "The microphone stopped."));
      if (isCurrent(current)) setView((state) => ({ ...state, phase: "listening" }));
    } catch (error) {
      fail(current, dictationError(error));
    }
  }

  return { ...view, toggle };
}

function dictationError(error: unknown): string {
  if (!(error instanceof Error)) return "Could not start dictation.";
  if (error.name === "NotAllowedError") return "Allow microphone access to dictate.";
  if (error.name === "NotFoundError") return "PwrAgent could not find a microphone.";
  // Electron adds an invocation prefix to errors it passes back from main.
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
