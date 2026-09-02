import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;

async function seedMisclassifiedHandoff(
  targetStore: SqliteOverlayStore,
): Promise<void> {
  await targetStore.setThreadParent({
    backend: "codex",
    threadId: "handoff-child",
    parentThreadId: "handoff-parent",
  });
  await targetStore.updateSubthreadOrder({
    backend: "codex",
    parentThreadId: "handoff-parent",
    threadIds: ["handoff-child"],
  });
  await targetStore.setThreadHandoffOrigin({
    backend: "codex",
    threadId: "handoff-child",
    handoffOrigin: {
      sourceBackend: "codex",
      sourceThreadId: "handoff-parent",
      sourceTurnId: "turn-parent",
      sourceTitle: "Parent investigation",
      taskTitle: "Repair the child issue",
      seedMode: "clean",
      groupingMode: "subthread",
      createdAt: 1_800_000_000_000,
      workspace: {
        mode: "new_worktree",
        cwd: "/tmp/pwragent-handoff-child",
        git: {
          kind: "git_worktree",
          worktreeCreationAvailable: true,
        },
      },
    },
  });
  await targetStore.upsertThreadSubAgent({
    backend: "codex",
    threadId: "watcher-thread",
    subAgent: {
      monitorId: "codex-native:handoff-child",
      task: "Codex subagent handoff-c",
      status: "success",
      createdAt: 1_800_000_000_100,
      updatedAt: 1_800_000_000_200,
      backend: "codex",
      monitorThreadId: "handoff-child",
      monitorTurnId: "turn-watcher",
      outcome: "success",
      completedAt: 1_800_000_000_200,
    },
  });
}

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

describe("SqliteOverlayStore — handoff navigation repair", () => {
  it("keeps a grouped handoff visible when a monitor misclassified it as a native sub-agent", async () => {
    await seedMisclassifiedHandoff(store);

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "all",
      fetchedAt: 1_800_000_001_000,
      threads: [
        {
          id: "handoff-parent",
          title: "Parent investigation",
          titleSource: "explicit",
          source: "codex",
          updatedAt: 1_800_000_000_000,
          linkedDirectories: [],
        },
        {
          id: "handoff-child",
          title: "Repair the child issue",
          titleSource: "explicit",
          source: "codex",
          updatedAt: 1_800_000_000_200,
          linkedDirectories: [],
        },
      ],
    });

    expect(snapshot.threads.map((thread) => thread.id)).toEqual([
      "handoff-parent",
      "handoff-child",
    ]);
    const backendState = JSON.parse(
      stateDb.raw
        .prepare("SELECT payload FROM backends WHERE scope = ?")
        .pluck()
        .get("all") as string,
    ) as { knownThreadKeys: string[] };
    expect(backendState.knownThreadKeys).toContain("codex:handoff-child");
    await expect(
      store.getThreadOverlayState({
        backend: "codex",
        threadId: "watcher-thread",
      }),
    ).resolves.toMatchObject({ subAgents: [] });
  });

  it("preserves a peer update committed after repair candidate discovery", async () => {
    const { dbPath, tempDir } = createTempStateDb(
      "pwragent-handoff-repair-race-",
    );
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
    const peerStateDb = StateDb.open(dbPath);
    const peerStore = new SqliteOverlayStore(peerStateDb);

    try {
      await seedMisclassifiedHandoff(store);
      const originalTransaction = stateDb.raw.transaction.bind(stateDb.raw);
      vi.spyOn(stateDb.raw, "transaction").mockImplementationOnce(
        (callback) => {
          void peerStore.upsertThreadSubAgent({
            backend: "codex",
            threadId: "watcher-thread",
            subAgent: {
              monitorId: "monitor:concurrent-update",
              task: "Concurrent peer update",
              status: "running",
              createdAt: 1_800_000_000_300,
              updatedAt: 1_800_000_000_300,
              backend: "codex",
              monitorThreadId: "concurrent-child",
              monitorTurnId: "turn-concurrent",
            },
          });
          return originalTransaction(callback);
        },
      );

      expect(store.repairMisclassifiedHandoffSubAgents()).toMatchObject({
        removedSubAgents: 1,
        repairedParentThreads: 1,
      });
      await expect(
        store.getThreadOverlayState({
          backend: "codex",
          threadId: "watcher-thread",
        }),
      ).resolves.toMatchObject({
        subAgents: [
          expect.objectContaining({
            monitorId: "monitor:concurrent-update",
          }),
        ],
      });
    } finally {
      peerStateDb.close();
      stateDb.close();
      removeTempStateDbDir(tempDir);
      stateDb = openInMemoryStateDb();
      store = new SqliteOverlayStore(stateDb);
    }
  });
});
