import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeVoiceController, type VoiceView, type VoiceBrowser } from "../native-voice-controller";
import type { NativeVoiceApi, NativeVoiceEvent } from "../../../../../shared/native-voice";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const listeners = new Set<(event: NativeVoiceEvent) => void>();
  const api: NativeVoiceApi = {
    nativeVoiceCapability: vi.fn(async () => ({ available: true })),
    startNativeVoice: vi.fn(async () => {}), stopNativeVoice: vi.fn(async () => {}), sendNativeVoiceText: vi.fn(async () => {}),
    onNativeVoiceEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const track = { stop: vi.fn(), onended: null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const sender = { replaceTrack: vi.fn(async () => {}) };
  const peer = {
    connectionState: "new", iceGatheringState: "complete", onconnectionstatechange: null as (() => void) | null,
    ontrack: null, localDescription: { sdp: "v=0\r\nfixture" },
    addTransceiver: vi.fn(() => ({ sender })), createDataChannel: vi.fn(),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0\r\nfixture" })),
    setLocalDescription: vi.fn(async () => {}), setRemoteDescription: vi.fn(async () => {}), close: vi.fn(),
  };
  const audio = { srcObject: null, autoplay: false, pause: vi.fn(), play: vi.fn(async () => {}), removeAttribute: vi.fn() };
  vi.stubGlobal("MediaStream", class MediaStream {});
  const platform: VoiceBrowser = {
    peer: () => peer as unknown as RTCPeerConnection,
    audio: () => audio as unknown as HTMLAudioElement,
    microphone: vi.fn(async () => stream as unknown as MediaStream), id: () => "fixture-session",
  };
  const views: VoiceView[] = [];
  const controller = new NativeVoiceController(api, (view) => views.push(view), platform);
  const send = (event: NativeVoiceEvent) => { for (const listener of listeners) listener(event); };
  const connect = () => {
    send({ type: "started", version: "v3", sessionId: "fixture-session" });
    peer.connectionState = "connected";
    peer.onconnectionstatechange?.();
  };
  return { controller, api, peer, sender, audio, platform, stream, track, listeners, views, send, connect };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("native voice browser lifecycle", () => {
  it("gates unsupported runtimes before microphone access or peer creation", async () => {
    const f = fixture();
    vi.mocked(f.api.nativeVoiceCapability).mockResolvedValue({ available: false, reason: "Unsupported runtime." });
    await f.controller.start("fixture-thread");
    expect(f.platform.microphone).not.toHaveBeenCalled();
    expect(f.peer.createOffer).not.toHaveBeenCalled();
    expect(f.api.startNativeVoice).not.toHaveBeenCalled();
    expect(f.views.at(-1)).toMatchObject({ status: "error", error: "Unsupported runtime." });
  });

  it("captures only after peer connection, service started and RPC accepted", async () => {
    const f = fixture();
    const accepted = deferred<void>();
    vi.mocked(f.api.startNativeVoice).mockReturnValue(accepted.promise);
    const start = f.controller.start("fixture-thread");
    await vi.waitFor(() => expect(f.api.startNativeVoice).toHaveBeenCalledOnce());
    f.connect();
    expect(f.platform.microphone).not.toHaveBeenCalled();
    accepted.resolve();
    await start;
    expect(f.platform.microphone).toHaveBeenCalledOnce();
    expect(f.sender.replaceTrack).toHaveBeenCalledWith(f.track);
    expect(f.views.at(-1)?.status).toBe("listening");
    await f.controller.text("Steer the coding task.");
    expect(f.api.sendNativeVoiceText).toHaveBeenCalledWith({ sessionId: "fixture-session", text: "Steer the coding task." });
    await f.controller.stop();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.peer.close).toHaveBeenCalledOnce();
    expect(f.audio.pause).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
  });

  // The order a live session produced: the operator's words finish while the
  // voice is already answering. One shared "current row" split the reply at
  // "Yeah, it's" and repeated the operator's line beneath it.
  it("keeps one row per spoken line when speech and reply stream at once", async () => {
    const f = fixture();
    const start = f.controller.start("fixture-thread");
    await vi.waitFor(() => expect(f.api.startNativeVoice).toHaveBeenCalledOnce());
    f.connect();
    await start;
    const say = (role: "user" | "assistant", text: string, done = false) =>
      f.send({ sessionId: "fixture-session", type: "transcript", role, text, done });
    say("user", "Hey, is");
    say("user", " this thing working?");
    say("assistant", "Yeah, it's");
    say("user", "Hey, is this thing working? It looks sweet.", true);
    say("assistant", " working.");
    say("assistant", " What do you want to try?");
    say("assistant", "Yeah, it's working. What do you want to try?", true);
    say("user", "Check the build.", true);
    expect(f.views.at(-1)?.transcript.map((row) => [row.role, row.text])).toEqual([
      ["user", "Hey, is this thing working? It looks sweet."],
      ["assistant", "Yeah, it's working. What do you want to try?"],
      ["user", "Check the build."],
    ]);
    await f.controller.stop();
  });

  it("stops tracks from a microphone permission result arriving after stop", async () => {
    const f = fixture();
    const permission = deferred<MediaStream>();
    vi.mocked(f.platform.microphone).mockReturnValue(permission.promise);
    await f.controller.start("fixture-thread");
    f.connect();
    await vi.waitFor(() => expect(f.platform.microphone).toHaveBeenCalledOnce());
    await f.controller.stop();
    permission.resolve(f.stream as unknown as MediaStream);
    await vi.waitFor(() => expect(f.track.stop).toHaveBeenCalledOnce());
    expect(f.sender.replaceTrack).not.toHaveBeenCalled();
    expect(f.views.at(-1)?.status).toBe("idle");
  });

  it("cleans permission denial and service errors without allowing stale transcripts", async () => {
    const f = fixture();
    vi.mocked(f.platform.microphone).mockRejectedValue(new Error("Microphone permission denied."));
    await f.controller.start("fixture-thread");
    f.connect();
    await vi.waitFor(() => expect(f.api.stopNativeVoice).toHaveBeenCalledOnce());
    expect(f.listeners.size).toBe(0);
    f.send({ sessionId: "fixture-session", type: "transcript", role: "user", text: "stale", done: true });
    expect(f.views.at(-1)).toMatchObject({ status: "error", error: "Microphone permission denied.", transcript: [] });
    expect(f.peer.close).toHaveBeenCalledOnce();
  });

  it("bounds connection establishment and never captures on timeout", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start("fixture-thread");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(f.platform.microphone).not.toHaveBeenCalled();
    expect(f.api.stopNativeVoice).toHaveBeenCalledOnce();
    expect(f.views.at(-1)?.status).toBe("error");
    expect(f.listeners.size).toBe(0);
  });

  it("rejects duplicate start, clears backend loss and ignores unrelated session events", async () => {
    const f = fixture();
    await f.controller.start("fixture-thread");
    await f.controller.start("other-thread");
    expect(f.api.startNativeVoice).toHaveBeenCalledOnce();
    f.send({ sessionId: "stale-session", type: "error", message: "ignored" });
    expect(f.views.at(-1)?.status).toBe("connecting");
    f.send({ sessionId: "fixture-session", type: "error", message: "Backend disconnected." });
    await vi.waitFor(() => expect(f.api.stopNativeVoice).toHaveBeenCalledOnce());
    expect(f.views.at(-1)).toMatchObject({ status: "error", error: "Backend disconnected." });
  });

  it("retains a retry control when backend stop fails after local audio cleanup", async () => {
    const f = fixture();
    await f.controller.start("fixture-thread");
    f.connect();
    await vi.waitFor(() => expect(f.views.at(-1)?.status).toBe("listening"));
    vi.mocked(f.api.stopNativeVoice).mockRejectedValueOnce(new Error("Stop failed."));
    await f.controller.stop();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.views.at(-1)?.status).toBe("stop-error");
    await f.controller.stop();
    expect(f.api.stopNativeVoice).toHaveBeenCalledTimes(2);
    expect(f.views.at(-1)?.status).toBe("idle");
  });
});


