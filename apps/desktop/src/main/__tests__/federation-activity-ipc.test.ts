import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEDERATION_ACTIVITY_TOPMOST_CHANNEL, FEDERATION_OPEN_ACTIVITY_CHANNEL,
  FEDERATION_READ_ACTIVITY_CHANNEL, FEDERATION_SET_ENABLED_CHANNEL,
} from "../../shared/ipc";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  runtime: { activity: vi.fn(), restart: vi.fn() },
  service: { readFederationConfig: vi.fn(), writeConfigPatchTargeted: vi.fn() },
  show: vi.fn(), topmost: vi.fn(), fromWebContents: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(name, handler),
    removeHandler: (name: string) => mocks.handlers.delete(name),
  },
}));
vi.mock("../federation/federation-runtime", () => ({ getDesktopFederationRuntime: () => mocks.runtime }));
vi.mock("../settings/desktop-settings-singleton", () => ({ getDesktopSettingsService: () => mocks.service }));
vi.mock("../federation/federation-window", () => ({ createFederationWindow: vi.fn() }));
vi.mock("../federation/federation-tailscale", () => ({ getFederationTailscaleService: () => ({}) }));
vi.mock("../federation-activity-window", () => ({ showFederationActivityWindow: mocks.show, setFederationActivityTopmost: mocks.topmost }));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.runtime.activity.mockResolvedValue({ configuredMode: "dual", running: false,
    health: { leaseHolder: { instanceId: "holder", processId: 55 }, unavailableReason: "Profile already served" } });
  mocks.runtime.restart.mockResolvedValue(undefined);
  mocks.service.readFederationConfig.mockReturnValue({ mode: "dual" });
  mocks.service.writeConfigPatchTargeted.mockResolvedValue({});
  const { registerFederationIpcHandlers } = await import("../ipc/federation");
  registerFederationIpcHandlers();
});
const invoke = (channel: string, request?: unknown) => mocks.handlers.get(channel)!({ sender: { id: 42 } }, request);

describe("Federation Activity IPC", () => {
  it("reads only local aggregates and forwards the selected history view", async () => {
    await invoke(FEDERATION_READ_ACTIVITY_CHANNEL, { historyPeerId: "peer", historyView: "logical" });
    expect(mocks.runtime.activity).toHaveBeenCalledWith({ includeHistory: true, historyPeerId: "peer", historyView: "logical" });
    expect(mocks.service.writeConfigPatchTargeted).not.toHaveBeenCalled();
    expect(mocks.runtime.restart).not.toHaveBeenCalled();
  });

  it("disables then restores the previous mode and reports actual lease-denied runtime state", async () => {
    await invoke(FEDERATION_SET_ENABLED_CHANNEL, false);
    expect(mocks.service.writeConfigPatchTargeted).toHaveBeenLastCalledWith({ federation: { mode: "disabled" } });
    mocks.service.readFederationConfig.mockReturnValue({ mode: "disabled" });
    const result = await invoke(FEDERATION_SET_ENABLED_CHANNEL, true);
    expect(mocks.service.writeConfigPatchTargeted).toHaveBeenLastCalledWith({ federation: { mode: "dual" } });
    expect(mocks.runtime.restart).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ configuredMode: "dual", running: false, health: { leaseHolder: { instanceId: "holder" } } });
  });

  it("uses enrollment endpoints to restore a client after a process starts disabled", async () => {
    mocks.service.readFederationConfig.mockReturnValue({ mode: "disabled", gatewayEndpoints: ["wss://fixture.invalid"] });
    await invoke(FEDERATION_SET_ENABLED_CHANNEL, true);
    expect(mocks.service.writeConfigPatchTargeted).toHaveBeenCalledWith({ federation: { mode: "client" } });
  });

  it("does not restart on failed writes and rejects malformed toggle/topmost requests", async () => {
    mocks.service.writeConfigPatchTargeted.mockRejectedValue(new Error("Read-only settings"));
    await expect(invoke(FEDERATION_SET_ENABLED_CHANNEL, false)).rejects.toThrow("Read-only settings");
    expect(mocks.runtime.restart).not.toHaveBeenCalled();
    expect(() => invoke(FEDERATION_SET_ENABLED_CHANNEL, "false")).toThrow("boolean");
    expect(() => invoke(FEDERATION_ACTIVITY_TOPMOST_CHANNEL, {})).toThrow("boolean");
  });

  it("opens on the caller's display and passes caller identity to the topmost guard", () => {
    mocks.fromWebContents.mockReturnValue({ id: 7 });
    invoke(FEDERATION_OPEN_ACTIVITY_CHANNEL);
    expect(mocks.show).toHaveBeenCalledWith({ sourceWindow: { id: 7 } });
    invoke(FEDERATION_ACTIVITY_TOPMOST_CHANNEL, true);
    expect(mocks.topmost).toHaveBeenCalledWith(42, true);
  });
});
