import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

describe("thread git working-state cache", () => {
  it("round-trips a working-state entry", async () => {
    await store.writeThreadGitWorkingStateCacheEntry({
      worktreePath: "/repo/wt",
      fetchedAt: 1234,
      gitWorkingState: {
        dirtyFiles: 2,
        dirtyAdditions: 11,
        dirtyDeletions: 3,
        untrackedFiles: 1,
        unpushedCommits: 4,
      },
    });

    const cache = await store.readThreadGitWorkingStateCache();
    expect(cache).toEqual({
      "/repo/wt": {
        worktreePath: "/repo/wt",
        fetchedAt: 1234,
        gitWorkingState: {
          dirtyFiles: 2,
          dirtyAdditions: 11,
          dirtyDeletions: 3,
          untrackedFiles: 1,
          unpushedCommits: 4,
        },
      },
    });
  });

  it("overwrites by worktree path and persists a null (clean) probe", async () => {
    await store.writeThreadGitWorkingStateCacheEntry({
      worktreePath: "/repo/wt",
      fetchedAt: 1,
      gitWorkingState: {
        dirtyFiles: 5,
        dirtyAdditions: 1,
        dirtyDeletions: 1,
        untrackedFiles: 0,
        unpushedCommits: 0,
      },
    });
    // A later probe found nothing (clean tree, not a repo, or failed).
    await store.writeThreadGitWorkingStateCacheEntry({
      worktreePath: "/repo/wt",
      fetchedAt: 2,
    });

    const cache = await store.readThreadGitWorkingStateCache();
    expect(cache).toEqual({
      "/repo/wt": { worktreePath: "/repo/wt", fetchedAt: 2 },
    });
  });
});
