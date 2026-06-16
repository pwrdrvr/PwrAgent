import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadTurnFailure } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;

function buildFailure(
  overrides: Partial<ThreadTurnFailure>,
): ThreadTurnFailure {
  return {
    id: "01HV0000000000000000000001",
    turnId: "turn-1",
    error: "stream disconnected before completion",
    occurredAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

describe("SqliteOverlayStore — turn failure log", () => {
  it("appends a failure entry that getThreadOverlayState surfaces", async () => {
    await store.appendTurnFailure({
      backend: "codex",
      threadId: "thread-1",
      failure: buildFailure({ id: "entry-1", turnId: "turn-1" }),
    });

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.turnFailureLog).toEqual([
      buildFailure({ id: "entry-1", turnId: "turn-1" }),
    ]);
  });

  it("dedupes a repeated failure for the same turnId", async () => {
    await store.appendTurnFailure({
      backend: "codex",
      threadId: "thread-1",
      failure: buildFailure({ id: "entry-1", turnId: "turn-1", occurredAt: 1000 }),
    });
    // Re-observe the same turn failure (reconnect / replay) — must NOT add
    // a second entry and must keep the first-seen timestamp.
    await store.appendTurnFailure({
      backend: "codex",
      threadId: "thread-1",
      failure: buildFailure({ id: "entry-2", turnId: "turn-1", occurredAt: 9999 }),
    });

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.turnFailureLog).toHaveLength(1);
    expect(overlay?.turnFailureLog?.[0]?.id).toBe("entry-1");
    expect(overlay?.turnFailureLog?.[0]?.occurredAt).toBe(1000);
  });

  it("evicts the oldest entry when 101 failures are appended", async () => {
    for (let index = 0; index < 101; index += 1) {
      await store.appendTurnFailure({
        backend: "codex",
        threadId: "thread-1",
        failure: buildFailure({
          id: `entry-${index}`,
          turnId: `turn-${index}`,
          occurredAt: 1000 + index,
        }),
      });
    }

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.turnFailureLog).toHaveLength(100);
    expect(overlay?.turnFailureLog?.[0]?.id).toBe("entry-1");
    expect(overlay?.turnFailureLog?.[99]?.id).toBe("entry-100");
  });

  it("persists the failure log across a reopen", async () => {
    const { dbPath, tempDir } = createTempStateDb(
      "pwragent-turn-failures-test-",
    );
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);

    try {
      await store.appendTurnFailure({
        backend: "codex",
        threadId: "thread-1",
        failure: buildFailure({ id: "entry-1", turnId: "turn-1" }),
      });
      stateDb.close();

      const reopened = StateDb.open(dbPath);
      const reopenedStore = new SqliteOverlayStore(reopened);
      try {
        const overlay = await reopenedStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        });
        expect(overlay?.turnFailureLog).toEqual([
          buildFailure({ id: "entry-1", turnId: "turn-1" }),
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      stateDb.close();
      removeTempStateDbDir(tempDir);
      stateDb = openInMemoryStateDb();
      store = new SqliteOverlayStore(stateDb);
    }
  });

  it("scopes the log per (backend, threadId)", async () => {
    await store.appendTurnFailure({
      backend: "codex",
      threadId: "thread-1",
      failure: buildFailure({ id: "codex-1", turnId: "turn-c" }),
    });
    await store.appendTurnFailure({
      backend: "grok",
      threadId: "thread-1",
      failure: buildFailure({ id: "grok-1", turnId: "turn-g" }),
    });

    const codex = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    const grok = await store.getThreadOverlayState({
      backend: "grok",
      threadId: "thread-1",
    });

    expect(codex?.turnFailureLog?.map((entry) => entry.id)).toEqual(["codex-1"]);
    expect(grok?.turnFailureLog?.map((entry) => entry.id)).toEqual(["grok-1"]);
  });
});
