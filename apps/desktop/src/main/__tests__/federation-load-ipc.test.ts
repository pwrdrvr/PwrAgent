import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FederationLoadStatus } from "@pwragent/shared";
import { FEDERATION_READ_INSTANCE_LOAD_CHANNEL } from "../../shared/ipc";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      },
    ),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

const runtime = {
  health: vi.fn(),
  localBackend: vi.fn(),
  connectedPeerTargets: vi.fn(),
  remoteBackend: vi.fn(),
};

vi.mock("../federation/federation-runtime", () => ({
  getDesktopFederationRuntime: () => runtime,
}));
vi.mock("../federation/federation-tailscale", () => ({
  getFederationTailscaleService: () => ({}),
}));
vi.mock("../federation/federation-window", () => ({
  createFederationWindow: vi.fn(),
}));

const localLoad: FederationLoadStatus = {
  loadAvg1: 0.5,
  loadAvg5: 0.4,
  loadAvg15: 0.3,
  availableMemoryBytes: 16_000_000_000,
  diskFreeBytes: 250_000_000_000,
  sampledAt: 1_000,
};

const remoteLoad: FederationLoadStatus = {
  loadAvg1: 7.5,
  loadAvg5: 6.0,
  loadAvg15: 4.5,
  availableMemoryBytes: 1_000_000_000,
  sampledAt: 1_100,
};

async function invokeReadInstanceLoad(request?: unknown): Promise<unknown> {
  const { registerFederationIpcHandlers } = await import("../ipc/federation");
  registerFederationIpcHandlers();
  return await handlers.get(FEDERATION_READ_INSTANCE_LOAD_CHANNEL)!(
    {},
    request,
  );
}

describe("federation read-instance-load ipc", () => {
  beforeEach(() => {
    handlers.clear();
    runtime.health.mockReset().mockResolvedValue({ instanceId: "pwr_local" });
    runtime.localBackend
      .mockReset()
      .mockReturnValue({ getLoadStatus: async () => localLoad });
    runtime.connectedPeerTargets.mockReset().mockReturnValue([]);
    runtime.remoteBackend.mockReset();
  });

  it("samples locally when no instance id is given", async () => {
    await expect(invokeReadInstanceLoad()).resolves.toEqual({
      load: localLoad,
    });
    expect(runtime.remoteBackend).not.toHaveBeenCalled();
  });

  it("samples locally for the local instance's own id", async () => {
    await expect(
      invokeReadInstanceLoad({ instanceId: "pwr_local" }),
    ).resolves.toEqual({ load: localLoad });
    expect(runtime.remoteBackend).not.toHaveBeenCalled();
  });

  it("queries a connected thread_navigation peer over the federation RPC", async () => {
    runtime.connectedPeerTargets.mockReturnValue([
      {
        target: { scope: "remote", instanceId: "pwr_studio" },
        label: "Studio Mac",
        capabilities: ["thread_navigation"],
      },
    ]);
    runtime.remoteBackend.mockReturnValue({
      getLoadStatus: async () => remoteLoad,
    });

    await expect(
      invokeReadInstanceLoad({ instanceId: "pwr_studio" }),
    ).resolves.toEqual({ load: remoteLoad });
    expect(runtime.remoteBackend).toHaveBeenCalledWith({
      scope: "remote",
      instanceId: "pwr_studio",
    });
  });

  it("returns no load for a peer that is not connected", async () => {
    await expect(
      invokeReadInstanceLoad({ instanceId: "pwr_offline" }),
    ).resolves.toEqual({});
    expect(runtime.remoteBackend).not.toHaveBeenCalled();
  });

  it("returns no load for a peer without thread_navigation", async () => {
    runtime.connectedPeerTargets.mockReturnValue([
      {
        target: { scope: "remote", instanceId: "pwr_locked" },
        label: "Locked-Down Box",
        capabilities: ["federated_search"],
      },
    ]);

    await expect(
      invokeReadInstanceLoad({ instanceId: "pwr_locked" }),
    ).resolves.toEqual({});
    expect(runtime.remoteBackend).not.toHaveBeenCalled();
  });

  it("degrades a failed remote query to no load, never an error", async () => {
    runtime.connectedPeerTargets.mockReturnValue([
      {
        target: { scope: "remote", instanceId: "pwr_slow" },
        label: "Slow Mini",
        capabilities: ["thread_navigation"],
      },
    ]);
    runtime.remoteBackend.mockReturnValue({
      getLoadStatus: async () => {
        throw new Error("Federation request timed out: backend.getLoadStatus");
      },
    });

    await expect(
      invokeReadInstanceLoad({ instanceId: "pwr_slow" }),
    ).resolves.toEqual({});
  });

  it("rejects a malformed instance id before touching the runtime", async () => {
    await expect(
      invokeReadInstanceLoad({ instanceId: "not a valid id!" }),
    ).rejects.toThrow("Invalid federation instance id");
    expect(runtime.health).not.toHaveBeenCalled();
  });
});
