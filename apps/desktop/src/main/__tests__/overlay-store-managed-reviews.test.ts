import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppServerThreadReviewEntry } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;

function buildReviewEntry(
  overrides: Partial<AppServerThreadReviewEntry>,
): AppServerThreadReviewEntry {
  return {
    type: "review",
    id: "managed-review:turn-1:started",
    review: "Review current changes",
    createdAt: 1000,
    turn: {
      id: "turn-1",
      status: "in_progress",
      startedAt: 1000,
    },
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

describe("SqliteOverlayStore — managed review entries", () => {
  it("upserts entries by id", async () => {
    await store.upsertManagedReviewEntry({
      backend: "codex",
      threadId: "thread-1",
      entry: buildReviewEntry({}),
    });
    await store.upsertManagedReviewEntry({
      backend: "codex",
      threadId: "thread-1",
      entry: buildReviewEntry({ review: "Updated review label" }),
    });

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.managedReviewEntries).toEqual([
      expect.objectContaining({ review: "Updated review label" }),
    ]);
  });

  it("persists structured results across a database reopen", async () => {
    const { dbPath, tempDir } = createTempStateDb(
      "pwragent-managed-reviews-test-",
    );
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);

    try {
      const result = buildReviewEntry({
        id: "managed-review:turn-1:result",
        review: "No blocking findings.",
        createdAt: 2000,
        output: {
          findings: [],
          overall_correctness: "patch is correct",
          overall_explanation: "No blocking findings.",
          overall_confidence_score: 0.96,
        },
        turn: {
          id: "turn-1",
          status: "completed",
          completedAt: 2000,
        },
      });
      await store.upsertManagedReviewEntry({
        backend: "codex",
        threadId: "thread-1",
        entry: result,
      });
      stateDb.close();

      const reopened = StateDb.open(dbPath);
      const reopenedStore = new SqliteOverlayStore(reopened);
      try {
        const overlay = await reopenedStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        });
        expect(overlay?.managedReviewEntries).toEqual([result]);
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
});
