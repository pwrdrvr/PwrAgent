import { NATIVE_VOICE_CAMERA_CHANNEL, NATIVE_VOICE_CAMERA_FRAME_CHANNEL, NATIVE_VOICE_CAMERA_CUE_CHANNEL, NATIVE_VOICE_CAMERA_REPEAT_CHANNEL } from "../../shared/native-voice-camera";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCameraConversationLine, VoiceCameraObservation, VoiceCameraRepeatVerdict } from "../../shared/native-voice-camera";
import type { DesktopDecisionModelSettings } from "@pwragent/shared";
import { SystemOneRejected } from "../decision/system-one";
import {
  NATIVE_VOICE_CAPABILITY_CHANNEL,
  NATIVE_VOICE_OPEN_MANAGER_CHANNEL,
  NATIVE_VOICE_START_CHANNEL,
  NATIVE_VOICE_STOP_CHANNEL,
  OPERATOR_FOCUS_PUBLISH_CHANNEL,
} from "../../shared/native-voice";
const mocks = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => Promise<void>>(),
  check: vi.fn(), request: vi.fn(), start: vi.fn(async () => {}), stop: vi.fn(async () => {}), release: vi.fn(),
  classify: vi.fn<(target: { endpoint: string; model: string; apiKey?: string }, images: string[], signal: AbortSignal, warming: boolean) => Promise<VoiceCameraObservation>>(),
  inFlight: vi.fn<(target: { endpoint: string; model: string; apiKey?: string }, signal: AbortSignal) => Promise<number | undefined>>(async () => undefined),
  judge: vi.fn<(target: { endpoint: string; model: string; apiKey?: string }, conversation: VoiceCameraConversationLine[], signal: AbortSignal) => Promise<VoiceCameraRepeatVerdict>>(),
  decisionSettings: { model: "local" } as DesktopDecisionModelSettings,
  decisionApiKey: vi.fn(async (): Promise<string | undefined> => undefined),
  disconnects: new Set<() => void>(),
  mainWindowIds: new Set<number>(), text: vi.fn(async () => {}),
  openManager: vi.fn(async () => ({ status: "ready", threadId: "sample-voice-manager", created: false })),
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ info: mocks.info, warn: mocks.warn }) }));
vi.mock("../native-voice/clef-camera", () => ({ classifyVoiceCamera: mocks.classify, clefRequestsInFlight: mocks.inFlight, judgeVoiceCameraRepeat: mocks.judge }));
vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => ({
    resolveDecisionModelSettings: () => mocks.decisionSettings,
    resolveDecisionApiKey: mocks.decisionApiKey,
  }),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<void>) => { mocks.handlers.set(name, handler); } },
  session: { defaultSession: { setPermissionCheckHandler: mocks.check, setPermissionRequestHandler: mocks.request } },
}));
vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => ({
    nativeVoiceCapability: async () => ({ available: true }),
    acquireNativeVoiceBackend: async () => ({
      start: mocks.start, stop: mocks.stop, release: mocks.release,
      text: mocks.text, onEvent: () => () => {},
      onDisconnect: (listener: () => void) => { mocks.disconnects.add(listener); return () => { mocks.disconnects.delete(listener); }; },
    }),
  }),
}));
vi.mock("../native-voice/voice-manager-thread", () => ({
  isVoiceManagerThread: (threadId: string) => threadId === "sample-voice-manager",
  openVoiceManagerThread: mocks.openManager,
}));
vi.mock("../window-channels", () => ({
  isLocalMainWindowWebContents: (contents?: { id: number }) => Boolean(contents && mocks.mainWindowIds.has(contents.id)),
}));
import { registerNativeVoiceIpcHandlers } from "../ipc/native-voice";
import { readOperatorFocus, resetOperatorFocusRegistry } from "../native-voice/operator-focus-registry";

beforeEach(() => { vi.clearAllMocks(); mocks.decisionSettings = { model: "local" }; mocks.handlers.clear(); registerNativeVoiceIpcHandlers(); });
afterEach(() => vi.useRealTimers());

