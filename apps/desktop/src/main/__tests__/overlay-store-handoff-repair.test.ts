import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import {
  CURRENT_STATE_DB_USER_VERSION,
  StateDb,
} from "../state/state-db";
import {
  createTempStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

let dbPath: string;
let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

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

function reopenAndCountImmediateTransactions(): number {
  const originalTransaction = Database.prototype.transaction;
  let immediateTransactions = 0;
  const transactionSpy = vi
    .spyOn(Database.prototype, "transaction")
    .mockImplementation(function transaction(
      this: Database.Database,
      callback,
    ) {
      const transaction = originalTransaction.call(this, callback) as unknown as
        Record<string, unknown>;
      const wrapped = ((...args: unknown[]) =>
        (transaction as unknown as (...values: unknown[]) => unknown)(
          ...args
        )) as unknown as Record<string, unknown>;
      for (const variant of ["default", "deferred", "immediate", "exclusive"]) {
        const originalVariant = transaction[variant];
        if (typeof originalVariant !== "function") continue;
        Object.defineProperty(wrapped, variant, {
          configurable: true,
          value: (...args: unknown[]) => {
            if (variant === "immediate") {
              immediateTransactions += 1;
            }
            return originalVariant(...args);
          },
          writable: true,
        });
      }
      return wrapped as unknown as ReturnType<typeof originalTransaction>;
    });
  stateDb.close();
  try {
    stateDb = StateDb.open(dbPath);
  } finally {
    transactionSpy.mockRestore();
  }
  store = new SqliteOverlayStore(stateDb);
  return immediateTransactions;
}

beforeEach(() => {
  ({ dbPath, tempDir } = createTempStateDb("pwragent-handoff-repair-"));
  stateDb = StateDb.open(dbPath);
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  removeTempStateDbDir(tempDir);
});

describe("StateDb — handoff navigation migration", () => {
  it("repairs a grouped handoff hidden by a native sub-agent card once during schema migration", async () => {
    await seedMisclassifiedHandoff(store);
    stateDb.raw.pragma("user_version = 55");
    expect(reopenAndCountImmediateTransactions()).toBe(1);

    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
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

    expect(reopenAndCountImmediateTransactions()).toBe(0);
    await expect(
      store.getThreadOverlayState({
        backend: "codex",
        threadId: "watcher-thread",
      }),
    ).resolves.toMatchObject({ subAgents: [] });
  });

  it("keeps a handoff visible when an older instance recreates the stale card", async () => {
    await seedMisclassifiedHandoff(store);
    stateDb.raw.pragma("user_version = 55");
    expect(reopenAndCountImmediateTransactions()).toBe(1);

    // Simulate a supported pre-v56 instance sharing the profile after the
    // migration has committed.
    await seedMisclassifiedHandoff(store);
    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "all",
      fetchedAt: 1_800_000_002_000,
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
    await expect(
      store.getThreadOverlayState({
        backend: "codex",
        threadId: "watcher-thread",
      }),
    ).resolves.toMatchObject({
      subAgents: [
        expect.objectContaining({
          monitorId: "codex-native:handoff-child",
        }),
      ],
    });
  });

  it("preserves a peer update committed before the serialized migration begins", async () => {
    await seedMisclassifiedHandoff(store);
    stateDb.raw.pragma("user_version = 55");
    const peerStateDb = stateDb;
    const peerStore = store;
    const originalTransaction = Database.prototype.transaction;
    let injectedPeerUpdate = false;
    const transactionSpy = vi
      .spyOn(Database.prototype, "transaction")
      .mockImplementation(function transaction(
        this: Database.Database,
        callback,
      ) {
        const transaction = originalTransaction.call(this, callback);
        if (!injectedPeerUpdate) {
          injectedPeerUpdate = true;
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
        }
        return transaction;
      });

    let migratedStateDb: StateDb | undefined;
    try {
      migratedStateDb = StateDb.open(dbPath);
    } finally {
      transactionSpy.mockRestore();
    }
    expect(injectedPeerUpdate).toBe(true);
    peerStateDb.close();
    if (!migratedStateDb) {
      throw new Error("Expected the migrated state database to open.");
    }
    stateDb = migratedStateDb;
    store = new SqliteOverlayStore(stateDb);

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
  });
});
