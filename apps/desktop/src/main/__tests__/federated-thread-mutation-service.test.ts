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

  describe("archive and project moves", () => {
    function peerOwning(threadStatus: "active" | "idle") {
      const backend = {
        resolveThread: vi.fn(async () => ({
          thread: {
            source: "codex" as const,
            id: "remote-thread",
            title: "Remote thread",
            linkedDirectories: [],
            threadStatus,
          },
        })),
        renameThread: vi.fn(async (request) => request),
        archiveThread: vi.fn(async () => ({
          backend: "codex",
          threadId: "remote-thread",
          archivedAt: 1,
          cleanup: [],
        })),
        handoffThreadWorkspace: vi.fn(async () => ({})),
      };
      const runtime = {
        connectedPeerTargets: () => [{
          target: { scope: "remote" as const, instanceId: "pwr_owner" },
          label: "Owner Mac",
          capabilities: ["thread_navigation", "turn_control"],
        }],
        remoteBackend: () => backend,
      } as unknown as DesktopFederationRuntime;
      return {
        backend,
        handler: createFederatedThreadMutationHandler({ runtime: () => runtime }),
      };
    }

    it("archives on the peer that owns the thread", async () => {
      const { backend, handler } = peerOwning("idle");

      await handler({
        backend: "codex",
        threadId: "remote-thread",
        archive: true,
        dryRun: false,
      });

      expect(backend.archiveThread).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "remote-thread",
      });
    });

    it("refuses a peer's thread with a turn running, as it does locally", async () => {
      const { backend, handler } = peerOwning("active");

      await expect(handler({
        backend: "codex",
        threadId: "remote-thread",
        archive: true,
        dryRun: true,
      })).rejects.toMatchObject({ code: "forbidden" });
      expect(backend.archiveThread).not.toHaveBeenCalled();
    });

    it("moves on the peer before anything else changes", async () => {
      // The destination path only means something on the peer's own disk,
      // so the peer is the one that checks it - and a refusal there must not
      // leave the rename below already applied.
      const { backend, handler } = peerOwning("idle");
      backend.handoffThreadWorkspace.mockRejectedValueOnce(
        new Error("Move to Project requires an existing directory."),
      );

      await expect(handler({
        backend: "codex",
        threadId: "remote-thread",
        projectPath: "/Users/studio/repos/app",
        title: "Moved",
        dryRun: false,
      })).rejects.toThrow("requires an existing directory");
      expect(backend.handoffThreadWorkspace).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "remote-thread",
        direction: "to-project",
        targetPath: "/Users/studio/repos/app",
      });
      expect(backend.renameThread).not.toHaveBeenCalled();
    });
  });
});
