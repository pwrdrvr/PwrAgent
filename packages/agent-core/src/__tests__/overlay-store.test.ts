import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { OverlayStore } from "../persistence/overlay-store";

const tempDirs: string[] = [];

async function createStore(): Promise<OverlayStore> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-overlay-store-"));
  tempDirs.push(tempDir);
  return new OverlayStore(path.join(tempDir, "overlay-state.json"));
}

function buildThread(overrides: Partial<AppServerThreadSummary> = {}): AppServerThreadSummary {
  return {
    id: "thread-1",
    title: "Desktop App",
    titleSource: "explicit",
    source: "codex",
    linkedDirectories: [],
    updatedAt: 1000,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) => {
      await import("node:fs/promises").then(({ rm }) =>
        rm(tempDir, { recursive: true, force: true }),
      );
    }),
  );
});

describe("OverlayStore", () => {
  it("persists seen state without mutating app-server-owned thread data", async () => {
    const store = await createStore();

    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread()],
    });

    await store.markThreadSeen({
      backend: "codex",
      threadId: "thread-1",
      seenAt: 2000,
      seenUpdatedAt: 1000,
    });

    const raw = JSON.parse(
      await readFile(path.join(tempDirs[0]!, "overlay-state.json"), "utf8"),
    ) as {
      threads: Record<
        string,
        { backend?: string; lastSeenAt?: number; lastSeenUpdatedAt?: number }
      >;
    };

    expect(raw.threads["codex:thread-1"]).toMatchObject({
      backend: "codex",
      lastSeenAt: 2000,
      lastSeenUpdatedAt: 1000,
    });
  });

  it("stores extra linked directories for desktop-only multi-project overlays", async () => {
    const store = await createStore();

    await store.addLinkedDirectory({
      backend: "grok",
      threadId: "thread-2",
      directory: {
        id: "/Users/huntharo/pwrdrvr/openclaw",
        kind: "local",
        label: "openclaw",
        path: "/Users/huntharo/pwrdrvr/openclaw",
      },
    });

    const raw = JSON.parse(
      await readFile(path.join(tempDirs[0]!, "overlay-state.json"), "utf8"),
    ) as {
      threads: Record<
        string,
        { backend?: string; extraLinkedDirectories: Array<{ label: string }> }
      >;
    };

    expect(raw.threads["grok:thread-2"]).toMatchObject({
      backend: "grok",
    });
    expect(raw.threads["grok:thread-2"]?.extraLinkedDirectories).toEqual([
      expect.objectContaining({ label: "openclaw" }),
    ]);
  });

  it("replaces the active workspace linked directory while preserving unrelated links", async () => {
    const store = await createStore();

    await store.addLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: "/repo",
        kind: "local",
        label: "repo",
        path: "/repo",
      },
    });
    await store.addLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: "/other",
        kind: "local",
        label: "other",
        path: "/other",
      },
    });

    await store.replaceWorkspaceLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      gitBranch: "feature/handoff",
      directory: {
        id: "pwragent-handoff:codex:thread-1",
        kind: "worktree",
        label: "repo",
        path: "/repo",
        worktreePath: "/repo/.worktrees/repo-feature",
      },
    });

    await expect(
      store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      gitBranch: "feature/handoff",
      observedGitBranch: "feature/handoff",
      extraLinkedDirectories: [
        {
          id: "/other",
          kind: "local",
          path: "/other",
        },
        {
          id: "pwragent-handoff:codex:thread-1",
          kind: "worktree",
          path: "/repo",
          worktreePath: "/repo/.worktrees/repo-feature",
        },
      ],
    });
  });

  it("promotes legacy observed handoff branch metadata before recording checkout drift", async () => {
    const store = await createStore();

    await store.addLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: "pwragent-handoff:codex:thread-1",
        kind: "worktree",
        label: "repo",
        path: "/repo",
        worktreePath: "/repo/.worktrees/repo-feature",
      },
    });
    await store.setThreadObservedBranch({
      backend: "codex",
      threadId: "thread-1",
      branch: "feature/expected",
    });

    await expect(
      store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      gitBranch: undefined,
      observedGitBranch: "feature/expected",
    });

    await store.setThreadObservedBranch({
      backend: "codex",
      threadId: "thread-1",
      branch: "feature/current",
    });

    await expect(
      store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      gitBranch: "feature/expected",
      observedGitBranch: "feature/current",
    });
  });

  it("stores worktree snapshot metadata by backend-qualified thread", async () => {
    const store = await createStore();

    await store.upsertWorktreeSnapshot({
      backend: "codex",
      threadId: "thread-1",
      snapshot: {
        id: "snapshot-1",
        backend: "codex",
        threadId: "thread-1",
        worktreePath: "/Users/huntharo/.codex/worktrees/d593/PwrAgent",
        repositoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
        snapshotRef: "refs/codex/snapshots/snapshot-1",
        snapshotCommit: "abc123",
        createdAt: 1000,
        archivedAt: 1000,
        state: "archived",
        ignoredFilesExcluded: true,
      },
    });

    const reloaded = new OverlayStore(path.join(tempDirs[0]!, "overlay-state.json"));

    await expect(
      reloaded.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      worktreeSnapshots: [
        expect.objectContaining({
          snapshotRef: "refs/codex/snapshots/snapshot-1",
          state: "archived",
        }),
      ],
    });
  });

  it("keeps backend-qualified overlay state separate for duplicate thread ids", async () => {
    const store = await createStore();

    await store.markThreadSeen({
      backend: "codex",
      threadId: "thread-1",
      seenAt: 2000,
      seenUpdatedAt: 1000,
    });
    await store.markThreadSeen({
      backend: "grok",
      threadId: "thread-1",
      seenAt: 3000,
      seenUpdatedAt: 2500,
    });

    const raw = JSON.parse(
      await readFile(path.join(tempDirs[0]!, "overlay-state.json"), "utf8"),
    ) as {
      threads: Record<
        string,
        { backend?: string; lastSeenAt?: number; lastSeenUpdatedAt?: number }
      >;
    };

    expect(raw.threads["codex:thread-1"]).toMatchObject({
      backend: "codex",
      lastSeenAt: 2000,
      lastSeenUpdatedAt: 1000,
    });
    expect(raw.threads["grok:thread-1"]).toMatchObject({
      backend: "grok",
      lastSeenAt: 3000,
      lastSeenUpdatedAt: 2500,
    });
  });

  it("persists directory launchpad drafts separately from real threads", async () => {
    const store = await createStore();

    await store.upsertDirectoryLaunchpad({
      directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
      backend: "codex",
      executionMode: "full-access",
      prompt: "Investigate the directories launchpad flow",
      workMode: "worktree",
      branchName: "main",
      createdAt: 1000,
      updatedAt: 2000,
    });

    const raw = JSON.parse(
      await readFile(path.join(tempDirs[0]!, "overlay-state.json"), "utf8"),
    ) as {
      directoryLaunchpads: Record<string, { prompt?: string; executionMode?: string }>;
      threads: Record<string, unknown>;
    };

    expect(raw.directoryLaunchpads["directory:/Users/huntharo/pwrdrvr/PwrAgent"]).toMatchObject({
      prompt: "Investigate the directories launchpad flow",
      executionMode: "full-access",
    });
    expect(raw.threads).toEqual({});
  });

  it("persists launchpad defaults for future directory drafts", async () => {
    const store = await createStore();

    await store.setLaunchpadDefaults({
      backend: "grok",
      executionMode: "full-access",
      reasoningEffort: "high",
      fastMode: true,
    });

    expect(await store.getLaunchpadDefaults()).toEqual({
      backend: "grok",
      executionMode: "full-access",
      workMode: "local",
      reasoningEffort: "high",
      fastMode: true,
    });
  });

  it("persists thread model settings separately from launchpad defaults", async () => {
    const store = await createStore();

    await store.setLaunchpadDefaults({
      backend: "grok",
      executionMode: "default",
      model: "grok-4",
      reasoningEffort: "medium",
      fastMode: true,
    });
    await store.setThreadModelSettings({
      backend: "codex",
      threadId: "thread-1",
      model: "gpt-5.4",
      reasoningEffort: "high",
      serviceTier: "priority",
      fastMode: true,
    });
    await store.setThreadModelSettings({
      backend: "codex",
      threadId: "thread-2",
      model: "gpt-5.4-pro",
      reasoningEffort: "low",
      fastMode: false,
    });

    const reloaded = new OverlayStore(path.join(tempDirs[0]!, "overlay-state.json"));

    await expect(
      reloaded.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      model: "gpt-5.4",
      reasoningEffort: "high",
      serviceTier: "priority",
      fastMode: true,
    });
    await expect(
      reloaded.getThreadOverlayState({ backend: "codex", threadId: "thread-2" }),
    ).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-2",
      model: "gpt-5.4-pro",
      reasoningEffort: "low",
      fastMode: false,
    });
    await expect(reloaded.getLaunchpadDefaults()).resolves.toEqual({
      backend: "grok",
      executionMode: "default",
      workMode: "local",
      model: "grok-4",
      reasoningEffort: "medium",
      fastMode: true,
    });
  });

  it("does not rewrite the overlay file for read-only thread lookups", async () => {
    const store = await createStore();

    await store.markThreadSeen({
      backend: "codex",
      threadId: "thread-1",
      seenAt: 2000,
      seenUpdatedAt: 1000,
    });

    const overlayPath = path.join(tempDirs[0]!, "overlay-state.json");
    const beforeStat = await stat(overlayPath);

    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(
      store.getThreadOverlayStates({
        backend: "codex",
        threadIds: ["thread-1", "thread-2"],
      }),
    ).resolves.toEqual({
      "thread-1": expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        lastSeenAt: 2000,
      }),
      "thread-2": undefined,
    });

    const afterStat = await stat(overlayPath);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("persists correctly when separate store instances write the same file concurrently", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-overlay-store-shared-"));
    tempDirs.push(tempDir);
    const sharedPath = path.join(tempDir, "overlay-state.json");
    const firstStore = new OverlayStore(sharedPath);
    const secondStore = new OverlayStore(sharedPath);

    await Promise.all([
      firstStore.markThreadSeen({
        backend: "codex",
        threadId: "thread-1",
        seenAt: 2000,
        seenUpdatedAt: 1000,
      }),
      secondStore.markThreadSeen({
        backend: "grok",
        threadId: "thread-2",
        seenAt: 3000,
        seenUpdatedAt: 2500,
      }),
    ]);

    const raw = JSON.parse(await readFile(sharedPath, "utf8")) as {
      threads: Record<string, { backend?: string; lastSeenAt?: number }>;
    };

    expect(Object.values(raw.threads)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ backend: "codex", lastSeenAt: 2000 }),
        expect.objectContaining({ backend: "grok", lastSeenAt: 3000 }),
      ]),
    );
  });

  it("retainThreadExecutionModeDrift persists the dismissed pair without overwriting other fields", async () => {
    const store = await createStore();
    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread({ executionMode: "default" })],
    });

    const result = await store.retainThreadExecutionModeDrift({
      backend: "codex",
      threadId: "thread-1",
      expectedExecutionMode: "default",
      observedExecutionMode: "full-access",
      retainedAt: 2000,
    });

    expect(result.retainedExecutionModeDriftPairs).toEqual([
      {
        expectedExecutionMode: "default",
        observedExecutionMode: "full-access",
        retainedAt: 2000,
      },
    ]);
    expect(result.executionMode).toBe("default");
  });

  it("setThreadExecutionMode clears retained drift pairs that referenced the old expected value", async () => {
    const store = await createStore();
    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread({ executionMode: "default" })],
    });

    await store.retainThreadExecutionModeDrift({
      backend: "codex",
      threadId: "thread-1",
      expectedExecutionMode: "default",
      observedExecutionMode: "full-access",
      retainedAt: 2000,
    });

    const next = await store.setThreadExecutionMode({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "full-access",
    });

    // The previously-retained (default, full-access) pair touched
    // "full-access" — once the user explicitly picks that mode, the pair
    // is meaningless and should be cleared so a future drift back to
    // "default" can prompt again.
    expect(next.retainedExecutionModeDriftPairs ?? []).toEqual([]);
    expect(next.executionMode).toBe("full-access");
  });

  it("setThreadObservedExecutionMode persists the captured value without touching the expected mode", async () => {
    const store = await createStore();
    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread({ executionMode: "default" })],
    });

    const next = await store.setThreadObservedExecutionMode({
      backend: "codex",
      threadId: "thread-1",
      observedExecutionMode: "full-access",
    });

    expect(next.executionMode).toBe("default");
    expect(next.observedExecutionMode).toBe("full-access");
  });

  describe("permission transition log", () => {
    it("appends a transition entry surfaced via getThreadOverlayState", async () => {
      const store = await createStore();
      await store.appendPermissionTransition({
        backend: "codex",
        threadId: "thread-1",
        transition: {
          id: "01HVAA00000000000000000001",
          fromExecutionMode: "default",
          toExecutionMode: "full-access",
          status: "queued",
          occurredAt: 1000,
          queueId: "queue-1",
        },
      });

      const overlay = await store.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      });
      expect(overlay?.permissionTransitionLog).toEqual([
        {
          id: "01HVAA00000000000000000001",
          fromExecutionMode: "default",
          toExecutionMode: "full-access",
          status: "queued",
          occurredAt: 1000,
          queueId: "queue-1",
        },
      ]);
    });

    it("evicts the oldest entry when 101 transitions are appended", async () => {
      const store = await createStore();
      for (let index = 0; index < 101; index += 1) {
        await store.appendPermissionTransition({
          backend: "codex",
          threadId: "thread-1",
          transition: {
            id: `entry-${index}`,
            fromExecutionMode: "default",
            toExecutionMode: "full-access",
            status: "queued",
            occurredAt: 1000 + index,
            queueId: `queue-${index}`,
          },
        });
      }

      const overlay = await store.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      });
      expect(overlay?.permissionTransitionLog).toHaveLength(100);
      expect(overlay?.permissionTransitionLog?.[0]?.id).toBe("entry-1");
      expect(overlay?.permissionTransitionLog?.[99]?.id).toBe("entry-100");
    });

    it("preserves the transition log across a reload", async () => {
      const store = await createStore();
      await store.appendPermissionTransition({
        backend: "codex",
        threadId: "thread-1",
        transition: {
          id: "entry-1",
          fromExecutionMode: "default",
          toExecutionMode: "full-access",
          status: "applied",
          occurredAt: 5000,
        },
      });

      // Re-read via a brand new instance to confirm the log persisted.
      // OverlayStore takes a file path; reuse it from the original.
      const filePath = (store as unknown as { filePath: string }).filePath;
      const { OverlayStore } = await import("../persistence/overlay-store");
      const reopened = new OverlayStore(filePath);
      const overlay = await reopened.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      });
      expect(overlay?.permissionTransitionLog).toEqual([
        {
          id: "entry-1",
          fromExecutionMode: "default",
          toExecutionMode: "full-access",
          status: "applied",
          occurredAt: 5000,
        },
      ]);
    });
  });
});
