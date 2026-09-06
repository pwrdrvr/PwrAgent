import { afterEach, expect, it, vi } from "vitest";
import { buildFederatedThreadRef, federatedThreadIdentityKey } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { relativePinRanks } from "../state/relative-pin-order";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { openInMemoryStateDb } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

it("moves a displayed pin around an owner anchor while preserving 100 unloaded pins", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteOverlayStore(db);
    for (let index = 0; index < 102; index += 1) {
      await store.setThreadPin({ backend: "codex", threadId: `thread-${index}`, pinnedRank: String((index + 1) * 1024) });
    }
    const { result, writes } = await measureSqliteWrites(() => store.reorderThreadPins({
      move: { key: "codex:thread-0", anchorKey: "codex:thread-101", placement: "after" },
    }));
    expect(Object.keys(result)).toEqual(["codex:thread-0"]);
    expect(Number(result["codex:thread-0"])).toBeGreaterThan(102 * 1024);
    const otherRanks = db.raw.prepare("SELECT json_extract(payload, '$.pinnedRank') AS rank FROM threads WHERE json_extract(payload, '$.threadId') != ?").all("thread-0") as { rank: string }[];
    expect(otherRanks.map((row) => Number(row.rank)).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 101 }, (_, index) => (index + 2) * 1024));
    expectSqliteWriteBudget({ scenario: "navigation-relative-thread-pin", writes,
      note: "One owner-revalidated move across 102 pins changes one rank in one commit; at 100 moves/day and ~4 KiB/commit, ~0.4 MB/day; no idle writes" });
  } finally { db.close(); }
});

it("revalidates directory membership and moves by the complete owner order", async () => {
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteOverlayStore(db);
    for (const [index, key] of ["a", "unloaded", "c"].entries()) {
      await store.setDirectoryPin({ directoryKey: key, pinnedRank: String((index + 1) * 1024) });
    }
    const changed = await store.reorderDirectoryPins({ move: { key: "c", direction: "up" } });
    expect(Number(changed.c)).toBeGreaterThan(1024);
    expect(Number(changed.c)).toBeLessThan(2048);
    await store.setDirectoryPin({ directoryKey: "a", pinnedRank: null });
    await expect(store.reorderDirectoryPins({ move: { key: "c", anchorKey: "a", placement: "before" } }))
      .rejects.toThrow("destination pin no longer exists");
  } finally { db.close(); }
});

it("preserves owner collisions in relative remote and local pin order", async () => {
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteOverlayStore(db);
    const ref = buildFederatedThreadRef({ backend: "codex", instanceId: "peer", threadId: "same" });
    await store.setThreadPin({ backend: "codex", threadId: "same", pinnedRank: "1024" });
    await store.addRemoteThreadPin({ ref, instanceLabel: "Peer" });
    await store.setRemoteThreadLocalPin({ ref, pinnedRank: "2048" });
    const changed = await store.reorderThreadPins({ move: { key: federatedThreadIdentityKey(ref), direction: "up" } });
    expect(Number(changed[federatedThreadIdentityKey(ref)])).toBeLessThan(1024);
    expect((await store.listRemoteThreadPins())[0]?.localPinnedRank).toBe(changed[federatedThreadIdentityKey(ref)]);
  } finally { db.close(); }
});

it("compacts exhausted adjacent ranks without ties and rejects missing moving pins", () => {
  const pins = [{ key: "first", rank: "1" }, { key: "next", rank: String(1 + Number.EPSILON) }, { key: "last", rank: "3" }];
  const ranks = relativePinRanks(pins, { key: "last", anchorKey: "next", placement: "before" });
  expect(ranks).toEqual({ first: "1024", last: "2048", next: "3072" });
  expect(() => relativePinRanks(pins, { key: "missing", direction: "up" })).toThrow("pin no longer exists");
});
