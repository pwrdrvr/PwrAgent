import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createDeferred, expectedDir, MockBackendClient, rememberCollapsedDirectoryWithPinnedThread } from "./helpers/backend-registry-fixture";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

async function assertWorktreePlacement(options: {
  cachedFold: boolean | undefined;
  finalFold: boolean;
  ordinaryRank: number;
  peerFirst?: boolean;
  operatorRank?: string;
  groupedCheckout?: boolean;
}): Promise<void> {
  const temp = createTempStateDb("pwragent-worktree-visibility-");
  const db = StateDb.open(temp.dbPath);
  const viewerDb = StateDb.open(temp.dbPath);
  const store = new SqliteOverlayStore(db);
  const viewer = new SqliteOverlayStore(viewerDb);
  const directoryPath = expectedDir(path.join(os.tmpdir(), "example-project"));
  const directoryKey = `directory:${directoryPath}`;
  const repositoryPath = options.groupedCheckout
    ? expectedDir(path.join(os.tmpdir(), "secondary-checkout"))
    : directoryPath;
  const checkout = expectedDir(path.join(os.tmpdir(), "example-worktrees", "new-checkout"));
  const backend = "codex";
  const threadId = "new-worktree-thread";
  const keptRank = "-1099511627776";
  const client = new MockBackendClient({ threads: [] });
  const submitted = createDeferred<void>();
  const accepted = createDeferred<{ threadId: string }>();
  vi.spyOn(client, "startThread").mockImplementation(() => {
    submitted.resolve();
    return accepted.promise;
  });
  const registry = createDesktopBackendRegistry({
    codexClient: client,
    overlayStore: store,
    gitDirectoryService: {
      prepareLaunchpadWorkspace: async () => ({
        cwd: checkout,
        repositoryPath,
        workMode: "worktree",
      }),
    } as never,
  });
  try {
    await store.setThreadPin({ backend, threadId: "keep-at-top", pinnedRank: keptRank });
    await store.setThreadPin({ backend, threadId: "thread-pinned", pinnedRank: "1024" });
    if (options.groupedCheckout) {
      store.setProjectCheckoutGroup({
        projectPath: directoryPath, previousPaths: [],
        group: { preferredPath: directoryPath, paths: [directoryPath, repositoryPath], repositoryKey: "github.com/example/project" },
      });
    }
    if (options.cachedFold !== undefined) {
      await store.setDirectoryThreadsCollapsed({ directoryKey, collapsed: options.cachedFold });
      rememberCollapsedDirectoryWithPinnedThread({
        registry, directoryKey, directoryPath, collapsed: options.cachedFold,
        unpinnedThreadIds: ["existing-unpinned"],
      });
    }

    // Clean, ungrouped local handoffs use this start path without a directory key.
    const creation = registry.startThread({ backend, cwd: repositoryPath, workMode: "worktree" });
    await Promise.race([submitted.promise, creation]);
    // A different process can commit either change while provider acceptance
    // is pending, before this owner receives a fresh navigation projection.
    await viewer.setDirectoryThreadsCollapsed({ directoryKey, collapsed: options.finalFold });
    await viewer.setThreadPin({ backend, threadId: "thread-pinned", pinnedRank: String(options.ordinaryRank) });
    const peerRank = options.ordinaryRank - 2048;
    if (options.peerFirst) {
      const ref = buildFederatedThreadRef({ backend, instanceId: "another-instance", threadId: "peer-pin" });
      await viewer.addRemoteThreadPin({ ref, instanceLabel: "Another instance" });
      await viewer.setRemoteThreadLocalPin({ ref, pinnedRank: String(peerRank) });
    }
    if (options.operatorRank) {
      await viewer.setThreadPin({ backend, threadId, pinnedRank: options.operatorRank });
    }
    accepted.resolve({ threadId });

    const result = await creation;
    const stored = await store.getThreadOverlayState({ backend, threadId });
    expect(result.pinnedRank).toBe(stored?.pinnedRank);
    if (options.operatorRank) {
      expect(stored?.pinnedRank).toBe(options.operatorRank);
    } else if (options.finalFold) {
      expect(stored?.pinnedRank).toBeDefined();
      expect(Number(stored?.pinnedRank)).toBeGreaterThan(Number(keptRank));
      expect(Number(stored?.pinnedRank)).toBeLessThan(options.peerFirst ? peerRank : options.ordinaryRank);
    } else {
      expect(stored?.pinnedRank).toBeUndefined();
    }
  } finally {
    accepted.resolve({ threadId });
    await registry.close();
    viewerDb.close();
    db.close();
    removeTempStateDbDir(temp.tempDir);
  }
}

it("pins a clean handoff into a collapsed project before any navigation snapshot has arrived", async () => {
  await assertWorktreePlacement({ cachedFold: undefined, finalFold: true, ordinaryRank: -1024 });
});

it("reads the preferred checkout's fold for a cold handoff from a secondary checkout", async () => {
  await assertWorktreePlacement({ cachedFold: undefined, finalFold: true, ordinaryRank: 0, groupedCheckout: true });
});

it("prepends against a pin order changed while the new worktree thread starts", async () => {
  await assertWorktreePlacement({ cachedFold: true, finalFold: true, ordinaryRank: -1024 });
});

it("keeps the rank of a thread explicitly pinned before creation finalizes", async () => {
  await assertWorktreePlacement({ cachedFold: true, finalFold: true, ordinaryRank: -1024, operatorRank: "2048" });
});

it("places worktree roots according to the saved fold and pin order at acceptance", async () => {
  await fc.assert(fc.asyncProperty(
    fc.option(fc.boolean(), { nil: undefined }),
    fc.boolean(),
    fc.integer({ min: -100_000, max: 100_000 }),
    fc.boolean(),
    fc.boolean(),
    (cachedFold, finalFold, ordinaryRank, peerFirst, groupedCheckout) =>
      assertWorktreePlacement({ cachedFold, finalFold, ordinaryRank, peerFirst, groupedCheckout }),
  ), { numRuns: 20 });
});