describe("voice camera ownership", () => {
  async function liveCamera() {
    const f = fixture();
    const capture = { stream: f.stream as unknown as MediaStream, frames: vi.fn(() => ["data:image/jpeg;base64,fixture"]), close: vi.fn() };
    f.platform.camera = vi.fn(async () => capture);
    f.api.sendNativeVoiceCameraCue = vi.fn(async () => {});
    f.api.setNativeVoiceCamera = vi.fn(async () => {});
    f.api.analyzeNativeVoiceCamera = vi.fn(async () => ({ present: true, presenceConfidence: 0.95, reaction: "exasperated" as const, reactionConfidence: 0.9, latencyMs: 400 }));
    const start = f.controller.start("fixture-thread");
    await vi.waitFor(() => expect(f.api.startNativeVoice).toHaveBeenCalledOnce());
    f.connect();
    await start;
    vi.useFakeTimers();
    return { ...f, capture };
  }

  it("opts in separately and sends only a debounced text cue, then releases capture on stop", async () => {
    const f = await liveCamera();
    expect(f.platform.camera).not.toHaveBeenCalled();
    await f.controller.setCamera(true);
    expect(f.api.setNativeVoiceCamera).toHaveBeenCalledWith({ sessionId: "fixture-session", enabled: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledOnce();
    expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledWith({ sessionId: "fixture-session", cue: "exasperated" });
    await f.controller.stop();
    expect(f.capture.close).toHaveBeenCalledOnce();
    expect(f.api.setNativeVoiceCamera).toHaveBeenLastCalledWith({ sessionId: "fixture-session", enabled: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledOnce();
  });

  it("counts results/rate and marks delivery only after the cue RPC acknowledges", async () => {
    const f = await liveCamera();
    const pending = deferred<void>();
    f.api.analyzeNativeVoiceCamera = vi.fn(async () => ({ present: true, presenceConfidence: 0.95, reaction: "neutral" as const, reactionConfidence: 0.9, latencyMs: 400 }));
    f.api.sendNativeVoiceCameraCue = vi.fn(() => pending.promise);
    await f.controller.setCamera(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.controller.getView().cameraDiagnostics).toMatchObject({
      threadId: "fixture-thread", sessionId: "fixture-session", observations: 4, rateHz: 2,
      delivery: "pending", lastCue: "neutral", cuesAcknowledged: 0,
    });
    // A vibe reaches the voice but is ambient: no transcript row.
    expect(f.controller.getView().cameraCues).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.api.analyzeNativeVoiceCamera).toHaveBeenCalledTimes(4);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.getView().cameraDiagnostics).toMatchObject({ delivery: "acknowledged", cuesAcknowledged: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledOnce();
    expect(f.controller.getView().cameraDiagnostics?.filter).toBe("Repeated cue suppressed");
    await f.controller.stop();
  });

  it("settles a gesture's transcript receipt even when the camera stops before the RPC answers", async () => {
    const f = await liveCamera();
    const pending = deferred<void>();
    f.api.analyzeNativeVoiceCamera = vi.fn(async () => ({ present: true, presenceConfidence: 0.95, reaction: "neutral" as const,
      reactionConfidence: 0.9, gesture: "stop" as const, gestureConfidence: 0.93, latencyMs: 250 }));
    f.api.sendNativeVoiceCameraCue = vi.fn(() => pending.promise);
    await f.controller.setCamera(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.controller.getView().cameraCues).toEqual([expect.objectContaining({ cue: "stop", delivery: "pending" })]);
    await f.controller.setCamera(false);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.getView().cameraCues).toEqual([expect.objectContaining({ cue: "stop", delivery: "acknowledged" })]);
    await f.controller.stop();
  });

  it("automatically delivers a stop gesture as a camera cue without spoken-user text or a tool call", async () => {
    const f = await liveCamera();
    f.api.analyzeNativeVoiceCamera = vi.fn(async () => ({ present: true, presenceConfidence: 0.95, reaction: "neutral" as const,
      reactionConfidence: 0.9, gesture: "stop" as const, gestureConfidence: 0.93, latencyMs: 250 }));
    await f.controller.setCamera(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledExactlyOnceWith({ sessionId: "fixture-session", cue: "stop" });
    expect(f.api.sendNativeVoiceText).not.toHaveBeenCalled();
    expect(f.controller.getView().cameraDiagnostics).toMatchObject({ lastCue: "stop", delivery: "acknowledged", cuesAcknowledged: 1 });
    // The cue takes a place in the conversation's order, after what was already said.
    const { cameraCues, transcript } = f.controller.getView();
    expect(cameraCues).toEqual([expect.objectContaining({ cue: "stop", delivery: "acknowledged" })]);
    expect(transcript.every((row) => row.seq < cameraCues![0].seq)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledOnce();
    expect(f.controller.getView().status).toBe("listening");
    await f.controller.stop();
  });

  it("keeps the camera through a busy or offline Clef, backing off without counting skipped frames as a gesture", async () => {
    const f = await liveCamera();
    const stop = { present: true, presenceConfidence: 0.95, reaction: "neutral" as const, reactionConfidence: 0.9,
      gesture: "stop" as const, gestureConfidence: 0.93, latencyMs: 250 };
    f.api.analyzeNativeVoiceCamera = vi.fn()
      .mockResolvedValueOnce(stop)
      .mockResolvedValueOnce({ skipped: "busy" })
      .mockResolvedValueOnce({ skipped: "offline" })
      .mockResolvedValue(stop);
    await f.controller.setCamera(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.controller.getView()).toMatchObject({ camera: "on", cameraError: undefined });
    expect(f.controller.getView().cameraDiagnostics).toMatchObject({ skipped: "busy", skippedFrames: 1, filter: "Clef busy; retrying" });
    // Backs off 2s, then 4s, instead of queueing more frames behind the busy model.
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.api.analyzeNativeVoiceCamera).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.api.analyzeNativeVoiceCamera).toHaveBeenCalledTimes(3);
    expect(f.controller.getView()).toMatchObject({ camera: "on", cameraError: undefined });
    expect(f.controller.getView().cameraDiagnostics).toMatchObject({ skipped: "offline", filter: "Clef unavailable; retrying" });
    await vi.advanceTimersByTimeAsync(3999);
    expect(f.api.analyzeNativeVoiceCamera).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.controller.getView().cameraDiagnostics).toMatchObject({ skipped: undefined, skippedFrames: 2 });
    // The stop before the busy frames does not pair with the one after them.
    expect(f.api.sendNativeVoiceCameraCue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledExactlyOnceWith({ sessionId: "fixture-session", cue: "stop" });
    await f.controller.stop();
  });

  it("follows main's pacing when Clef reports work in flight, without growing the backoff", async () => {
    const f = await liveCamera();
    const neutral = { present: true, presenceConfidence: 0.95, reaction: "neutral" as const, reactionConfidence: 0.9, latencyMs: 250 };
    f.api.analyzeNativeVoiceCamera = vi.fn()
      .mockResolvedValueOnce({ skipped: "busy" })
      .mockResolvedValueOnce({ skipped: "busy", inFlight: 1, retryAfterMs: 1000 })
      .mockResolvedValueOnce({ skipped: "busy", inFlight: 1, retryAfterMs: 1000 })
      .mockResolvedValue(neutral);
    await f.controller.setCamera(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.controller.getView().cameraDiagnostics).toMatchObject({ skipped: "busy", inFlight: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.api.analyzeNativeVoiceCamera).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.api.analyzeNativeVoiceCamera).toHaveBeenCalledTimes(4);
    expect(f.controller.getView().cameraDiagnostics).toMatchObject({ skipped: undefined, inFlight: undefined });
    await f.controller.stop();
  });

  it("offers the camera only when Settings has a decision model that reads it", async () => {
    for (const [camera, offered] of [
      [{ available: true }, true],
      [{ available: false, reason: "Choose a decision model in Settings → AI Providers to use camera cues." }, false],
      [undefined, false],
    ] as const) {
      const f = fixture();
      vi.mocked(f.api.nativeVoiceCapability).mockResolvedValue({ available: true, ...(camera ? { camera } : {}) });
      const start = f.controller.start("fixture-thread");
      await vi.waitFor(() => expect(f.api.startNativeVoice).toHaveBeenCalledOnce());
      f.connect();
      await start;
      expect(f.controller.getView().cameraOffered).toBe(offered);
      await f.controller.stop();
    }
  });

  describe("conversation-aware repeats", () => {
    // No confident vibe, so only the gesture and presence decide.
    const stop = { present: true, presenceConfidence: 0.95, reaction: "neutral" as const, reactionConfidence: 0.5,
      gesture: "stop" as const, gestureConfidence: 0.93, latencyMs: 250 };
    const say = (f: Awaited<ReturnType<typeof liveCamera>>, role: "user" | "assistant", text: string) =>
      f.send({ sessionId: "fixture-session", type: "transcript", role, text, done: true });

    it("does not re-send an acknowledged stop held across frames, and re-arms it on a substantive line", async () => {
      const f = await liveCamera();
      f.api.analyzeNativeVoiceCamera = vi.fn(async () => stop);
      const check = vi.fn<NonNullable<NativeVoiceApi["checkNativeVoiceCameraRepeat"]>>(async () => ({ movedOn: 0.06 }));
      f.api.checkNativeVoiceCameraRepeat = check;
      say(f, "user", "Make every cloud in the scene pink.");
      await vi.advanceTimersByTimeAsync(4000);
      say(f, "assistant", "Sure, I'll turn every cloud pink.");
      await f.controller.setCamera(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledExactlyOnceWith({ sessionId: "fixture-session", cue: "stop" });
      // Held while the voice says nothing: no check, no cue.
      await vi.advanceTimersByTimeAsync(5000);
      expect(check).not.toHaveBeenCalled();
      say(f, "assistant", "Okay, pausing.");
      await vi.advanceTimersByTimeAsync(2000);
      expect(check).toHaveBeenCalledOnce();
      expect(check.mock.calls[0]![0]).toEqual({ sessionId: "fixture-session", conversation: [
        { ago: 10, speaker: "operator", text: "Make every cloud in the scene pink." },
        { ago: 6, speaker: "voice", text: "Sure, I'll turn every cloud pink." },
        { ago: 6, speaker: "cue", text: "stop (delivered)" },
        { ago: 1, speaker: "voice", text: "Okay, pausing." },
      ] });
      expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledOnce();
      expect(f.controller.getView().cameraDiagnostics?.repeatCheck).toMatchObject({ cue: "stop", movedOn: 0.06 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(check).toHaveBeenCalledOnce();
      check.mockResolvedValue({ movedOn: 0.96 });
      say(f, "assistant", "Got it, I'm deleting all the whipped cream off every apple pie instead of the clouds.");
      await vi.advanceTimersByTimeAsync(500);
      expect(check).toHaveBeenCalledTimes(2);
      expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledTimes(2);
      expect(f.controller.getView().cameraCues?.map((row) => row.cue)).toEqual(["stop", "stop"]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledTimes(2);
      await f.controller.stop();
    });

    it("holds a repeat when Clef cannot judge the conversation, backing off instead of asking every frame", async () => {
      const f = await liveCamera();
      f.api.analyzeNativeVoiceCamera = vi.fn(async () => stop);
      f.api.checkNativeVoiceCameraRepeat = vi.fn()
        .mockResolvedValueOnce({ skipped: "offline" })
        .mockResolvedValueOnce({ skipped: "busy", inFlight: 1, retryAfterMs: 1000 })
        .mockResolvedValue({ movedOn: 0.9 });
      await f.controller.setCamera(true);
      await vi.advanceTimersByTimeAsync(500);
      say(f, "assistant", "Here is a new plan for the pies.");
      await vi.advanceTimersByTimeAsync(500);
      expect(f.api.checkNativeVoiceCameraRepeat).toHaveBeenCalledOnce();
      // Held for two seconds, not re-asked on each frame.
      await vi.advanceTimersByTimeAsync(1500);
      expect(f.api.checkNativeVoiceCameraRepeat).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(500);
      expect(f.api.checkNativeVoiceCameraRepeat).toHaveBeenCalledTimes(2);
      expect(f.controller.getView().cameraDiagnostics?.repeatCheck).toMatchObject({ cue: "stop", movedOn: undefined });
      expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledOnce();
      expect(f.controller.getView()).toMatchObject({ camera: "on", cameraError: undefined });
      // Main's retry hint while a decision is in flight: one second.
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.api.checkNativeVoiceCameraRepeat).toHaveBeenCalledTimes(3);
      expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledTimes(2);
      expect(f.controller.getView().cameraDiagnostics?.repeatCheck).toMatchObject({ movedOn: 0.9 });
      await f.controller.stop();
    });

    it("stops the camera when the decision model refuses the check, as it does for a frame", async () => {
      const f = await liveCamera();
      f.api.analyzeNativeVoiceCamera = vi.fn(async () => stop);
      f.api.checkNativeVoiceCameraRepeat = vi.fn(async () => {
        throw new Error("Error invoking remote method 'native-voice:camera-repeat': Error: Camera cues stopped: the local decision model refused its API key. Check it in Settings → AI Providers.");
      });
      await f.controller.setCamera(true);
      await vi.advanceTimersByTimeAsync(500);
      say(f, "assistant", "Here is a new plan for the pies.");
      await vi.advanceTimersByTimeAsync(500);
      expect(f.controller.getView()).toMatchObject({
        status: "listening", camera: undefined,
        cameraError: "Camera cues stopped: the local decision model refused its API key. Check it in Settings → AI Providers.",
      });
      expect(f.capture.close).toHaveBeenCalledOnce();
      expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledOnce();
      await f.controller.stop();
    });

    it("does not ask about a held stop when the voice only runs a tool", async () => {
      const f = await liveCamera();
      f.api.analyzeNativeVoiceCamera = vi.fn(async () => stop);
      f.api.checkNativeVoiceCameraRepeat = vi.fn(async () => ({ movedOn: 0.9 }));
      await f.controller.setCamera(true);
      await vi.advanceTimersByTimeAsync(500);
      f.send({ sessionId: "fixture-session", type: "action", tool: "stop_turn", ok: true, outcome: "stopped" });
      await vi.advanceTimersByTimeAsync(3000);
      expect(f.api.checkNativeVoiceCameraRepeat).not.toHaveBeenCalled();
      expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledOnce();
      await f.controller.stop();
    });

    it("bounds the excerpt to the last 90 seconds and 12 rows, and never sends a failed cue", async () => {
      const f = await liveCamera();
      f.api.analyzeNativeVoiceCamera = vi.fn(async () => stop);
      const check = vi.fn<NonNullable<NativeVoiceApi["checkNativeVoiceCameraRepeat"]>>(async () => ({ movedOn: 0.1 }));
      f.api.checkNativeVoiceCameraRepeat = check;
      say(f, "user", "This was said long ago.");
      await vi.advanceTimersByTimeAsync(91_000);
      for (let line = 0; line < 14; line++) say(f, line % 2 ? "assistant" : "user", `Line ${line}\n  with   space ${"x".repeat(300)}`);
      f.send({ sessionId: "fixture-session", type: "action", tool: "send_to_thread", ok: true, outcome: "queued" });
      await f.controller.setCamera(true);
      await vi.advanceTimersByTimeAsync(500);
      say(f, "assistant", "Okay.");
      await vi.advanceTimersByTimeAsync(500);
      const { conversation } = check.mock.calls[0]![0];
      expect(conversation).toHaveLength(12);
      expect(conversation.some((line) => line.text.includes("long ago"))).toBe(false);
      expect(conversation.slice(-3).map((line) => [line.speaker, line.text])).toEqual([
        ["action", "send_to_thread queued"], ["cue", "stop (delivered)"], ["voice", "Okay."],
      ]);
      expect(conversation.every((line) => line.text.length <= 240 && !/\s{2}|\n/.test(line.text))).toBe(true);
      await f.controller.stop();
    });

    it("does not re-send away while the operator is still gone", async () => {
      const f = await liveCamera();
      const away = { present: false, presenceConfidence: 0.95, reaction: "neutral" as const, reactionConfidence: 0.9, latencyMs: 400 };
      f.api.analyzeNativeVoiceCamera = vi.fn()
        .mockResolvedValueOnce(away).mockResolvedValueOnce(away).mockResolvedValueOnce(away).mockResolvedValueOnce(away)
        .mockResolvedValueOnce({ skipped: "busy" })
        .mockResolvedValue(away);
      await f.controller.setCamera(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.api.sendNativeVoiceCameraCue).toHaveBeenCalledExactlyOnceWith({ sessionId: "fixture-session", cue: "away" });
      expect(f.controller.getView().cameraDiagnostics?.filter).toBe("Away already reported");
      expect(f.controller.getView().cameraCues?.map((row) => row.cue)).toEqual(["away"]);
      await f.controller.stop();
    });

    it("keeps presence steady while the operator sits half out of frame", async () => {
      const f = await liveCamera();
      const present = { present: true, presenceConfidence: 0.9, reaction: "neutral" as const, reactionConfidence: 0.9, latencyMs: 400 };
      const away = { ...present, present: false };
      const frames = [present, present, present, present, away, away, away, away];
      // Runs of four frames: 1.5 seconds each way, enough to flip a plain debounce.
      for (let flap = 0; flap < 6; flap++) frames.push(present, present, present, present, away, away, away, away);
      f.api.analyzeNativeVoiceCamera = vi.fn(async () => frames.shift() ?? present);
      await f.controller.setCamera(true);
      await vi.advanceTimersByTimeAsync(500 * 56);
      expect(vi.mocked(f.api.sendNativeVoiceCameraCue!).mock.calls.map(([request]) => request.cue)).toEqual(["neutral", "away"]);
      // Steady presence for three seconds confirms the return.
      await vi.advanceTimersByTimeAsync(3500);
      expect(vi.mocked(f.api.sendNativeVoiceCameraCue!).mock.calls.map(([request]) => request.cue)).toEqual(["neutral", "away", "neutral"]);
      await f.controller.stop();
    });
  });

  it("shows a camera failure without Electron's IPC wrapper", async () => {
    const f = await liveCamera();
    f.api.analyzeNativeVoiceCamera = vi.fn(async () => {
      throw new Error("Error invoking remote method 'native-voice:camera-frame': Error: Camera cues unavailable. Check that Clef is running at 127.0.0.1:8787.");
    });
    await f.controller.setCamera(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.getView()).toMatchObject({ camera: undefined, cameraError: "Camera cues unavailable. Check that Clef is running at 127.0.0.1:8787." });
    expect(f.controller.getView().status).toBe("listening");
    await f.controller.stop();
  });

  it("exposes a rejected cue route while releasing the camera and keeping voice live", async () => {
    const f = await liveCamera();
    f.api.sendNativeVoiceCameraCue = vi.fn(async () => { throw new Error("appendText rejected"); });
    await f.controller.setCamera(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.controller.getView()).toMatchObject({ status: "listening", cameraError: "appendText rejected",
      cameraDiagnostics: { delivery: "failed", cuesAcknowledged: 0, error: "appendText rejected" } });
    expect(f.controller.getView().camera).toBeUndefined();
    expect(f.capture.close).toHaveBeenCalledOnce();
    await f.controller.stop();
  });

  it("closes a camera that finishes opening after voice ends", async () => {
    const f = await liveCamera();
    const pending = deferred<typeof f.capture>();
    f.platform.camera = vi.fn(() => pending.promise);
    const enabling = f.controller.setCamera(true);
    await Promise.resolve();
    await f.controller.stop();
    pending.resolve(f.capture);
    await enabling;
    expect(f.capture.close).toHaveBeenCalledOnce();
    expect(f.api.analyzeNativeVoiceCamera).not.toHaveBeenCalled();
  });

  it("keeps preview and a single request during cold warmup without counting its stale frame toward absence", async () => {
    const f = await liveCamera();
    const pending = deferred<Awaited<ReturnType<NonNullable<NativeVoiceApi["analyzeNativeVoiceCamera"]>>>>();
    const away = { present: false, presenceConfidence: 0.99, reaction: "neutral" as const, reactionConfidence: 0.9, latencyMs: 400 };
    f.api.analyzeNativeVoiceCamera = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(away);
    await f.controller.setCamera(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.controller.getView()).toMatchObject({ status: "listening", camera: "on", cameraWarming: true });
    expect(f.controller.cameraStream()).toBe(f.capture.stream);
    expect(f.api.analyzeNativeVoiceCamera).toHaveBeenCalledOnce();
    expect(f.api.stopNativeVoice).not.toHaveBeenCalled();
    expect(f.capture.close).not.toHaveBeenCalled();
    pending.resolve(away);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.getView().cameraWarming).toBe(false);
    expect(f.controller.getView().cameraDiagnostics).toMatchObject({ observations: 1, staleObservations: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.api.stopNativeVoice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.api.stopNativeVoice).toHaveBeenCalledOnce();
    expect(f.capture.close).toHaveBeenCalledOnce();
  });

  it("ignores a late decision after opt-out and keeps voice running if Clef fails", async () => {
    const f = await liveCamera();
    const pending = deferred<Awaited<ReturnType<NonNullable<NativeVoiceApi["analyzeNativeVoiceCamera"]>>>>();
    f.api.analyzeNativeVoiceCamera = vi.fn(() => pending.promise);
    await f.controller.setCamera(true);
    await f.controller.setCamera(false);
    pending.resolve({ present: false, presenceConfidence: 0.99, reaction: "neutral", reactionConfidence: 0.9, latencyMs: 400 });
    await Promise.resolve();
    expect(f.api.sendNativeVoiceCameraCue).not.toHaveBeenCalled();
    f.api.analyzeNativeVoiceCamera = vi.fn(async () => { throw new Error("Clef unavailable"); });
    await f.controller.setCamera(true);
    await Promise.resolve();
    expect(f.controller.getView()).toMatchObject({ status: "listening", cameraError: "Clef unavailable" });
    expect(f.controller.getView().camera).toBeUndefined();
    await f.controller.stop();
  });

  it("ends voice and camera after sustained absence", async () => {
    const f = await liveCamera();
    f.api.analyzeNativeVoiceCamera = vi.fn(async () => ({ present: false, presenceConfidence: 0.95, reaction: "neutral" as const, reactionConfidence: 0.9, latencyMs: 400 }));
    await f.controller.setCamera(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.api.stopNativeVoice).toHaveBeenCalledOnce();
    expect(f.capture.close).toHaveBeenCalledOnce();
    expect(f.controller.getView()).toMatchObject({ status: "idle", endedAfterAway: true });
  });
});
