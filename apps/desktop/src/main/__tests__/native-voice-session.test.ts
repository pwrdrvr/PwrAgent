import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("../log", () => ({ getMainLogger: () => log }));
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
  // Codex names the CLIENT before its own version, so the managed runtime
  // reports `pwragent-desktop/<codex version>`, never `codex/...`. A gate that
  // looked for a "codex" token refused the runtime it was verified against.
  it.each([
    { userAgent: "pwragent-desktop/0.159.0-pwragent.1 (Mac OS 26.6.2; arm64) unknown", supported: true },
    { userAgent: "pwragent-desktop/0.160.2 (Linux; x86_64) unknown", supported: true },
    { userAgent: "pwragent-desktop/1.0.0 (Mac OS 26.6.2; arm64) unknown", supported: true },
    { userAgent: "codex/0.159.0-pwragent.1", supported: true },
    { userAgent: "pwragent-desktop/0.158.9-pwragent.4 (Mac OS 26.6.2; arm64) unknown", supported: false },
    { userAgent: "codex/0.153.4", supported: false },
    { userAgent: "pwragent-desktop (Mac OS 26.6.2; arm64)", supported: false },
    { userAgent: undefined, supported: false },
  ])("gates live voice on the App Server version in $userAgent", ({ userAgent, supported }) => {
    expect(supportsNativeVoice(userAgent)).toBe(supported);
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
    // v3 appends typed text as context with no speaker; the label says whose it is.
    expect(f.backend.text).toHaveBeenCalledWith(f.request.threadId, "[Typed message] Check progress.");
    await f.manager.stop(1, f.request);
    expect(f.backend.stop).toHaveBeenCalledExactlyOnceWith(f.request.threadId);
    expect(f.backend.release).toHaveBeenCalledOnce();
    expect(f.events.size + f.disconnects.size).toBe(0);
  });

  it("sends opted-in camera observations as developer context and revokes camera access on stop", async () => {
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    await expect(f.manager.cameraCue(1, { ...f.request, cue: "enthusiastic" })).rejects.toThrow("Enable the camera");
    await f.manager.setCamera(1, f.request.sessionId, true);
    expect(f.manager.allowsCamera(1)).toBe(true);
    expect(f.manager.allowsCamera(2)).toBe(false);
    await expect(f.manager.cameraCue(2, { ...f.request, cue: "enthusiastic" })).rejects.toThrow("Enable the camera");
    await f.manager.cameraCue(1, { ...f.request, cue: "enthusiastic" });
    expect(f.backend.text).toHaveBeenLastCalledWith(f.request.threadId, expect.stringContaining("this is not approval for actions"), "developer");
    expect(f.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "transcript" }));
    await f.manager.cameraCue(1, { ...f.request, cue: "stop" });
    expect(f.backend.text).toHaveBeenLastCalledWith(f.request.threadId, expect.stringContaining("Pause your reply and do not initiate another action"), "developer");
    await f.manager.stop(1, f.request);
    expect(f.manager.allowsCamera(1)).toBe(false);
    await expect(f.manager.cameraCue(1, { ...f.request, cue: "away" })).rejects.toThrow("Enable the camera");
  });

  it("submits camera status even before a confident frame and invalidates observations on opt-out", async () => {
    const f = fixture();
    await f.manager.start(1, { ...f.request, mode: "director" }, f.emit);
    await expect(f.manager.setCamera(2, f.request.sessionId, true)).rejects.toThrow("No voice session");
    await expect(f.manager.setCamera(1, "old-session", true)).rejects.toThrow("No voice session");
    expect(f.backend.text).not.toHaveBeenCalled();
    await f.manager.setCamera(1, f.request.sessionId, true);
    expect(f.backend.text).toHaveBeenLastCalledWith(f.request.threadId, expect.stringContaining("no confident observation has been submitted"), "developer");
    await f.manager.setCamera(1, f.request.sessionId, true);
    expect(f.backend.text).toHaveBeenCalledTimes(1);
    await f.manager.cameraCue(1, { ...f.request, cue: "head_nod" });
    expect(f.backend.text).toHaveBeenLastCalledWith(f.request.threadId, expect.stringContaining("operator nodded yes"), "developer");
    await f.manager.setCamera(1, f.request.sessionId, false);
    expect(f.backend.text).toHaveBeenLastCalledWith(f.request.threadId, expect.stringContaining("Previous observations are historical"), "developer");
    expect(f.manager.allowsCamera(1)).toBe(false);
    expect(f.manager.allowsMicrophone(1)).toBe(true);
    await f.manager.stopOwner(1);
    await f.manager.start(1, { ...f.request, sessionId: "next-session" }, f.emit);
    expect(f.manager.allowsCamera(1)).toBe(false);
    await f.manager.stopOwner(1);
  });

  it("fails camera enable without stopping voice when status context is refused", async () => {
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    vi.mocked(f.backend.text).mockRejectedValueOnce(new Error("Status refused"));
    await expect(f.manager.setCamera(1, f.request.sessionId, true)).rejects.toThrow("Status refused");
    expect(f.manager.allowsCamera(1)).toBe(false);
    expect(f.manager.allowsMicrophone(1)).toBe(true);
    await f.manager.stopOwner(1);
  });

  it("revokes capture before a disabled-status response, including when submission fails", async () => {
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    await f.manager.setCamera(1, f.request.sessionId, true);
    const pending = deferred<void>();
    vi.mocked(f.backend.text).mockReturnValueOnce(pending.promise);
    const disabled = f.manager.setCamera(1, f.request.sessionId, false);
    expect(f.manager.allowsCamera(1)).toBe(false);
    await expect(f.manager.cameraCue(1, { ...f.request, cue: "stop" })).rejects.toThrow("Enable the camera");
    pending.resolve();
    await disabled;
    await f.manager.setCamera(1, f.request.sessionId, true);
    vi.mocked(f.backend.text).mockRejectedValueOnce(new Error("Status refused"));
    await expect(f.manager.setCamera(1, f.request.sessionId, false)).rejects.toThrow("Status refused");
    expect(f.manager.allowsCamera(1)).toBe(false);
    expect(f.manager.allowsMicrophone(1)).toBe(true);
    await f.manager.stopOwner(1);
  });

  it("does not let an earlier enable failure revoke a later enable", async () => {
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    let reject!: (error: Error) => void;
    vi.mocked(f.backend.text).mockReturnValueOnce(new Promise<void>((_, no) => { reject = no; }));
    const enabled = f.manager.setCamera(1, f.request.sessionId, true);
    const refused = expect(enabled).rejects.toThrow("Earlier failure");
    await f.manager.setCamera(1, f.request.sessionId, false);
    await f.manager.setCamera(1, f.request.sessionId, true);
    reject(new Error("Earlier failure"));
    await refused;
    expect(f.manager.allowsCamera(1)).toBe(true);
    await f.manager.stopOwner(1);
  });

  it("awaits camera appendText acknowledgment on the owning thread and propagates rejection", async () => {
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    await f.manager.setCamera(1, f.request.sessionId, true);
    const pending = deferred<void>();
    vi.mocked(f.backend.text).mockImplementationOnce(() => pending.promise);
    let acknowledged = false;
    const cue = f.manager.cameraCue(1, { ...f.request, cue: "neutral" }).then(() => { acknowledged = true; });
    await Promise.resolve();
    expect(f.backend.text).toHaveBeenCalledWith("fixture-thread", expect.stringContaining("operator is visible"), "developer");
    expect(acknowledged).toBe(false);
    pending.resolve();
    await cue;
    expect(acknowledged).toBe(true);
    vi.mocked(f.backend.text).mockRejectedValueOnce(new Error("RPC rejected"));
    await expect(f.manager.cameraCue(1, { ...f.request, cue: "bored" })).rejects.toThrow("RPC rejected");
    expect(f.manager.allowsMicrophone(1)).toBe(true);
    await f.manager.stop(1, f.request);
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
    expect(thread.backend.start).toHaveBeenCalledWith(expect.objectContaining({ prompt: NATIVE_VOICE_PROMPTS.thread, includeStartupContext: true }));
    await thread.manager.stopOwner(1);
    const director = fixture();
    await director.manager.start(1, { ...director.request, mode: "director" }, director.emit);
    // Startup context replays the Voice manager's last request, which the
    // realtime model then answers again before the operator says anything.
    expect(director.backend.start).toHaveBeenCalledWith(expect.objectContaining({ prompt: NATIVE_VOICE_PROMPTS.director, includeStartupContext: false }));
    expect(NATIVE_VOICE_PROMPTS.director).toContain("read_operator_focus");
    await director.manager.stopOwner(1);
  });

  it("reports only its own thread's tool calls as receipts, and stops listening when it ends", async () => {
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    const result = (data: unknown, success = true) => ({ success, contentItems: [{ type: "inputText", text: JSON.stringify(data) }] });
    f.call({ threadId: "other-thread", tool: "steer_thread", response: result({ disposition: "steered" }) });
    expect(f.emit).not.toHaveBeenCalled();
    const sent = { threadLink: "[Sample target](pwragent://thread/codex/sample)", queueStatus: "queued", instanceId: "sample-peer" };
    f.call({
      threadId: f.request.threadId,
      tool: "send_message_to_thread",
      namespace: "pwragent",
      arguments: { threadId: "sample", prompt: "Rerun the checks." },
      response: result(sent),
    });
    expect(f.emit).toHaveBeenCalledWith({
      sessionId: f.request.sessionId, type: "action", tool: "send_message_to_thread", ok: true,
      target: "Sample target", instance: "sample-peer", outcome: "queued",
      namespace: "pwragent", arguments: { threadId: "sample", prompt: "Rerun the checks." }, output: JSON.stringify(sent),
    });
    await f.manager.stop(1, f.request);
    expect(f.toolCalls.size).toBe(0);
  });
});

