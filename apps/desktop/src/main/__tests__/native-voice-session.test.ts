import { describe, expect, it, vi } from "vitest";
import { NativeVoiceSessionManager } from "../codex-app-server/native-voice-session";
import { supportsNativeVoice, type NativeVoiceBackend, type NativeVoiceNotification } from "../codex-app-server/native-voice-protocol";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const events = new Set<(event: NativeVoiceNotification) => void>();
  const disconnects = new Set<() => void>();
  const backend: NativeVoiceBackend = {
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), text: vi.fn(async () => {}), release: vi.fn(),
    onEvent: (listener) => { events.add(listener); return () => { events.delete(listener); }; },
    onDisconnect: (listener) => { disconnects.add(listener); return () => { disconnects.delete(listener); }; },
  };
  const acquire = vi.fn(async () => backend);
  const manager = new NativeVoiceSessionManager(acquire);
  const emit = vi.fn();
  const request = { threadId: "fixture-thread", sessionId: "fixture-session", sdp: "v=0\r\nfixture" };
  const send = (event: NativeVoiceNotification) => { for (const listener of events) listener(event); };
  return { backend, acquire, manager, emit, request, events, disconnects, send };
}

describe("native voice ownership", () => {
  it("gates older and missing versions while allowing the negotiated managed runtime", () => {
    expect(supportsNativeVoice("codex/0.153.4")).toBe(false);
    expect(supportsNativeVoice()).toBe(false);
    expect(supportsNativeVoice("client/1.0.0 codex/0.153.4")).toBe(false);
    expect(supportsNativeVoice("codex/0.159.0-pwragent.1")).toBe(true);
  });

  it("starts WebRTC v3 with automatic coding handoffs and stops without interrupting a turn", async () => {
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    expect(f.backend.start).toHaveBeenCalledWith(expect.objectContaining({ version: "v3", outputModality: "audio", clientManagedHandoffs: false, flushTranscriptTailOnSessionEnd: false, transport: { type: "webrtc", sdp: f.request.sdp } }));
    f.send({ method: "thread/realtime/sdp", params: { threadId: "other-thread", sdp: "ignored" } });
    expect(f.emit).not.toHaveBeenCalled();
    f.send({ method: "thread/realtime/transcript/done", params: { threadId: f.request.threadId, role: "user", text: "Steer the coding task." } });
    expect(f.emit).toHaveBeenCalledWith({ sessionId: f.request.sessionId, type: "transcript", role: "user", text: "Steer the coding task.", done: true });
    await f.manager.text(1, { sessionId: f.request.sessionId, text: "Check progress." });
    expect(f.backend.text).toHaveBeenCalledWith(f.request.threadId, "Check progress.");
    await f.manager.stop(1, f.request);
    expect(f.backend.stop).toHaveBeenCalledExactlyOnceWith(f.request.threadId);
    expect(f.backend.release).toHaveBeenCalledOnce();
    expect(f.events.size + f.disconnects.size).toBe(0);
  });

  it("rejects duplicate starts and refuses controls from another window or stale session", async () => {
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    await expect(f.manager.start(2, { ...f.request, sessionId: "second" }, f.emit)).rejects.toThrow("already open");
    await f.manager.stop(2, f.request);
    await f.manager.stop(1, { sessionId: "stale" });
    expect(f.backend.stop).not.toHaveBeenCalled();
    await expect(f.manager.text(2, { ...f.request, text: "ignored" })).rejects.toThrow("this window");
    await f.manager.stopOwner(1);
  });

  it("stops a late accepted startup before allowing a new session", async () => {
    const f = fixture();
    const started = deferred<void>();
    vi.mocked(f.backend.start).mockReturnValue(started.promise);
    const start = f.manager.start(1, f.request, f.emit);
    await vi.waitFor(() => expect(f.backend.start).toHaveBeenCalledOnce());
    const stop = f.manager.stop(1, f.request);
    f.send({ method: "thread/realtime/sdp", params: { threadId: f.request.threadId, sdp: "stale-answer" } });
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.backend.stop).not.toHaveBeenCalled();
    await expect(f.manager.start(1, f.request, f.emit)).rejects.toThrow("already open");
    started.resolve();
    await start;
    await stop;
    expect(f.backend.stop).toHaveBeenCalledOnce();
  });

  it("releases acquisition failures and backend disconnects", async () => {
    const f = fixture();
    f.acquire.mockRejectedValueOnce(new Error("Voice access unavailable."));
    await expect(f.manager.start(1, f.request, f.emit)).rejects.toThrow("unavailable");
    await vi.waitFor(() => expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "closed" })));
    await f.manager.start(1, f.request, f.emit);
    for (const disconnect of [...f.disconnects]) disconnect();
    await vi.waitFor(() => expect(f.backend.release).toHaveBeenCalledOnce());
    expect(f.backend.stop).not.toHaveBeenCalled();
  });

  it("keeps ownership after a failed stop and permits an explicit retry", async () => {
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    vi.mocked(f.backend.stop).mockRejectedValueOnce(new Error("stop failed"));
    await expect(f.manager.stop(1, f.request)).rejects.toThrow("stop failed");
    expect(f.backend.release).not.toHaveBeenCalled();
    await expect(f.manager.start(2, f.request, f.emit)).rejects.toThrow("already open");
    await f.manager.stop(1, f.request);
    expect(f.backend.release).toHaveBeenCalledOnce();
  });

  it("cleans startup accepted by RPC but rejected by the service", async () => {
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    f.send({ method: "thread/realtime/error", params: { threadId: f.request.threadId, message: "Voice rollout unavailable." } });
    await vi.waitFor(() => expect(f.backend.release).toHaveBeenCalledOnce());
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "Voice rollout unavailable." }));
  });
});
