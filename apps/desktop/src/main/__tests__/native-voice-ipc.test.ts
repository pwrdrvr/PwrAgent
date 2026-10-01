import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_VOICE_OPEN_MANAGER_CHANNEL,
  NATIVE_VOICE_START_CHANNEL,
  NATIVE_VOICE_STOP_CHANNEL,
  OPERATOR_FOCUS_PUBLISH_CHANNEL,
} from "../../shared/native-voice";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<void>>(),
  check: vi.fn(), request: vi.fn(), start: vi.fn(async () => {}), stop: vi.fn(async () => {}), release: vi.fn(),
  mainWindowIds: new Set<number>(),
  openManager: vi.fn(async () => ({ status: "ready", threadId: "sample-voice-manager", created: false })),
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
      text: vi.fn(), onEvent: () => () => {}, onDisconnect: () => () => {},
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

beforeEach(() => { mocks.handlers.clear(); mocks.check.mockClear(); mocks.request.mockClear(); registerNativeVoiceIpcHandlers(); });

describe("native voice IPC permission boundary", () => {
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
    callbacks.get("destroyed")!();
    expect(check(sender, "media", "", { mediaType: "audio", isMainFrame: true })).toBe(false);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledExactlyOnceWith("fixture-thread"));
    expect(mocks.release).toHaveBeenCalledOnce();
    await mocks.handlers.get(NATIVE_VOICE_STOP_CHANNEL)!({ sender }, { sessionId: "fixture-session" });
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
  });
});
