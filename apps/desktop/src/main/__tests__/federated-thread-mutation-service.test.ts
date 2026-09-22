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

  describe("archive, restore, pins, read state and project moves", () => {
    function peerOwning(
      threadStatus: "active" | "idle",
      options: {
        archivedAt?: number;
        updatedAt?: number;
        capabilities?: string[];
      } = {},
    ) {
      const backend = {
        resolveThread: vi.fn(async () => ({
          thread: {
            source: "codex" as const,
            id: "remote-thread",
            title: "Remote thread",
            linkedDirectories: [],
            threadStatus,
            ...(options.archivedAt !== undefined
              ? { archivedAt: options.archivedAt }
              : {}),
            ...(options.updatedAt !== undefined
              ? { updatedAt: options.updatedAt }
              : {}),
          },
        })),
        renameThread: vi.fn(async (request) => request),
        archiveThread: vi.fn(async () => ({
          backend: "codex",
          threadId: "remote-thread",
          archivedAt: 1,
          cleanup: [],
        })),
        restoreThread: vi.fn(async () => ({
          backend: "codex",
          threadId: "remote-thread",
          restoredAt: 2,
        })),
        setThreadPin: vi.fn(async (request) => request),
        markThreadSeen: vi.fn(async (request) => request),
        handoffThreadWorkspace: vi.fn(async () => ({})),
      };
      const target = { scope: "remote" as const, instanceId: "pwr_owner" };
      const runtime = {
        connectedPeerTargets: () => [{
          target,
          label: "Owner Mac",
          capabilities: options.capabilities ?? ["thread_navigation", "turn_control"],
        }],
        remoteBackend: () => backend,
        assertRemoteNavigationQueryProtocol: vi.fn(),
      };
      return {
        backend,
        runtime,
        target,
        handler: createFederatedThreadMutationHandler({
          runtime: () => runtime as unknown as DesktopFederationRuntime,
        }),
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

    it("restores an archived thread on its owner, and only an archived one", async () => {
      const archived = peerOwning("idle", { archivedAt: 1_000 });
      const live = peerOwning("idle");

      await archived.handler({
        backend: "codex",
        threadId: "remote-thread",
        archive: false,
        dryRun: false,
      });
      await expect(live.handler({
        backend: "codex",
        threadId: "remote-thread",
        archive: false,
        dryRun: false,
      })).rejects.toMatchObject({ code: "invalid_arguments" });
      await expect(archived.handler({
        backend: "codex",
        threadId: "remote-thread",
        archive: true,
        dryRun: false,
      })).rejects.toMatchObject({ code: "invalid_arguments" });

      expect(archived.backend.restoreThread).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "remote-thread",
      });
      expect(live.backend.restoreThread).not.toHaveBeenCalled();
      expect(archived.backend.archiveThread).not.toHaveBeenCalled();
    });

    it("sends the operator to Settings when the peer is too old to restore", async () => {
      const { backend, handler } = peerOwning("idle", { archivedAt: 1_000 });
      backend.restoreThread.mockRejectedValueOnce(
        Object.assign(new Error("Unknown method backend.restoreThread"), {
          code: "method_not_found",
        }),
      );

      await expect(handler({
        backend: "codex",
        threadId: "remote-thread",
        archive: false,
        dryRun: false,
      })).rejects.toMatchObject({
        code: "invalid_arguments",
        message: expect.stringContaining("Settings → Archived Threads"),
      });
    });

    it("pins and marks read on a peer that grants navigation alone", async () => {
      // Pin and read state are the owner's browse-level calls: asking for
      // turn control too would refuse a peer that allows exactly these.
      const { backend, handler, runtime, target } = peerOwning("idle", {
        updatedAt: 5_000,
        capabilities: ["thread_navigation"],
      });

      await handler({
        backend: "codex",
        threadId: "remote-thread",
        pinned: true,
        unread: true,
        dryRun: false,
      });

      expect(runtime.assertRemoteNavigationQueryProtocol)
        .toHaveBeenCalledWith(target);
      expect(backend.setThreadPin).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "remote-thread",
        pinned: true,
      });
      expect(backend.markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "remote-thread",
        seenUpdatedAt: 4_999,
      });
    });

    it("still needs turn control for an archive", async () => {
      const { backend, handler } = peerOwning("idle", {
        capabilities: ["thread_navigation"],
      });

      await expect(handler({
        backend: "codex",
        threadId: "remote-thread",
        archive: true,
        dryRun: false,
      })).rejects.toThrow("does not grant turn_control");
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
