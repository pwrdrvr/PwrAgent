import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const registry = vi.hoisted(() => ({
  getCodexProtocolCaptureStatus: vi.fn(),
  startCodexProtocolCapture: vi.fn(),
  stopCodexProtocolCapture: vi.fn(),
}));

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

vi.mock("../diagnostics/manual-heap-snapshot", () => ({
  captureHeapSnapshot: vi.fn(),
}));

vi.mock("../profile", () => ({
  resolveActiveProfilePath: vi.fn(() => "/diagnostics"),
}));

vi.mock("../window-channels", () => ({
  subscribersForChannel: vi.fn(() => []),
}));

describe("diagnostics ipc", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { disposeDiagnosticsIpcHandlers } = await import("../ipc/diagnostics");
    disposeDiagnosticsIpcHandlers();
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

    const { registerDiagnosticsIpcHandlers } = await import("../ipc/diagnostics");
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
