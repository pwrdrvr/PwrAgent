import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StarMapArrangementEntry } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;

function entry(
  overrides: Partial<StarMapArrangementEntry>,
): StarMapArrangementEntry {
  return {
    instanceId: "pwr_local",
    threadKey: "codex:t1",
    dx: 10,
    dy: 20,
    updatedAt: 1_000,
    by: "pwr_local",
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

describe("star map arrangement overlay", () => {
  it("round-trips entries", async () => {
    await store.mergeStarMapArrangement([entry({})]);
    const entries = await store.readStarMapArrangement();
    expect(entries).toEqual([entry({})]);
  });

  it("merges last-writer-wins per card and reports accepted deltas", async () => {
    await store.mergeStarMapArrangement([entry({})]);
    const older = await store.mergeStarMapArrangement([
      entry({ dx: 99, dy: 99, updatedAt: 500 }),
    ]);
    expect(older.accepted).toEqual([]);
    const newer = await store.mergeStarMapArrangement([
      entry({ dx: 30, dy: 40, updatedAt: 2_000, by: "pwr_remote" }),
    ]);
    expect(newer.accepted).toHaveLength(1);
    const entries = await store.readStarMapArrangement();
    expect(entries).toEqual([
      entry({ dx: 30, dy: 40, updatedAt: 2_000, by: "pwr_remote" }),
    ]);
  });

  it("replaying a snapshot is a no-op", async () => {
    const snapshot = [
      entry({}),
      entry({ threadKey: "codex:t2", dx: -50, dy: 5 }),
    ];
    await store.mergeStarMapArrangement(snapshot);
    const replay = await store.mergeStarMapArrangement(snapshot);
    expect(replay.accepted).toEqual([]);
  });

  it("stores tombstones so slot resets propagate", async () => {
    await store.mergeStarMapArrangement([entry({})]);
    await store.mergeStarMapArrangement([
      entry({ dx: null, dy: null, updatedAt: 3_000 }),
    ]);
    const entries = await store.readStarMapArrangement();
    expect(entries).toEqual([entry({ dx: null, dy: null, updatedAt: 3_000 })]);
  });

  it("drops malformed rows on read and malformed input on merge", async () => {
    const malformed = {
      instanceId: "pwr_local",
      threadKey: "codex:t9",
      dx: 5,
      dy: null,
      updatedAt: 1,
      by: "pwr_local",
    } as unknown as StarMapArrangementEntry;
    const result = await store.mergeStarMapArrangement([malformed]);
    expect(result.accepted).toEqual([]);
    expect(await store.readStarMapArrangement()).toEqual([]);
  });
});
