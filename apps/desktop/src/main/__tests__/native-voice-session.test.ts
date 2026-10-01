import { describe, expect, it, vi } from "vitest";
import { NATIVE_VOICE_PROMPTS, NativeVoiceSessionManager } from "../codex-app-server/native-voice-session";
import {
  describeNativeVoiceAction,
  supportsNativeVoice,
  type NativeVoiceBackend,
  type NativeVoiceNotification,
  type NativeVoiceToolCall,
} from "../codex-app-server/native-voice-protocol";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const events = new Set<(event: NativeVoiceNotification) => void>();
  const disconnects = new Set<() => void>();
  const toolCalls = new Set<(call: NativeVoiceToolCall) => void>();
  const backend: NativeVoiceBackend = {
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), text: vi.fn(async () => {}), release: vi.fn(),
    onEvent: (listener) => { events.add(listener); return () => { events.delete(listener); }; },
    onDisconnect: (listener) => { disconnects.add(listener); return () => { disconnects.delete(listener); }; },
    onToolCall: (listener) => { toolCalls.add(listener); return () => { toolCalls.delete(listener); }; },
  };
  const acquire = vi.fn(async () => backend);
  const manager = new NativeVoiceSessionManager(acquire);
  const emit = vi.fn();
  const request = { threadId: "fixture-thread", sessionId: "fixture-session", sdp: "v=0\r\nfixture" };
  const send = (event: NativeVoiceNotification) => { for (const listener of events) listener(event); };
  const call = (toolCall: NativeVoiceToolCall) => { for (const listener of toolCalls) listener(toolCall); };
  return { backend, acquire, manager, emit, request, events, disconnects, toolCalls, send, call };
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

  it("tells the realtime model which mode it is in", async () => {
    const thread = fixture();
    await thread.manager.start(1, thread.request, thread.emit);
    expect(thread.backend.start).toHaveBeenCalledWith(expect.objectContaining({ prompt: NATIVE_VOICE_PROMPTS.thread }));
    await thread.manager.stopOwner(1);
    const overseer = fixture();
    await overseer.manager.start(1, { ...overseer.request, mode: "overseer" }, overseer.emit);
    expect(overseer.backend.start).toHaveBeenCalledWith(expect.objectContaining({ prompt: NATIVE_VOICE_PROMPTS.overseer }));
    expect(NATIVE_VOICE_PROMPTS.overseer).toContain("read_operator_focus");
    await overseer.manager.stopOwner(1);
  });

  it("reports only its own thread's tool calls as receipts, and stops listening when it ends", async () => {
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    const result = (data: unknown, success = true) => ({ success, contentItems: [{ type: "inputText", text: JSON.stringify(data) }] });
    f.call({ threadId: "other-thread", tool: "steer_thread", response: result({ disposition: "steered" }) });
    expect(f.emit).not.toHaveBeenCalled();
    f.call({
      threadId: f.request.threadId,
      tool: "send_message_to_thread",
      response: result({ threadLink: "[Sample target](pwragent://thread/codex/sample)", queueStatus: "queued", instanceId: "sample-peer" }),
    });
    expect(f.emit).toHaveBeenCalledWith({
      sessionId: f.request.sessionId, type: "action", tool: "send_message_to_thread", ok: true,
      target: "Sample target", instance: "sample-peer", outcome: "queued",
    });
    await f.manager.stop(1, f.request);
    expect(f.toolCalls.size).toBe(0);
  });
});

describe("native voice receipts", () => {
  it("reads disposition and title from PwrAgent tool results and never more than the tool said", () => {
    const response = (text: string, success = true) => ({ success, contentItems: [{ type: "inputText", text }] });
    expect(describeNativeVoiceAction({ threadId: "t", tool: "steer_thread", response: response(JSON.stringify({ disposition: "started" })) }))
      .toEqual({ tool: "steer_thread", ok: true, outcome: "started" });
    expect(describeNativeVoiceAction({ threadId: "t", tool: "handoff_task", response: response(JSON.stringify({ title: "Sample handoff" })) }))
      .toEqual({ tool: "handoff_task", ok: true, target: "Sample handoff" });
    expect(describeNativeVoiceAction({ threadId: "t", tool: "stop_thread", response: response("not json", false) }))
      .toEqual({ tool: "stop_thread", ok: false });
    expect(describeNativeVoiceAction({ threadId: "t", tool: "read_thread", response: undefined }))
      .toEqual({ tool: "read_thread", ok: false });
  });
});
