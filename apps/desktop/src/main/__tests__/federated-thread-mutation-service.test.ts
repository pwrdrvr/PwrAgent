import { describe, expect, it, vi } from "vitest";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import { createFederatedThreadMutationHandler } from "../federation/federated-thread-mutation-service";

describe("federated thread mutation service", () => {
  it("routes every requested mutation to the owning peer", async () => {
    const thread = {
      source: "codex" as const,
      id: "remote-thread",
      title: "Remote thread",
      linkedDirectories: [],
    };
    const backend = {
      resolveThread: vi.fn(async () => ({ thread })),
      renameThread: vi.fn(async (request) => request),
      setThreadModelSettings: vi.fn(async (request) => request),
      setThreadExecutionMode: vi.fn(async (request) => request),
    };
    const runtime = {
      connectedPeerTargets: () => [{
        target: { scope: "remote" as const, instanceId: "pwr_owner" },
        label: "Owner Mac",
        capabilities: ["thread_navigation", "turn_control"],
      }],
      remoteBackend: () => backend,
    } as unknown as DesktopFederationRuntime;
    const handler = createFederatedThreadMutationHandler({
      runtime: () => runtime,
    });

    await expect(handler({
      backend: "codex",
      threadId: "remote-thread",
      title: "Renamed remotely",
      modelSettings: { model: "gpt-5.6", fastMode: true },
      executionMode: "full-access",
      dryRun: false,
    })).resolves.toEqual({
      instanceId: "pwr_owner",
      instanceLabel: "Owner Mac",
    });
    expect(backend.renameThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "remote-thread",
      name: "Renamed remotely",
    });
    expect(backend.setThreadModelSettings).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "remote-thread",
      model: "gpt-5.6",
      fastMode: true,
    });
    expect(backend.setThreadExecutionMode).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "remote-thread",
      executionMode: "full-access",
    });
  });

  it("resolves and validates a remote dry run without mutating it", async () => {
    const backend = {
      resolveThread: vi.fn(async () => ({
        thread: {
          source: "codex" as const,
          id: "remote-thread",
          title: "Remote thread",
          linkedDirectories: [],
        },
      })),
      renameThread: vi.fn(),
      setThreadModelSettings: vi.fn(),
      setThreadExecutionMode: vi.fn(),
    };
    const runtime = {
      connectedPeerTargets: () => [{
        target: { scope: "remote" as const, instanceId: "pwr_owner" },
        label: "Owner Mac",
        capabilities: ["thread_navigation", "turn_control"],
      }],
      remoteBackend: () => backend,
    } as unknown as DesktopFederationRuntime;
    const handler = createFederatedThreadMutationHandler({
      runtime: () => runtime,
    });

    await handler({
      backend: "codex",
      threadId: "remote-thread",
      title: "Dry run",
      dryRun: true,
    });

    expect(backend.renameThread).not.toHaveBeenCalled();
  });
});
