import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { OverlayStore } from "../persistence/overlay-store";

const tempDirs: string[] = [];

async function createStore(): Promise<OverlayStore> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-refresh-reconcile-"));
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

describe("refresh reconciliation", () => {
  it("treats the first snapshot as a baseline instead of flooding inbox", async () => {
    const store = await createStore();

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread()],
    });

    expect(snapshot.unchanged).toBe(false);
    expect(snapshot.inboxThreadKeys).toEqual([]);
    expect(snapshot.threads[0]?.inbox.inInbox).toBe(false);
  });

  it("marks later thread updates as changed and inbox-worthy", async () => {
    const store = await createStore();

    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread()],
    });

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 2000,
      threads: [buildThread({ updatedAt: 3000 })],
    });

    expect(snapshot.unchanged).toBe(false);
    expect(snapshot.inboxThreadKeys).toEqual(["codex:thread-1"]);
    expect(snapshot.threads[0]?.inbox.reason).toBe("updated-since-seen");
  });

  it("returns unchanged when the material thread snapshot did not move", async () => {
    const store = await createStore();

    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread()],
    });

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 2000,
      threads: [buildThread()],
    });

    expect(snapshot.unchanged).toBe(true);
  });

  it("treats title metadata changes as material snapshot changes", async () => {
    const store = await createStore();

    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread()],
    });

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 2000,
      threads: [buildThread({ title: "first prompt", titleSource: "derived" })],
    });

    expect(snapshot.unchanged).toBe(false);
  });

  it("treats observed branch changes as material snapshot changes", async () => {
    const store = await createStore();

    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread({ gitBranch: "HEAD", observedGitBranch: "HEAD" })],
    });

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 2000,
      threads: [
        buildThread({
          gitBranch: "fix/testing-detached-head",
          observedGitBranch: "fix/testing-detached-head",
        }),
      ],
    });

    expect(snapshot.unchanged).toBe(false);
    expect(snapshot.threads[0]?.gitBranch).toBe("fix/testing-detached-head");
    expect(snapshot.threads[0]?.observedGitBranch).toBe("fix/testing-detached-head");
  });

  it("uses overlay branch metadata when a workspace handoff updates the checkout", async () => {
    const store = await createStore();

    await store.replaceWorkspaceLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      gitBranch: "feat/thread-workspace-handoff-plan",
      directory: {
        id: "pwragent-handoff:codex:thread-1",
        kind: "worktree",
        label: "PwrAgent",
        path: "/repo",
        worktreePath: "/repo/.worktrees/pwragent-feature",
      },
    });

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [
        buildThread({
          gitBranch: "fix/context-rail-slide-reflow",
          observedGitBranch: "main",
        }),
      ],
    });

    expect(snapshot.threads[0]?.gitBranch).toBe("feat/thread-workspace-handoff-plan");
    expect(snapshot.threads[0]?.observedGitBranch).toBe(
      "feat/thread-workspace-handoff-plan",
    );
  });

  it("uses observed handoff branch metadata when legacy overlay state has no expected branch", async () => {
    const store = await createStore();

    await store.addLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: "pwragent-handoff:codex:thread-1",
        kind: "worktree",
        label: "PwrAgent",
        path: "/repo",
        worktreePath: "/repo/.worktrees/pwragent-feature",
      },
    });
    await store.setThreadObservedBranch({
      backend: "codex",
      threadId: "thread-1",
      branch: "feat/thread-workspace-handoff-plan",
    });

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [
        buildThread({
          gitBranch: "fix/context-rail-slide-reflow",
          observedGitBranch: "feat/thread-workspace-handoff-plan",
        }),
      ],
    });

    expect(snapshot.threads[0]?.gitBranch).toBe("feat/thread-workspace-handoff-plan");
    expect(snapshot.threads[0]?.observedGitBranch).toBe(
      "feat/thread-workspace-handoff-plan",
    );
  });

  it("keeps legacy handoff expected branch stable after observing checkout drift", async () => {
    const store = await createStore();

    await store.addLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: "pwragent-handoff:codex:thread-1",
        kind: "worktree",
        label: "PwrAgent",
        path: "/repo",
        worktreePath: "/repo/.worktrees/pwragent-feature",
      },
    });
    await store.setThreadObservedBranch({
      backend: "codex",
      threadId: "thread-1",
      branch: "feat/thread-workspace-handoff-plan",
    });
    await store.setThreadObservedBranch({
      backend: "codex",
      threadId: "thread-1",
      branch: "fix/context-rail-slide-reflow",
    });

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [
        buildThread({
          gitBranch: "feat/thread-workspace-handoff-plan",
          observedGitBranch: "fix/context-rail-slide-reflow",
        }),
      ],
    });

    expect(snapshot.threads[0]?.gitBranch).toBe("feat/thread-workspace-handoff-plan");
    expect(snapshot.threads[0]?.observedGitBranch).toBe(
      "fix/context-rail-slide-reflow",
    );
  });

  it("tracks mixed-backend threads with duplicate ids independently in aggregate snapshots", async () => {
    const store = await createStore();

    await store.reconcileNavigationSnapshot({
      backend: "all",
      fetchedAt: 1000,
      threads: [
        buildThread(),
        buildThread({
          source: "grok",
          title: "Desktop App (Grok)",
          updatedAt: 1000,
        }),
      ],
    });

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "all",
      fetchedAt: 2000,
      threads: [
        buildThread({ updatedAt: 3000 }),
        buildThread({
          source: "grok",
          title: "Desktop App (Grok)",
          updatedAt: 1000,
        }),
      ],
    });

    expect(snapshot.inboxThreadKeys).toEqual(["codex:thread-1"]);
    expect(snapshot.threads).toHaveLength(2);
    expect(snapshot.threads.map((thread) => `${thread.source}:${thread.id}`)).toEqual([
      "codex:thread-1",
      "grok:thread-1",
    ]);
  });
});
