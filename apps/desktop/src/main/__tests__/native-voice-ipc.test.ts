import { beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_VOICE_START_CHANNEL, NATIVE_VOICE_STOP_CHANNEL } from "../../shared/native-voice";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<void>>(),
  check: vi.fn(), request: vi.fn(), start: vi.fn(async () => {}), stop: vi.fn(async () => {}), release: vi.fn(),
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
import { registerNativeVoiceIpcHandlers } from "../ipc/native-voice";

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
});
