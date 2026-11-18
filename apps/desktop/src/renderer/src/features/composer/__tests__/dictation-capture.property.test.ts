import { afterEach, expect, it, vi } from "vitest";
import { startDictationCapture } from "../dictation-capture";

afterEach(() => vi.unstubAllGlobals());

it.each([
  "before setup",
  "during setup",
  "with the ended event still queued",
] as const)("rejects startup when the microphone ends %s", async (timing) => {
  class MicrophoneTrack extends EventTarget {
    readyState = "live";
    stop = vi.fn(() => { this.readyState = "ended"; });
  }
  const track = new MicrophoneTrack();
  const moduleStarted = Promise.withResolvers<void>();
  const moduleLoaded = Promise.withResolvers<void>();
  const context = {
    state: "suspended",
    close: vi.fn(async () => { context.state = "closed"; }),
    audioWorklet: {
      addModule: () => {
        moduleStarted.resolve();
        return moduleLoaded.promise;
      },
    },
    createMediaStreamSource: () => ({ connect: vi.fn() }),
    destination: {},
    resume: vi.fn(async () => {}),
  };
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  });
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  vi.stubGlobal("AudioWorkletNode", class { port = {}; connect = vi.fn(); });
  const abort = new AbortController();
  const onInterrupted = vi.fn(() => abort.abort());

  if (timing === "before setup") {
    track.readyState = "ended";
    moduleLoaded.resolve();
  }
  const startup = startDictationCapture(abort.signal, vi.fn(), onInterrupted);
  const outcome = startup.then(() => "listening", () => "rejected");

  let interruptedWhileLoading = false;
  if (timing !== "before setup") {
    await moduleStarted.promise;
    track.readyState = "ended";
    if (timing === "during setup") track.dispatchEvent(new Event("ended"));
    interruptedWhileLoading = abort.signal.aborted;
    moduleLoaded.resolve();
  }
  // An ended track must never reach listening, even before its event is delivered.
  expect(await outcome).toBe("rejected");
  expect(track.stop).toHaveBeenCalled();
  expect(context.resume).not.toHaveBeenCalled();
  expect(context.close).toHaveBeenCalledTimes(timing === "before setup" ? 0 : 1);
  expect(interruptedWhileLoading).toBe(timing === "during setup");
});
