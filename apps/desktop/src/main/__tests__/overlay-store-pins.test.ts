import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-pins-test-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SqliteOverlayStore — thread pins", () => {
  it("sets and clears a thread pin rank", async () => {
    const pinned = await store.setThreadPin({
      backend: "codex",
      threadId: "thread-1",
      pinnedRank: "1024",
    });
    expect(pinned.pinnedRank).toBe("1024");

    const unpinned = await store.setThreadPin({
      backend: "codex",
      threadId: "thread-1",
      pinnedRank: null,
    });
    expect(unpinned.pinnedRank).toBeUndefined();
  });

  it("reorders pins with stable spaced ranks", async () => {
    await store.setThreadPin({
      backend: "codex",
      threadId: "thread-1",
      pinnedRank: "1024",
    });
    await store.setThreadPin({
      backend: "codex",
      threadId: "thread-2",
      pinnedRank: "2048",
    });

    const ranks = await store.reorderThreadPins({
      backend: "codex",
      threadIds: ["thread-2", "thread-1"],
    });

    expect(ranks).toEqual({
      "thread-2": "1024",
      "thread-1": "2048",
    });
    await expect(
      store.getThreadOverlayState({ backend: "codex", threadId: "thread-2" }),
    ).resolves.toMatchObject({ pinnedRank: "1024" });
  });

  it("persists pin state across sqlite handles", async () => {
    await store.setThreadPin({
      backend: "codex",
      threadId: "thread-1",
      pinnedRank: "1024",
    });
    stateDb.close();

    const reopenedDb = StateDb.open(path.join(tempDir, "state.db"));
    const reopenedStore = new SqliteOverlayStore(reopenedDb);
    await expect(
      reopenedStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({ pinnedRank: "1024" });
    reopenedDb.close();
  });
});