// "Voice ended" with nothing in the log left the cause of a session that
// ended 30 seconds after a mute unknowable. Every stop now names one.
describe("native voice stop causes", () => {
  const stopped = () => log.info.mock.calls.filter(([message]) => message === "native voice session stopped").map(([, fields]) => fields);

  it("logs the renderer's cause, and the first cause wins when the backend ends it first", async () => {
    log.info.mockClear();
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    await f.manager.stop(1, f.request, "muted-idle");
    expect(stopped().at(-1)).toMatchObject({ threadId: f.request.threadId, cause: "muted-idle" });

    const g = fixture();
    await g.manager.start(1, g.request, g.emit);
    g.send({ method: "thread/realtime/closed", params: { threadId: g.request.threadId, reason: "transport_closed" } });
    // The renderer hears the close and stops too; that does not rename the cause.
    await g.manager.stop(1, g.request, "failure");
    expect(stopped().at(-1)).toMatchObject({ cause: "realtime-closed:transport_closed" });

    const h = fixture();
    await h.manager.start(1, h.request, h.emit);
    h.send({ method: "thread/realtime/error", params: { threadId: h.request.threadId, message: "Sample realtime failure." } });
    await vi.waitFor(() => expect(stopped().at(-1)).toMatchObject({ cause: "realtime-error" }));
    expect(log.warn).toHaveBeenCalledWith("native voice realtime error", { threadId: h.request.threadId, message: "Sample realtime failure." });

    const owner = fixture();
    await owner.manager.start(1, owner.request, owner.emit);
    await owner.manager.stopOwner(1, "window-navigated");
    expect(stopped().at(-1)).toMatchObject({ cause: "window-navigated" });
  });

  // Codex cuts a v3 context append over 500 bytes into unlabeled pieces, so
  // a pasted log reached the voice with only its first 500 bytes marked.
  it("sends any typed message as labeled appends Codex will not cut, that rejoin to the message", async () => {
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    await fc.assert(fc.asyncProperty(
      // `size: "max"`: by default fast-check keeps strings short, under the 500-byte cut.
      fc.oneof(
        fc.string({ maxLength: 8000, size: "max" }),
        fc.string({ unit: "grapheme", maxLength: 3000, size: "max" }),
        fc.lorem({ maxCount: 400, size: "max" }),
        fc.string({ maxLength: 40 }),
      ),
      async (text) => {
        vi.mocked(f.backend.text).mockClear();
        await f.manager.text(1, { sessionId: f.request.sessionId, text });
        const sent = vi.mocked(f.backend.text).mock.calls.map(([threadId, part]) => {
          expect(threadId).toBe(f.request.threadId);
          return part;
        });
        for (const part of sent) expect(bytes(part)).toBeLessThanOrEqual(500);
        if (sent.length === 1) {
          expect(sent[0]).toBe(`[Typed message] ${text}`);
          return;
        }
        const bodies = sent.map((part, index) => {
          const label = `[Typed message ${index + 1}/${sent.length}] `;
          expect(part.startsWith(label)).toBe(true);
          return part.slice(label.length);
        });
        expect(bodies.join("")).toBe(text);
      },
    ), { numRuns: 150 });
    await f.manager.stop(1, f.request);
  });

  it("refuses a typed message the voice never received instead of reporting it sent", async () => {
    const f = fixture();
    const acquired = deferred<NativeVoiceBackend>();
    f.acquire.mockReturnValueOnce(acquired.promise);
    const start = f.manager.start(1, f.request, f.emit);
    const sent = f.manager.text(1, { sessionId: f.request.sessionId, text: "Sample message." });
    const stop = f.manager.stop(1, f.request, "backend-closed");
    acquired.resolve(f.backend);
    await start.catch(() => undefined);
    await expect(sent).rejects.toThrow("Voice ended before the message was sent.");
    await stop;
    expect(f.backend.text).not.toHaveBeenCalled();
  });

  it("logs a refused typed message without its text and keeps the session open", async () => {
    log.warn.mockClear();
    const f = fixture();
    await f.manager.start(1, f.request, f.emit);
    vi.mocked(f.backend.text).mockRejectedValueOnce(new Error("Request timed out."));
    await expect(f.manager.text(1, { sessionId: f.request.sessionId, text: "https://example.com/sample/private" })).rejects.toThrow("Request timed out.");
    expect(log.warn).toHaveBeenCalledWith("typed voice message was not accepted", {
      threadId: f.request.threadId, length: "https://example.com/sample/private".length, error: "Request timed out.",
    });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("example.com");
    expect(f.manager.allowsMicrophone(1)).toBe(true);
    await f.manager.stop(1, f.request);
  });
});