async function assertChildPlacement(options: {
  parentLocation: "same" | "elsewhere" | "unknown";
  staleProject: boolean;
  syntheticKey: boolean;
}): Promise<void> {
  const temp = createTempStateDb("pwragent-child-visibility-");
  const db = StateDb.open(temp.dbPath);
  const store = new SqliteOverlayStore(db);
  const directoryPath = expectedDir(path.join(os.tmpdir(), "example-child-project"));
  const directoryKey = `directory:${directoryPath}`;
  const otherPath = expectedDir(path.join(os.tmpdir(), "unrelated-project"));
  const parentPath = options.parentLocation === "same" ? directoryPath : otherPath;
  const pinned: AppServerThreadSummary = {
    id: "existing-root", source: "codex", title: "Existing root", titleSource: "explicit",
    linkedDirectories: [{ id: directoryPath, kind: "local", label: "project", path: directoryPath }],
  };
  const parent: AppServerThreadSummary = {
    ...pinned, id: "parent", title: "Parent",
    linkedDirectories: [{ id: parentPath, kind: "local", label: "parent project", path: parentPath }],
  };
  const knownParent = options.parentLocation !== "unknown";
  const registry = createDesktopBackendRegistry({
    codexClient: new MockBackendClient({ threads: knownParent ? [pinned, parent] : [pinned] }),
    overlayStore: store,
  });
  try {
    if (!options.staleProject) {
      await store.setThreadPin({ backend: "codex", threadId: pinned.id, pinnedRank: "1024" });
    }
    // An index can predate both the first pin and the arrival of a parent.
    const listed = knownParent && !options.staleProject ? [pinned, parent] : [pinned];
    registry.rememberNavigationVisibilityIndex(store.readNavigationQueryIndex({ backend: "all", threads: listed }));
    await store.setThreadPin({ backend: "codex", threadId: pinned.id, pinnedRank: "1024" });
    await store.setDirectoryThreadsCollapsed({ directoryKey, collapsed: true });
    // An attachment alone cannot prove that an unobserved parent's primary
    // checkout is in another project.
    await store.addLinkedDirectory({ backend: "codex", threadId: parent.id, directory: parent.linkedDirectories[0]! });
    if (knownParent) {
      await store.setSubthreadsCollapsed({ backend: "codex", parentThreadId: parent.id, collapsed: true });
    }
    if (options.parentLocation === "elsewhere") {
      // A provider observation can establish the parent's primary checkout
      // before the next sidebar projection arrives.
      await registry.listThreads({ backend: "codex" });
    }
    const result = await registry.startThread({
      backend: "codex", cwd: directoryPath, parentThreadId: parent.id,
      ...(options.syntheticKey ? { directoryKey: "subthread:codex:parent:same-worktree" } : {}),
    });
    const child = await store.getThreadOverlayState({ backend: "codex", threadId: result.threadId });
    const parentOverlay = await store.getThreadOverlayState({ backend: "codex", threadId: parent.id });
    const current = store.readNavigationQueryIndex({ backend: "all", threads: knownParent ? [pinned, parent] : [pinned] });
    const parentRendersHere = current.directories.find((directory) => directory.key === directoryKey)
      ?.threadKeys.includes("codex:parent");
    expect(child?.parentThreadId).toBe(parent.id);
    expect(Boolean(child?.pinnedRank)).toBe(knownParent && !parentRendersHere);
    expect(Boolean(parentOverlay?.pinnedRank)).toBe(Boolean(parentRendersHere));
    if (parentRendersHere) expect(parentOverlay?.subthreadsCollapsed).toBe(false);
  } finally {
    await registry.close();
    db.close();
    removeTempStateDbDir(temp.tempDir);
  }
}

it("resolves a synthetic sub-thread launchpad key to the parent project", async () => {
  await assertChildPlacement({ parentLocation: "same", staleProject: false, syntheticKey: true });
});

it("reveals a newly observed parent without pinning its nested child", async () => {
  await assertChildPlacement({ parentLocation: "same", staleProject: true, syntheticKey: false });
});

it("pins a child only when the owner can establish it renders outside its parent's project", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("same" as const, "elsewhere" as const, "unknown" as const), fc.boolean(), fc.boolean(),
    (parentLocation, staleProject, syntheticKey) => assertChildPlacement({ parentLocation, staleProject, syntheticKey }),
  ), { numRuns: 20 });
});

it("budgets a cold start into a project with a saved collapsed fold", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("pwragent-cold-creation-visibility-");
  const db = StateDb.open(temp.dbPath);
  const store = new SqliteOverlayStore(db);
  const cwd = expectedDir(path.join(os.tmpdir(), "example-cold-project"));
  const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({ threads: [] }), overlayStore: store });
  try {
    await store.setThreadPin({ backend: "codex", threadId: "existing-pin", pinnedRank: "1024" });
    await store.setDirectoryThreadsCollapsed({ directoryKey: `directory:${cwd}`, collapsed: true });
    const { result, writes } = await measureSqliteWrites(() => registry.startThread({ backend: "codex", cwd }));
    expect(result.pinnedRank).toBe("0");
    expectSqliteWriteBudget({
      scenario: "cold-collapsed-project-thread-creation",
      note: "One new thread, including its automatic pin with no navigation snapshot. At 100 starts/day, about 5.4 MB/day. No idle writes.",
      writes,
    });
  } finally {
    await registry.close();
    db.close();
    removeTempStateDbDir(temp.tempDir);
    vi.unstubAllEnvs();
  }
});
