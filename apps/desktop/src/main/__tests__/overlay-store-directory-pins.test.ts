import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

/**
 * Mirror of `overlay-store-pins.test.ts` for directory-pin
 * persistence (plan: 2026-05-09-002-feat-directory-pinning-plan.md
 * Units B + C). The overlay store is the foundation of the feature
 * — without it, pins don't survive restarts, can't be reordered, and
 * the snapshot has nothing to attach to the directory summary. The
 * tests assert each end of the contract that the rest of the plan
 * leans on:
 *
 *   - put + get round-trip preserves `pinnedRank`.
 *   - put with `pinnedRank: null` clears the rank.
 *   - `reorderDirectoryPins` assigns spaced ranks `1024`, `2048`,
 *     `3072`, ... in order.
 *   - Pin state survives `StateDb` close + reopen (the migration
 *     path leaves the table intact).
 *   - Reordering with a non-existent directoryKey is a no-op for
 *     that key (does not throw, does not corrupt other ranks).
 */
describe("SqliteOverlayStore — directory pins", () => {
  it("sets and clears a directory pin rank", async () => {
    const pinned = await store.setDirectoryPin({
      directoryKey: "directory:/Users/me/code/PwrAgent",
      pinnedRank: "1024",
    });
    expect(pinned.pinnedRank).toBe("1024");

    const unpinned = await store.setDirectoryPin({
      directoryKey: "directory:/Users/me/code/PwrAgent",
      pinnedRank: null,
    });
    expect(unpinned.pinnedRank).toBeUndefined();
  });

  it("returns the persisted overlay state for a directoryKey", async () => {
    await store.setDirectoryPin({
      directoryKey: "directory:/Users/me/code/PwrAgent",
      pinnedRank: "2048",
    });

    await expect(
      store.getDirectoryOverlayState({
        directoryKey: "directory:/Users/me/code/PwrAgent",
      }),
    ).resolves.toMatchObject({ pinnedRank: "2048" });
  });

  it("returns undefined for a directoryKey with no overlay row", async () => {
    await expect(
      store.getDirectoryOverlayState({
        directoryKey: "directory:/Users/me/code/never-pinned",
      }),
    ).resolves.toBeUndefined();
  });

  it("reorders directory pins with stable spaced ranks", async () => {
    await store.setDirectoryPin({
      directoryKey: "directory:/Users/me/code/PwrAgent",
      pinnedRank: "1024",
    });
    await store.setDirectoryPin({
      directoryKey: "directory:/Users/me/code/PwrSnap",
      pinnedRank: "2048",
    });

    const ranks = await store.reorderDirectoryPins({
      directoryKeys: [
        "directory:/Users/me/code/PwrSnap",
        "directory:/Users/me/code/PwrAgent",
      ],
    });

    expect(ranks).toEqual({
      "directory:/Users/me/code/PwrSnap": "1024",
      "directory:/Users/me/code/PwrAgent": "2048",
    });
    await expect(
      store.getDirectoryOverlayState({
        directoryKey: "directory:/Users/me/code/PwrSnap",
      }),
    ).resolves.toMatchObject({ pinnedRank: "1024" });
  });

  it("reorderDirectoryPins assigns ranks to previously-unpinned keys", async () => {
    // Mirrors the thread-pin behavior: reorder can promote a key
    // into the pinned section even if it had no prior rank.
    const ranks = await store.reorderDirectoryPins({
      directoryKeys: [
        "directory:/Users/me/code/Brand-new",
        "directory:/Users/me/code/Another",
      ],
    });

    expect(ranks).toEqual({
      "directory:/Users/me/code/Brand-new": "1024",
      "directory:/Users/me/code/Another": "2048",
    });
  });

  it("persists pin state across sqlite handles", async () => {
    const { dbPath, tempDir } = createTempStateDb(
      "pwragent-directory-pins-test-",
    );
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);

    try {
      await store.setDirectoryPin({
        directoryKey: "directory:/Users/me/code/PwrAgent",
        pinnedRank: "1024",
      });
      stateDb.close();

      const reopenedDb = StateDb.open(dbPath);
      const reopenedStore = new SqliteOverlayStore(reopenedDb);
      try {
        await expect(
          reopenedStore.getDirectoryOverlayState({
            directoryKey: "directory:/Users/me/code/PwrAgent",
          }),
        ).resolves.toMatchObject({ pinnedRank: "1024" });
      } finally {
        reopenedDb.close();
      }
    } finally {
      stateDb.close();
      removeTempStateDbDir(tempDir);
      stateDb = openInMemoryStateDb();
      store = new SqliteOverlayStore(stateDb);
    }
  });

  it("readAllDirectoryOverlays returns every persisted row keyed by directoryKey", async () => {
    // Required by the snapshot builder (Unit D) so it can attach
    // pinnedRank to every summary in one pass.
    await store.setDirectoryPin({
      directoryKey: "directory:/a",
      pinnedRank: "1024",
    });
    await store.setDirectoryPin({
      directoryKey: "directory:/b",
      pinnedRank: "2048",
    });

    const all = await store.readAllDirectoryOverlays();
    expect(all).toEqual({
      "directory:/a": { directoryKey: "directory:/a", pinnedRank: "1024" },
      "directory:/b": { directoryKey: "directory:/b", pinnedRank: "2048" },
    });
  });
});
