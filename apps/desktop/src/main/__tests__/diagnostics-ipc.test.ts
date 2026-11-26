import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const registry = vi.hoisted(() => ({
  getCodexProtocolCaptureStatus: vi.fn(),
  startCodexProtocolCapture: vi.fn(),
  stopCodexProtocolCapture: vi.fn(),
}));
const isLocalMainWindowWebContents = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => registry,
}));

vi.mock("../shell/diagnostics/manual-heap-snapshot", () => ({
  captureHeapSnapshot: vi.fn(),
}));

vi.mock("../profile", () => ({
  resolveActiveProfilePath: vi.fn(() => "/diagnostics"),
}));

vi.mock("../shell/window-channels", () => ({
  isLocalMainWindowWebContents,
  subscribersForChannel: vi.fn(() => []),
}));

describe("diagnostics ipc", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { disposeDiagnosticsIpcHandlers } = await import("../shell/ipc/diagnostics");
    disposeDiagnosticsIpcHandlers();
  });

  it("routes Rearm only from a local main window with a matching capture request", async () => {
    const { registerDiagnosticsIpcHandlers } = await import("../shell/ipc/diagnostics");
    const { HOT_CPU_PROFILE_REARM_CHANNEL } = await import("../../shared/ipc");
    const rearm = vi.fn(() => true);
    registerDiagnosticsIpcHandlers(rearm);
    const invoke = handlers.get(HOT_CPU_PROFILE_REARM_CHANNEL)!;
    const request = { sessionDirectoryName: "hot-cpu-example", profileFilename: "main-hot-0005.cpuprofile" };
    const sender = { id: 1 };
    isLocalMainWindowWebContents.mockImplementation((candidate) => candidate === sender);

    expect(invoke({ sender: { id: 2 } }, request)).toBe(false);
    expect(invoke({ sender }, { ...request, profileFilename: 5 })).toBe(false);
    expect(invoke({ sender }, request)).toBe(true);
    expect(rearm).toHaveBeenCalledExactlyOnceWith(request.sessionDirectoryName, request.profileFilename);
  });

  it("routes Codex protocol capture status, start, and stop", async () => {
    const status = { active: false as const, available: true };
    const active = {
      active: true as const,
      available: true as const,
      captureFilePath: "/diagnostics/protocol-captures/snippet.jsonl",
      startedAt: "2026-08-10T12:00:00.000Z",
    };
    const result = {
      captureFilePath: active.captureFilePath,
      sizeBytes: 1536,
      startedAt: active.startedAt,
      stoppedAt: "2026-08-10T12:00:05.000Z",
    };
    registry.getCodexProtocolCaptureStatus.mockReturnValue(status);
    registry.startCodexProtocolCapture.mockResolvedValue(active);
    registry.stopCodexProtocolCapture.mockResolvedValue(result);

    const { registerDiagnosticsIpcHandlers } = await import("../shell/ipc/diagnostics");
    const {
      DIAGNOSTICS_CODEX_PROTOCOL_CAPTURE_STATUS_CHANNEL,
      DIAGNOSTICS_START_CODEX_PROTOCOL_CAPTURE_CHANNEL,
      DIAGNOSTICS_STOP_CODEX_PROTOCOL_CAPTURE_CHANNEL,
    } = await import("../../shared/ipc");
    registerDiagnosticsIpcHandlers();

    expect(
      handlers.get(DIAGNOSTICS_CODEX_PROTOCOL_CAPTURE_STATUS_CHANNEL)?.({}),
    ).toEqual(status);
    await expect(
      handlers.get(DIAGNOSTICS_START_CODEX_PROTOCOL_CAPTURE_CHANNEL)?.({}),
    ).resolves.toEqual(active);
    await expect(
      handlers.get(DIAGNOSTICS_STOP_CODEX_PROTOCOL_CAPTURE_CHANNEL)?.({}),
    ).resolves.toEqual(result);
  });
});
