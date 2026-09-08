import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEDERATION_ACTIVITY_TOPMOST_CHANNEL, FEDERATION_OPEN_ACTIVITY_CHANNEL,
  FEDERATION_READ_ACTIVITY_CHANNEL, FEDERATION_SET_ENABLED_CHANNEL, FEDERATION_RESET_ACTIVITY_CHANNEL,
} from "../../shared/ipc";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  runtime: { activity: vi.fn(), resetActivity: vi.fn(), restart: vi.fn(), setEnabledForSession: vi.fn() },
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
  it("resets only local activity without restarting or changing configuration", async () => {
    mocks.runtime.resetActivity.mockResolvedValue({ activity: { since: 123 } });
    expect(await invoke(FEDERATION_RESET_ACTIVITY_CHANNEL)).toEqual({ activity: { since: 123 } });
    expect(mocks.runtime.resetActivity).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.restart).not.toHaveBeenCalled();
    expect(mocks.service.writeConfigPatchTargeted).not.toHaveBeenCalled();
  });

  it("reads only local aggregates and forwards the selected history view", async () => {
    await invoke(FEDERATION_READ_ACTIVITY_CHANNEL, { historyPeerId: "peer", historyView: "logical" });
    expect(mocks.runtime.activity).toHaveBeenCalledWith({ includeHistory: true, historyPeerId: "peer", historyView: "logical" });
    expect(mocks.service.writeConfigPatchTargeted).not.toHaveBeenCalled();
    expect(mocks.runtime.restart).not.toHaveBeenCalled();
  });

  it("toggles only the local runtime and reports a lease-denied enable attempt", async () => {
    await invoke(FEDERATION_SET_ENABLED_CHANNEL, false);
    expect(mocks.runtime.setEnabledForSession).toHaveBeenLastCalledWith(false);
    const result = await invoke(FEDERATION_SET_ENABLED_CHANNEL, true);
    expect(mocks.runtime.setEnabledForSession).toHaveBeenLastCalledWith(true);
    expect(mocks.service.writeConfigPatchTargeted).not.toHaveBeenCalled();
    expect(mocks.service.readFederationConfig).not.toHaveBeenCalled();
    expect(result).toMatchObject({ configuredMode: "dual", running: false, health: { leaseHolder: { instanceId: "holder" } } });
  });

  it("reports runtime failures, permits a subsequent toggle, and rejects malformed requests", async () => {
    mocks.runtime.setEnabledForSession.mockRejectedValueOnce(new Error("Startup failed"));
    await expect(invoke(FEDERATION_SET_ENABLED_CHANNEL, true)).rejects.toThrow("Startup failed");
    await invoke(FEDERATION_SET_ENABLED_CHANNEL, false);
    expect(mocks.runtime.setEnabledForSession).toHaveBeenLastCalledWith(false);
    expect(mocks.service.writeConfigPatchTargeted).not.toHaveBeenCalled();
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
