import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createDeferred, expectedDir, MockBackendClient, rememberCollapsedDirectoryWithPinnedThread } from "./helpers/backend-registry-fixture";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

async function assertWorktreePlacement(options: {
  cachedFold: boolean | undefined;
  finalFold: boolean;
  ordinaryRank: number;
  peerFirst?: boolean;
  operatorRank?: string;
}): Promise<void> {
  const temp = createTempStateDb("pwragent-worktree-visibility-");
  const db = StateDb.open(temp.dbPath);
  const viewerDb = StateDb.open(temp.dbPath);
  const store = new SqliteOverlayStore(db);
  const viewer = new SqliteOverlayStore(viewerDb);
  const directoryPath = expectedDir(path.join(os.tmpdir(), "example-project"));
  const directoryKey = `directory:${directoryPath}`;
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
        repositoryPath: directoryPath,
        workMode: "worktree",
      }),
    } as never,
  });
  try {
    await store.setThreadPin({ backend, threadId: "keep-at-top", pinnedRank: keptRank });
    await store.setThreadPin({ backend, threadId: "thread-pinned", pinnedRank: "1024" });
    if (options.cachedFold !== undefined) {
      await store.setDirectoryThreadsCollapsed({ directoryKey, collapsed: options.cachedFold });
      rememberCollapsedDirectoryWithPinnedThread({
        registry, directoryKey, directoryPath, collapsed: options.cachedFold,
        unpinnedThreadIds: ["existing-unpinned"],
      });
    }

    // Clean, ungrouped local handoffs use this start path without a directory key.
    const creation = registry.startThread({ backend, cwd: directoryPath, workMode: "worktree" });
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
    (cachedFold, finalFold, ordinaryRank, peerFirst) => assertWorktreePlacement({ cachedFold, finalFold, ordinaryRank, peerFirst }),
  ), { numRuns: 20 });
});
