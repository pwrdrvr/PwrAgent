import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { DictationEvent } from "../../../../../shared/audio-transcription";
import { startDictationCapture } from "../dictation-capture";
import { useComposerDictation } from "../useComposerDictation";

vi.mock("../dictation-capture", () => ({ startDictationCapture: vi.fn() }));

const HELD_BATCHES = 20;

type Step = "provider opens" | "provider ready" | "microphone opens" | "audio";

// The operator is told "Listening" and hears the ready tone only when the
// provider accepts audio AND the microphone has delivered some. Audio captured
// while the provider was still connecting is not lost: the newest two seconds
// reach the provider first, in order, followed by everything captured after.
it("announces listening exactly when the provider and a delivering microphone are both ready", async () => {
  await fc.assert(fc.asyncProperty(
    // A slow provider: the microphone runs for up to four seconds before the
    // session is ready, which pushes held audio past its two-second window.
    fc.array(
      fc.constantFrom<Step>("provider opens", "microphone opens", "audio", "audio", "audio"),
      { maxLength: 40, size: "max" },
    ),
    fc.array(
      fc.constantFrom<Step>("provider opens", "provider ready", "microphone opens", "audio"),
      { maxLength: 30, size: "max" },
    ),
    async (connecting, rest) => {
      const steps = [...connecting, ...rest];
      const ready = Promise.withResolvers<void>();
      const opened = Promise.withResolvers<{ finish: () => Promise<void>; playReadyTone: () => void }>();
      const playReadyTone = vi.fn();
      let onAudio: ((pcm: Uint8Array) => void) | undefined;
      let receive: ((event: DictationEvent) => void) | undefined;
      vi.mocked(startDictationCapture).mockReset().mockImplementation(async (_signal, audio) => {
        onAudio = audio;
        return await opened.promise;
      });
      const sent: number[] = [];
      const api = {
        start: vi.fn(async (_id: string) => await ready.promise),
        audio: vi.fn(async (_id: string, pcm: Uint8Array) => { sent.push(pcm[0]); }),
        finish: vi.fn(async () => ""),
        cancel: vi.fn(async () => {}),
        onEvent: (listener: (event: DictationEvent) => void) => {
          receive = listener;
          return () => {};
        },
      };
      const hook = renderHook(() => useComposerDictation(api, "scope", () => true));
      try {
        await act(async () => { void hook.result.current.toggle(); });

        const done = { providerReady: false, microphoneOpen: false, audio: false };
        const beforeReady: number[] = [];
        const afterReady: number[] = [];
        let batch = 0;
        for (const step of steps) {
          await act(async () => {
            if (step === "provider opens") {
              receive?.({ id: api.start.mock.calls[0][0], kind: "connecting" });
            } else if (step === "provider ready") {
              done.providerReady = true;
              ready.resolve();
            } else if (step === "microphone opens" && onAudio) {
              done.microphoneOpen = true;
              opened.resolve({ finish: async () => {}, playReadyTone });
            } else if (step === "audio" && onAudio) {
              // The microphone cannot deliver before capture was requested.
              done.audio = true;
              batch = (batch + 1) % 256;
              (done.providerReady ? afterReady : beforeReady).push(batch);
              onAudio(new Uint8Array([batch, 0]));
            }
          });
          // Capture is requested when the provider opens or becomes ready.
          const listening = done.providerReady && done.microphoneOpen && done.audio;
          expect(hook.result.current.phase).toBe(listening ? "listening" : "connecting");
          expect(playReadyTone).toHaveBeenCalledTimes(listening ? 1 : 0);
        }
        await act(async () => {});
        expect(sent).toEqual(done.providerReady ? [...beforeReady.slice(-HELD_BATCHES), ...afterReady] : []);
      } finally {
        hook.unmount();
      }
    },
  ), { numRuns: 40 });
});