describe("native voice receipts", () => {
  it("reads disposition and title from PwrAgent tool results and never more than the tool said", () => {
    const response = (text: string, success = true) => ({ success, contentItems: [{ type: "inputText", text }] });
    expect(describeNativeVoiceAction({ threadId: "t", tool: "steer_thread", response: response(JSON.stringify({ disposition: "started" })) }))
      .toEqual({ tool: "steer_thread", ok: true, outcome: "started", output: "{\"disposition\":\"started\"}" });
    expect(describeNativeVoiceAction({ threadId: "t", tool: "handoff_task", response: response(JSON.stringify({ title: "Sample handoff" })) }))
      .toEqual({ tool: "handoff_task", ok: true, target: "Sample handoff", output: "{\"title\":\"Sample handoff\"}" });
    expect(describeNativeVoiceAction({ threadId: "t", tool: "stop_thread", response: response("not json", false) }))
      .toEqual({ tool: "stop_thread", ok: false, output: "not json" });
    expect(describeNativeVoiceAction({ threadId: "t", tool: "read_thread", response: undefined }))
      .toEqual({ tool: "read_thread", ok: false });
  });
});

describe("native voice receipt details", () => {
  const response = (text: string) => ({ success: true, contentItems: [{ type: "inputText", text }] });

  // The panel expands a receipt into the call it made, so the receipt
  // carries the arguments and result: read_thread names its thread there.
  it("carries the call's arguments, from an object or Codex's JSON string", () => {
    expect(describeNativeVoiceAction({ threadId: "t", tool: "read_thread", arguments: { threadId: "sample" }, response: response("{}") }))
      .toMatchObject({ arguments: { threadId: "sample" } });
    expect(describeNativeVoiceAction({ threadId: "t", tool: "read_thread", arguments: "{\"threadId\":\"sample\"}", response: response("{}") }))
      .toMatchObject({ arguments: { threadId: "sample" } });
    expect(describeNativeVoiceAction({ threadId: "t", tool: "read_thread", arguments: "not json", response: response("{}") }))
      .not.toHaveProperty("arguments");
  });

  // Receipts are memory-only but cross IPC once per call; a large thread
  // read must not ride along whole, and a cut argument object would misstate
  // the call, so arguments are kept whole or dropped.
  it("bounds the result and keeps arguments whole or not at all", () => {
    const read = describeNativeVoiceAction({ threadId: "t", tool: "read_thread", response: response("x".repeat(60_000)) });
    expect(read.output?.startsWith("x".repeat(48_000))).toBe(true);
    expect(read.output).toMatch(/\n… 12,000 more characters$/);
    expect(describeNativeVoiceAction({ threadId: "t", tool: "handoff_task", arguments: { prompt: "y".repeat(5_000) }, response: response("{}") }))
      .not.toHaveProperty("arguments");
  });

  // read_thread returns up to 4,000 characters per message, so a cut would
  // land mid-JSON and the panel could no longer name the thread it read.
  it("keeps an over-bound JSON result parseable by dropping its oldest list items", () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({ role: "assistant", text: `${index}:${"z".repeat(3_000)}` }));
    const read = describeNativeVoiceAction({
      threadId: "t", tool: "read_thread",
      response: response(JSON.stringify({ read: { threadId: "sample", title: "Sample thread", messages } })),
    });
    expect(read.output!.length).toBeLessThanOrEqual(48_000);
    const parsed = JSON.parse(read.output!) as { read: { title: string; messages: Array<{ text: string }> }; receiptOmittedItems: number };
    expect(parsed.read.title).toBe("Sample thread");
    expect(parsed.read.messages.at(-1)!.text.startsWith("39:")).toBe(true);
    expect(parsed.receiptOmittedItems).toBe(40 - parsed.read.messages.length);
  });
});