describe("native voice IPC permission boundary", () => {
  it("allows a minute-long first decision, keeps it single-flight, then uses normal inference limits", async () => {
    vi.useFakeTimers();
    const sender = { id: 277, on: vi.fn(), once: vi.fn(), isDestroyed: () => false, send: vi.fn() };
    const target = { sessionId: "camera-warmup-session" };
    const frame = { ...target, images: ["data:image/jpeg;base64,AA=="] };
    await mocks.handlers.get(NATIVE_VOICE_START_CHANNEL)!({ sender }, { ...target, threadId: "camera-warmup-thread", sdp: "v=0\r\nfixture" });
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { ...target, enabled: true });
    let finish!: (value: VoiceCameraObservation) => void;
    let signal!: AbortSignal;
    mocks.classify.mockImplementationOnce((_target, _image, abort, warming) => {
      expect(warming).toBe(true);
      signal = abort;
      return new Promise((resolve) => { finish = resolve; });
    });
    const pending = mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, frame);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal.aborted).toBe(false);
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, frame)).rejects.toThrow("already being analyzed");
    finish({ present: true, presenceConfidence: 0.9, reaction: "neutral", reactionConfidence: 0.9, latencyMs: 60_000 });
    await pending;
    expect(mocks.info).toHaveBeenCalledWith("camera first decision waiting", { sessionId: target.sessionId });
    expect(mocks.info).toHaveBeenCalledWith("camera first decision received", { sessionId: target.sessionId, elapsedMs: 60_000, modelLatencyMs: 60_000 });
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(frame.images[0]);

    mocks.classify.mockImplementationOnce((_target, _image, abort, warming) => {
      expect(warming).toBe(false);
      signal = abort;
      return new Promise((_resolve, reject) => abort.addEventListener("abort", () => reject(abort.reason), { once: true }));
    });
    // A warm model that misses the window is busy elsewhere: skip the frame,
    // keep the camera, and free the slot for the next one.
    const normal = mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, frame);
    const stops = mocks.stop.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8000);
    await expect(normal).resolves.toEqual({ skipped: "busy" });
    expect(signal.aborted).toBe(true);
    expect(mocks.stop).toHaveBeenCalledTimes(stops);
    // Clef still runs the abandoned request: ask its /health, and send nothing
    // while anything is in flight.
    const classified = mocks.classify.mock.calls.length;
    mocks.inFlight.mockResolvedValueOnce(1);
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, frame))
      .resolves.toEqual({ skipped: "busy", inFlight: 1, retryAfterMs: 1000 });
    expect(mocks.classify).toHaveBeenCalledTimes(classified);
    mocks.inFlight.mockResolvedValueOnce(0);
    mocks.classify.mockImplementationOnce(async (_target, _image, _abort, warming) => {
      expect(warming).toBe(false);
      return { present: true, presenceConfidence: 0.9, reaction: "neutral", reactionConfidence: 0.9, latencyMs: 400 };
    });
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, frame)).resolves.toMatchObject({ latencyMs: 400 });
    // An answer in time ends the contention: the next frame skips the probe.
    const probes = mocks.inFlight.mock.calls.length;
    mocks.classify.mockResolvedValueOnce({ present: true, presenceConfidence: 0.9, reaction: "neutral", reactionConfidence: 0.9, latencyMs: 400 });
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, frame);
    expect(mocks.inFlight).toHaveBeenCalledTimes(probes);
    mocks.classify.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:8787"));
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, frame)).resolves.toEqual({ skipped: "offline" });
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { ...target, enabled: false });
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { ...target, enabled: true });
    mocks.classify.mockImplementationOnce(async (_target, _image, _abort, warming) => {
      expect(warming).toBe(true);
      return { present: true, presenceConfidence: 0.9, reaction: "neutral", reactionConfidence: 0.9, latencyMs: 400 };
    });
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, frame);
    await mocks.handlers.get(NATIVE_VOICE_STOP_CHANNEL)!({ sender }, target);
  });

  it("sends frames only where Settings allows, with the local key read once at camera opt-in", async () => {
    const sender = { id: 279, on: vi.fn(), once: vi.fn(), isDestroyed: () => false, send: vi.fn() };
    const target = { sessionId: "camera-settings-session" };
    const frame = { ...target, images: ["data:image/jpeg;base64,AA=="] };
    const capability = () => mocks.handlers.get(NATIVE_VOICE_CAPABILITY_CHANNEL)!() as unknown as Promise<{ camera?: { available: boolean; reason?: string } }>;
    await mocks.handlers.get(NATIVE_VOICE_START_CHANNEL)!({ sender }, { ...target, threadId: "camera-settings-thread", sdp: "v=0\r\nfixture" });
    // Nothing set up: no camera.
    mocks.decisionSettings = {};
    await expect(capability()).resolves.toMatchObject({ camera: { available: false, reason: expect.stringContaining("Choose a decision model") } });
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { ...target, enabled: true })).rejects.toThrow("Choose a decision model");
    // A hosted decision model never receives camera frames.
    mocks.decisionSettings = { model: "jev" };
    await expect(capability()).resolves.toMatchObject({ camera: { available: false, reason: expect.stringContaining("frames stay on this Mac") } });
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { ...target, enabled: true })).rejects.toThrow("local decision model");
    mocks.decisionSettings = { model: "local", local: { endpoint: "http://localhost:9911" } };
    mocks.decisionApiKey.mockResolvedValueOnce("sample-key");
    await expect(capability()).resolves.toMatchObject({ camera: { available: true } });
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { ...target, enabled: true });
    expect(mocks.decisionApiKey).toHaveBeenCalledExactlyOnceWith("local");
    mocks.classify.mockResolvedValueOnce({ present: true, presenceConfidence: 0.9, reaction: "neutral", reactionConfidence: 0.9, latencyMs: 400 });
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, frame);
    expect(mocks.classify).toHaveBeenLastCalledWith(
      { endpoint: "http://localhost:9911", model: "clef-flash", apiKey: "sample-key" },
      frame.images, expect.any(AbortSignal), true,
    );
    // A refusal repeats on every frame, so it stops the camera with the server's reason.
    mocks.classify.mockRejectedValueOnce(new SystemOneRejected(422, "model must be clef-flash"));
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, frame))
      .rejects.toThrow("Camera cues stopped: the local decision model rejected the request (model must be clef-flash).");
    // Turning cues off mid-session stops the next frame before it is sent.
    const sent = mocks.classify.mock.calls.length;
    mocks.decisionSettings = { model: "local", cameraCues: false };
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, frame)).rejects.toThrow("Camera cues are off");
    expect(mocks.classify).toHaveBeenCalledTimes(sent);
    await mocks.handlers.get(NATIVE_VOICE_STOP_CHANNEL)!({ sender }, target);
  });

  it("bounds a stalled first decision at five minutes while leaving voice running", async () => {
    vi.useFakeTimers();
    const sender = { id: 278, on: vi.fn(), once: vi.fn(), isDestroyed: () => false, send: vi.fn() };
    const target = { sessionId: "camera-warmup-timeout" };
    await mocks.handlers.get(NATIVE_VOICE_START_CHANNEL)!({ sender }, { ...target, threadId: "camera-timeout-thread", sdp: "v=0\r\nfixture" });
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { ...target, enabled: true });
    mocks.classify.mockImplementationOnce((_target, _image, abort) => new Promise((_resolve, reject) => {
      abort.addEventListener("abort", () => reject(abort.reason), { once: true });
    }));
    const pending = mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, { ...target, images: ["data:image/jpeg;base64,AA=="] });
    const rejected = expect(pending).rejects.toThrow("within five minutes");
    const stops = mocks.stop.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    await rejected;
    expect(mocks.stop).toHaveBeenCalledTimes(stops);
    expect(mocks.check.mock.calls[0][0](sender, "media", "", { mediaType: "audio", isMainFrame: true })).toBe(true);
    await mocks.handlers.get(NATIVE_VOICE_STOP_CHANNEL)!({ sender }, target);
  });

  it("allows only the opted-in owner microphone, blocks cameras/frames, and stops on window destruction", async () => {
    const callbacks = new Map<string, (...args: unknown[]) => void>();
    const sender = { id: 77, on: (name: string, callback: (...args: unknown[]) => void) => { callbacks.set(name, callback); },
      once: (name: string, callback: (...args: unknown[]) => void) => { callbacks.set(name, callback); }, isDestroyed: () => false, send: vi.fn() };
    const check = mocks.check.mock.calls[0][0];
    const request = mocks.request.mock.calls[0][0];
    const decide = vi.fn();
    expect(check(sender, "media", "", { mediaType: "audio", isMainFrame: true })).toBe(false);
    await mocks.handlers.get(NATIVE_VOICE_START_CHANNEL)!({ sender }, { threadId: "fixture-thread", sessionId: "fixture-session", sdp: "v=0\r\nfixture" });
    expect(check(sender, "media", "", { mediaType: "audio", isMainFrame: true })).toBe(true);
    expect(check({ id: 88 }, "media", "", { mediaType: "audio", isMainFrame: true })).toBe(false);
    expect(check(sender, "media", "", { mediaType: "video", isMainFrame: true })).toBe(false);
    expect(check(sender, "media", "", { mediaType: "audio", isMainFrame: false })).toBe(false);
    request(sender, "media", decide, { mediaTypes: ["audio"], isMainFrame: true });
    expect(decide).toHaveBeenLastCalledWith(true);
    request(sender, "media", decide, { mediaTypes: ["audio", "video"], isMainFrame: true });
    expect(decide).toHaveBeenLastCalledWith(false);
    request(sender, "media", decide, { mediaTypes: ["audio"], isMainFrame: false });
    expect(decide).toHaveBeenLastCalledWith(false);
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender: { id: 88 } }, { sessionId: "fixture-session", enabled: true })).rejects.toThrow("No voice session");
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, { sessionId: "fixture-session", images: ["data:image/jpeg;base64,AA=="] })).rejects.toThrow("Enable the camera");
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { sessionId: "fixture-session", enabled: true });
    expect(check(sender, "media", "", { mediaType: "video", isMainFrame: true })).toBe(true);
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_CUE_CHANNEL)!({ sender }, { sessionId: "fixture-session", cue: "exasperated" });
    expect(mocks.text).toHaveBeenLastCalledWith("fixture-thread", expect.stringContaining("[Camera observation]"), "developer");
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_CUE_CHANNEL)!({ sender }, { sessionId: "fixture-session", cue: "arbitrary instruction" })).rejects.toThrow("Invalid camera cue");
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_CUE_CHANNEL)!({ sender }, { sessionId: "fixture-session", cue: "none" })).rejects.toThrow("Invalid camera cue");

    expect(check({ id: 88 }, "media", "", { mediaType: "video", isMainFrame: true })).toBe(false);
    request(sender, "media", decide, { mediaTypes: ["video"], isMainFrame: true });
    expect(decide).toHaveBeenLastCalledWith(true);
    const jpeg = "data:image/jpeg;base64,AA==";
    for (const images of [["not an image"], [], [jpeg, jpeg, jpeg, jpeg, jpeg], [jpeg, "data:image/png;base64,AA=="], jpeg]) {
      await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, { sessionId: "fixture-session", images })).rejects.toThrow("Invalid camera frame");
    }
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { sessionId: "fixture-session", enabled: false });
    expect(check(sender, "media", "", { mediaType: "video", isMainFrame: true })).toBe(false);
    callbacks.get("destroyed")!();
    expect(check(sender, "media", "", { mediaType: "audio", isMainFrame: true })).toBe(false);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledExactlyOnceWith("fixture-thread"));
    expect(mocks.release).toHaveBeenCalledOnce();
    await mocks.handlers.get(NATIVE_VOICE_STOP_CHANNEL)!({ sender }, { sessionId: "fixture-session" });
  });

  it("aborts in-flight classification on camera off and preserves voice after a Clef failure", async () => {
    const sender = { id: 177, on: vi.fn(), once: vi.fn(), isDestroyed: () => false, send: vi.fn() };
    const target = { sessionId: "camera-abort-session" };
    await mocks.handlers.get(NATIVE_VOICE_START_CHANNEL)!({ sender }, { ...target, threadId: "camera-abort-thread", sdp: "v=0\r\nfixture" });
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { ...target, enabled: true });
    let signal!: AbortSignal;
    mocks.classify.mockImplementationOnce(async (_target, _image, abort) => {
      signal = abort;
      return await new Promise<never>((_resolve, reject) => abort.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
    });
    const analyzing = mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, { ...target, images: ["data:image/jpeg;base64,AA=="] });
    const cancelled = expect(analyzing).resolves.toBeUndefined();
    await mocks.handlers.get(NATIVE_VOICE_STOP_CHANNEL)!({ sender }, { sessionId: "stale-session" });
    expect(signal.aborted).toBe(false);
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { ...target, enabled: false });
    await cancelled;
    expect(mocks.info).toHaveBeenCalledWith("camera analysis cancelled", expect.objectContaining({ sessionId: target.sessionId }));
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
    expect(mocks.check.mock.calls[0][0](sender, "media", "", { mediaType: "audio", isMainFrame: true })).toBe(true);
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { ...target, enabled: true });
    mocks.classify.mockRejectedValueOnce(new Error("Clef unavailable"));
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, { ...target, images: ["data:image/jpeg;base64,AA=="] })).rejects.toThrow("Camera cues unavailable");
    expect(mocks.check.mock.calls[0][0](sender, "media", "", { mediaType: "audio", isMainFrame: true })).toBe(true);
    await mocks.handlers.get(NATIVE_VOICE_STOP_CHANNEL)!({ sender }, target);
  });

  it.each(["stop", "disconnect"])("aborts a pending frame when voice ends through %s", async (ending) => {
    const sender = { id: 178, on: vi.fn(), once: vi.fn(), isDestroyed: () => false, send: vi.fn() };
    const target = { sessionId: "camera-end-session" };
    await mocks.handlers.get(NATIVE_VOICE_START_CHANNEL)!({ sender }, { ...target, threadId: "camera-end-thread", sdp: "v=0\r\nfixture" });
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { ...target, enabled: true });
    let signal!: AbortSignal;
    mocks.classify.mockImplementationOnce(async (_target, _image, abort) => {
      signal = abort;
      return await new Promise<never>((_resolve, reject) => abort.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
    });
    const cancelled = expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, { ...target, images: ["data:image/jpeg;base64,AA=="] })).resolves.toBeUndefined();
    if (ending === "stop") await mocks.handlers.get(NATIVE_VOICE_STOP_CHANNEL)!({ sender }, target);
    else for (const disconnect of [...mocks.disconnects]) disconnect();
    await cancelled;
    expect(mocks.info).toHaveBeenCalledWith("camera analysis cancelled", expect.objectContaining({ sessionId: target.sessionId }));
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
    expect(mocks.check.mock.calls[0][0](sender, "media", "", { mediaType: "video", isMainFrame: true })).toBe(false);
  });

  it("judges a repeat only for the owner's camera session, validates the excerpt, and never logs it", async () => {
    vi.useFakeTimers();
    const sender = { id: 279, on: vi.fn(), once: vi.fn(), isDestroyed: () => false, send: vi.fn() };
    const target = { sessionId: "camera-repeat-session" };
    const conversation = [{ ago: 6, speaker: "cue", text: "stop (delivered)" }, { ago: 1, speaker: "voice", text: "Private words: okay, pausing." }];
    const check = mocks.handlers.get(NATIVE_VOICE_CAMERA_REPEAT_CHANNEL)!;
    await mocks.handlers.get(NATIVE_VOICE_START_CHANNEL)!({ sender }, { ...target, threadId: "camera-repeat-thread", sdp: "v=0\r\nfixture" });
    await expect(check({ sender }, { ...target, conversation })).rejects.toThrow("Enable the camera");
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_CHANNEL)!({ sender }, { ...target, enabled: true });
    // A warm model: checks only ever follow a frame decision.
    mocks.classify.mockResolvedValueOnce({ present: true, presenceConfidence: 0.9, reaction: "neutral", reactionConfidence: 0.9, latencyMs: 400 });
    await mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, { ...target, images: ["data:image/jpeg;base64,AA=="] });
    await expect(check({ sender: { ...sender, id: 280 } }, { ...target, conversation })).rejects.toThrow("Enable the camera");
    for (const invalid of [
      [{ ago: 6, speaker: "system", text: "stop" }], [{ ago: -1, speaker: "voice", text: "x" }], [{ ago: 1.5, speaker: "voice", text: "x" }],
      [{ ago: 1, speaker: "voice", text: "x".repeat(241) }], Array.from({ length: 13 }, () => ({ ago: 1, speaker: "voice", text: "x" })), "not lines",
    ]) await expect(check({ sender }, { ...target, conversation: invalid })).rejects.toThrow("Invalid camera conversation");
    expect(mocks.judge).not.toHaveBeenCalled();
    // An extra request: skipped while any decision is running, even uncontended.
    mocks.inFlight.mockResolvedValueOnce(2);
    await expect(check({ sender }, { ...target, conversation })).resolves.toEqual({ skipped: "busy", inFlight: 2, retryAfterMs: 1000 });
    expect(mocks.inFlight).toHaveBeenLastCalledWith({ endpoint: "http://127.0.0.1:8787", model: "clef-flash" }, expect.any(AbortSignal));
    expect(mocks.judge).not.toHaveBeenCalled();
    mocks.judge.mockResolvedValueOnce({ movedOn: 0.07 });
    await expect(check({ sender }, { ...target, conversation })).resolves.toEqual({ movedOn: 0.07 });
    expect(mocks.judge).toHaveBeenCalledWith({ endpoint: "http://127.0.0.1:8787", model: "clef-flash" }, conversation, expect.any(AbortSignal));
    mocks.judge.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:8787"));
    await expect(check({ sender }, { ...target, conversation })).resolves.toEqual({ skipped: "offline" });
    mocks.judge.mockImplementationOnce((_target, _conversation, abort) => new Promise((_resolve, reject) => {
      abort.addEventListener("abort", () => reject(abort.reason), { once: true });
    }));
    const slow = check({ sender }, { ...target, conversation });
    // One request per owner: a frame waits for the check.
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, { ...target, images: ["data:image/jpeg;base64,AA=="] })).rejects.toThrow("already being analyzed");
    await vi.advanceTimersByTimeAsync(8000);
    await expect(slow).resolves.toEqual({ skipped: "busy" });
    // A missed deadline also paces the next frame through /health.
    mocks.inFlight.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    await expect(check({ sender }, { ...target, conversation })).resolves.toEqual({ skipped: "busy", inFlight: 1, retryAfterMs: 1000 });
    await expect(mocks.handlers.get(NATIVE_VOICE_CAMERA_FRAME_CHANNEL)!({ sender }, { ...target, images: ["data:image/jpeg;base64,AA=="] }))
      .resolves.toEqual({ skipped: "busy", inFlight: 1, retryAfterMs: 1000 });
    expect(mocks.judge).toHaveBeenCalledTimes(3);
    mocks.inFlight.mockResolvedValueOnce(0);
    mocks.judge.mockResolvedValueOnce({ movedOn: 0.9 });
    await expect(check({ sender }, { ...target, conversation })).resolves.toEqual({ movedOn: 0.9 });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("Private words");
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("Private words");
    // A refusal stops camera cues, as it does for a frame, instead of reading as busy.
    mocks.judge.mockRejectedValueOnce(new SystemOneRejected(422, "model must be clef-flash"));
    await expect(check({ sender }, { ...target, conversation }))
      .rejects.toThrow("Camera cues stopped: the local decision model rejected the request (model must be clef-flash).");
    // The conversation follows the frame's Settings gate: never to a hosted model.
    const judged = mocks.judge.mock.calls.length;
    mocks.decisionSettings = { model: "jev" };
    await expect(check({ sender }, { ...target, conversation })).rejects.toThrow("local decision model");
    expect(mocks.judge).toHaveBeenCalledTimes(judged);
  });

  it("rejects malformed offers before acquiring a session", async () => {
    await expect(mocks.handlers.get(NATIVE_VOICE_START_CHANNEL)!({ sender: { id: 78 } }, { threadId: "fixture", sessionId: "bad/session", sdp: "v=0" })).rejects.toThrow("Invalid voice session");
    await expect(mocks.handlers.get(NATIVE_VOICE_START_CHANNEL)!({ sender: { id: 78 } }, { threadId: "fixture", sessionId: "valid-session", sdp: "bad" })).rejects.toThrow("Invalid WebRTC");
  });

  it("gives the director prompt only to the Voice manager thread", async () => {
    const offer = { sessionId: "director-session", sdp: "v=0\r\nfixture", mode: "director" };
    await expect(mocks.handlers.get(NATIVE_VOICE_START_CHANNEL)!({ sender: { id: 79 } }, { ...offer, threadId: "sample-coding-thread" }))
      .rejects.toThrow("Voice manager thread");
    await expect(mocks.handlers.get(NATIVE_VOICE_START_CHANNEL)!({ sender: { id: 79 } }, { ...offer, threadId: "sample-voice-manager", mode: "conductor" }))
      .rejects.toThrow("Invalid voice mode");
    expect(mocks.start).not.toHaveBeenCalledWith(expect.objectContaining({ threadId: "sample-coding-thread" }));
  });

  it("opens the manager and accepts focus only from a local main window", async () => {
    const window = { id: 90, isDestroyed: () => false, once: vi.fn() };
    const viewer = { id: 91, isDestroyed: () => false, once: vi.fn() };
    mocks.mainWindowIds.clear();
    mocks.mainWindowIds.add(window.id);
    resetOperatorFocusRegistry();
    expect(await mocks.handlers.get(NATIVE_VOICE_OPEN_MANAGER_CHANNEL)!({ sender: viewer })).toMatchObject({ status: "failed" });
    expect(mocks.openManager).not.toHaveBeenCalled();
    expect(await mocks.handlers.get(NATIVE_VOICE_OPEN_MANAGER_CHANNEL)!({ sender: window })).toMatchObject({ status: "ready" });

    const focus = { view: "thread", thread: { backend: "codex", threadId: "sample-thread", title: "Sample thread" } };
    await mocks.handlers.get(OPERATOR_FOCUS_PUBLISH_CHANNEL)!({ sender: viewer }, focus);
    expect(readOperatorFocus()).toBeUndefined();
    await mocks.handlers.get(OPERATOR_FOCUS_PUBLISH_CHANNEL)!({ sender: window }, { ...focus, view: "screen-share" });
    await mocks.handlers.get(OPERATOR_FOCUS_PUBLISH_CHANNEL)!({ sender: window }, { ...focus, thread: { ...focus.thread, backend: "unknown" } });
    expect(readOperatorFocus()).toBeUndefined();
    await mocks.handlers.get(OPERATOR_FOCUS_PUBLISH_CHANNEL)!({ sender: window }, focus);
    expect(readOperatorFocus()?.focus).toEqual(focus);

    // A launchpad is validated like a thread: a known backend, bounded text.
    const launchpad = { view: "thread", launchpad: { projectKey: "dir:/sample", projectLabel: "Sample project", backend: "codex", model: "sample-model" } };
    await mocks.handlers.get(OPERATOR_FOCUS_PUBLISH_CHANNEL)!({ sender: window }, { ...launchpad, launchpad: { ...launchpad.launchpad, backend: "unknown" } });
    await mocks.handlers.get(OPERATOR_FOCUS_PUBLISH_CHANNEL)!({ sender: window }, { ...launchpad, launchpad: { ...launchpad.launchpad, projectKey: "x".repeat(600) } });
    expect(readOperatorFocus()?.focus).toEqual(focus);
    await mocks.handlers.get(OPERATOR_FOCUS_PUBLISH_CHANNEL)!({ sender: window }, launchpad);
    expect(readOperatorFocus()?.focus).toEqual(launchpad);

    // The model reads this as the operator's screen: fields the validator did
    // not check are dropped, at every level, rather than passed through.
    await mocks.handlers.get(OPERATOR_FOCUS_PUBLISH_CHANNEL)!({ sender: window }, {
      ...focus, note: "sample unchecked text", thread: { ...focus.thread, prompt: "sample draft" },
    });
    expect(readOperatorFocus()?.focus).toEqual(focus);
  });
});
