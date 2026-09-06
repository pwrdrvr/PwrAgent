import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FederationLoadStatus } from "@pwragent/shared";
import {
  FEDERATION_OPEN_WINDOW_CHANNEL,
  FEDERATION_READ_INSTANCE_LOAD_CHANNEL,
  FEDERATION_SET_EVENT_SUBSCRIPTIONS_CHANNEL,
} from "../../shared/ipc";

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
  setRendererEventSubscriptions: vi.fn(),
  clearRendererEventSubscriptions: vi.fn(),
};
const createFederationWindow = vi.hoisted(() => vi.fn());

vi.mock("../federation/federation-runtime", () => ({
  getDesktopFederationRuntime: () => runtime,
}));
vi.mock("../federation/federation-tailscale", () => ({
  getFederationTailscaleService: () => ({}),
}));
vi.mock("../federation/federation-window", () => ({
  createFederationWindow,
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
    runtime.setRendererEventSubscriptions.mockReset().mockImplementation((_id, _consumer, subscriptions) => subscriptions);
    runtime.clearRendererEventSubscriptions.mockReset();
    createFederationWindow.mockReset().mockReturnValue({ id: 7 });
  });

  it("samples locally when no instance id is given", async () => {
    await expect(invokeReadInstanceLoad()).resolves.toEqual({
      load: localLoad,
    });
    expect(runtime.remoteBackend).not.toHaveBeenCalled();
  });

  it("preserves class-specific renderer demand through IPC and owns cleanup", async () => {
    const { registerFederationIpcHandlers } = await import("../ipc/federation");
    registerFederationIpcHandlers();
    runtime.connectedPeerTargets.mockReturnValue([{
      target: { scope: "remote", instanceId: "owner_one" },
      capabilities: ["thread_navigation", "thread_detail", "event_subscriptions"],
    }]);
    const subscription = {
      sourceInstanceId: "owner_one",
      eventClasses: ["navigation", "transcript"], threadSelection: { kind: "all" },
      eventClassSelections: {
        navigation: { kind: "all" },
        transcript: { kind: "threads", threads: [{ backend: "codex", threadId: "A" }] },
      },
    };
    const once = vi.fn();
    await expect(handlers.get(FEDERATION_SET_EVENT_SUBSCRIPTIONS_CHANNEL)!({
      sender: { id: 88, once },
    }, { consumer: "thread_view", subscriptions: [subscription] })).resolves.toEqual({ subscriptions: [subscription] });
    expect(runtime.setRendererEventSubscriptions).toHaveBeenCalledWith(88, "thread-view", [subscription]);
    expect(once).toHaveBeenCalledWith("destroyed", expect.any(Function));
    once.mock.calls[0]![1]();
    expect(runtime.clearRendererEventSubscriptions).toHaveBeenCalledWith(88);
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

  it("opens a connected instance directly into its new-thread launchpad", async () => {
    const peer = {
      target: { scope: "remote" as const, instanceId: "pwr_studio" },
      label: "Studio Mac / work",
      capabilities: ["remote_window", "thread_navigation"],
    };
    runtime.connectedPeerTargets.mockReturnValue([peer]);
    const { registerFederationIpcHandlers } = await import("../ipc/federation");
    registerFederationIpcHandlers();

    await expect(
      handlers.get(FEDERATION_OPEN_WINDOW_CHANNEL)!({}, {
        target: peer.target,
        initialLaunchpad: true,
      }),
    ).resolves.toEqual({
      opened: true,
      windowId: 7,
      target: peer.target,
    });
    expect(createFederationWindow).toHaveBeenCalledWith({
      peer,
      initialLaunchpad: true,
      initialThread: undefined,
    });
  });

  it("preserves a transcript message target when opening a remote thread", async () => {
    const peer = {
      target: { scope: "remote" as const, instanceId: "pwr_studio" },
      label: "Studio Mac / work",
      capabilities: ["remote_window", "thread_navigation"],
    };
    runtime.connectedPeerTargets.mockReturnValue([peer]);
    const { registerFederationIpcHandlers } = await import("../ipc/federation");
    registerFederationIpcHandlers();

    await handlers.get(FEDERATION_OPEN_WINDOW_CHANNEL)!({}, {
      target: peer.target,
      initialThread: {
        backend: "codex",
        messageId: "assistant-message-7",
        target: peer.target,
        threadId: "thread-7",
      },
    });

    expect(createFederationWindow).toHaveBeenCalledWith({
      peer,
      initialThread: {
        backend: "codex",
        messageId: "assistant-message-7",
        threadId: "thread-7",
      },
    });
  });
});
