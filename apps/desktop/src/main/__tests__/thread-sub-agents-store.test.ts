import type { ThreadSubAgentSummary } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import {
  ensureThreadSubAgentSchema,
  THREAD_SUB_AGENTS_MOVED_META_KEY,
} from "../state/thread-sub-agents";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

// Sub-agent and Token Miser gate cards used to live in the parent's
// `threads.payload.subAgents` array: a busy thread held 2,043 of them, so
// every overlay read parsed ~3.5 MB and every card or scalar write rewrote it.
// These tests hold the table to the property that replaced it — a card write
// and an overlay write cost the same whatever the thread's card count — and
// cover the paths that keep older builds and older payloads working.

const BIG = 2_000;

function card(index: number, overrides: Partial<ThreadSubAgentSummary> = {}): ThreadSubAgentSummary {
  return {
    agentName: "Token Miser",
    backend: "codex",
    completedAt: 1_800_000_000_500 + index,
    createdAt: 1_800_000_000_000 + index,
    monitorId: `system:token-miser:gate-${String(index).padStart(6, "0")}`,
    outcome: "success",
    status: "success",
    task: "Gate commandExecution output",
    updatedAt: 1_800_000_000_500 + index,
    ...overrides,
  };
}

function legacyPayload(threadId: string, subAgents: unknown[]): string {
  return JSON.stringify({
    backend: "codex",
    executionMode: "default",
    extraLinkedDirectories: [],
    subAgents,
    threadId,
  });
}

describe("thread sub-agent table", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  function openStore(options: { metrics?: boolean } = {}) {
    if (options.metrics) vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-sub-agents-");
    const stateDb = StateDb.open(temp.dbPath);
    cleanups.push(() => removeTempStateDbDir(temp.tempDir));
    cleanups.push(() => stateDb.close());
    return { dbPath: temp.dbPath, stateDb, store: new SqliteOverlayStore(stateDb) };
  }

  /** Two threads with overlay rows: one with no cards, one with `BIG`. */
  async function seedSmallAndLarge(store: SqliteOverlayStore, stateDb: StateDb) {
    for (const threadId of ["thread-small", "thread-large"]) {
      await store.setThreadReaction({ backend: "codex", emoji: "👀", present: true, threadId });
    }
    await store.upsertThreadSubAgents({
      backend: "codex",
      subAgents: Array.from({ length: BIG }, (_, index) => card(index)),
      threadId: "thread-large",
    });
    // A launched app has finished the one-time move; measure that state.
    await store.moveLegacyThreadSubAgents();
    stateDb.raw.pragma("wal_checkpoint(TRUNCATE)");
  }

  function payloadBytes(stateDb: StateDb, threadId: string): number {
    return (stateDb.raw.prepare(
      "SELECT octet_length(payload) AS bytes FROM threads WHERE json_extract(payload, '$.threadId') = ?",
    ).get(threadId) as { bytes: number }).bytes;
  }

  it("upserts a card at the same cost on a thread with 0 or 2,000 cards", async () => {
    const { stateDb, store } = openStore({ metrics: true });
    await seedSmallAndLarge(store, stateDb);

    const upsert = (threadId: string, subAgent: ThreadSubAgentSummary) =>
      measureSqliteWrites(() => store.upsertThreadSubAgent({ backend: "codex", subAgent, threadId }));
    const newSmall = await upsert("thread-small", card(BIG));
    const newLarge = await upsert("thread-large", card(BIG));
    const changedSmall = await upsert("thread-small", card(BIG, { lastMessage: "Done." }));
    const changedLarge = await upsert("thread-large", card(BIG, { lastMessage: "Done." }));
    const unchangedLarge = await upsert("thread-large", card(BIG, { lastMessage: "Done." }));

    const counts = ({ writes }: { writes: { commits: number; rowsChanged: number; statements: number } }) =>
      ({ commits: writes.commits, rowsChanged: writes.rowsChanged, statements: writes.statements });
    expect(counts(newLarge)).toEqual(counts(newSmall));
    expect(counts(changedLarge)).toEqual(counts(changedSmall));
    // An unchanged card changes no row.
    expect(unchangedLarge.writes.rowsChanged).toBe(0);
    expectSqliteWriteBudget({
      note: "one changed gate card on a thread holding 2,000 cards: its own row and the revision counter, never the parent overlay row, and equal to the same write on a thread with no cards. ~12 KB WAL: ~25 MB/day at 2,000 card writes/day, where each one rewrote the ~3.5 MB overlay row before",
      scenario: "thread-sub-agent-upsert-flat",
      writes: changedLarge.writes,
    });
    expect(payloadBytes(stateDb, "thread-large")).toBe(payloadBytes(stateDb, "thread-small"));
  });

  it("writes an overlay scalar at the same cost on a thread with 0 or 2,000 cards", async () => {
    const { stateDb, store } = openStore({ metrics: true });
    await seedSmallAndLarge(store, stateDb);

    const react = (threadId: string) => measureSqliteWrites(() =>
      store.setThreadReaction({ backend: "codex", emoji: "✅", present: true, threadId }));
    const small = await react("thread-small");
    const large = await react("thread-large");

    expect(large.writes.commits).toBe(small.writes.commits);
    expect(large.writes.rowsChanged).toBe(small.writes.rowsChanged);
    expect(large.writes.statements).toBe(small.writes.statements);
    expect(payloadBytes(stateDb, "thread-large")).toBeLessThan(4_096);
    expectSqliteWriteBudget({
      note: "one overlay scalar write (a reaction) on a thread holding 2,000 gate cards: the small overlay row only, ~16 KB WAL. It rewrote the ~3.5 MB row while the cards lived there",
      scenario: "overlay-scalar-write-flat",
      writes: large.writes,
    });
  });

  it("parses the same overlay bytes on a thread with 0 or 2,000 cards", async () => {
    const { stateDb, store } = openStore();
    await seedSmallAndLarge(store, stateDb);
    const parsed: number[] = [];
    const parse = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      parsed.push(text.length);
      return parse(text, reviver);
    });
    const read = async (threadId: string) => {
      parsed.length = 0;
      await store.getThreadOverlayState({ backend: "codex", threadId });
      return parsed.reduce((total, bytes) => total + bytes, 0);
    };
    const small = await read("thread-small");
    const large = await read("thread-large");
    spy.mockRestore();

    expect(large).toBe(small);
    expect(large).toBeLessThan(4_096);
    // The cards are still there for the readers that ask for them.
    expect(await store.readThreadSubAgentRevision({ backend: "codex", threadId: "thread-large" }))
      .toMatchObject({ count: BIG });
  });

  it("finds the gate a turn end looks up by key, not by scanning the thread", async () => {
    const { stateDb, store } = openStore();
    await seedSmallAndLarge(store, stateDb);
    const plans = (sql: string, ...args: unknown[]) =>
      (stateDb.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
        .map((row) => row.detail);

    expect(plans("SELECT card FROM thread_sub_agents WHERE thread_id = ? AND monitor_id = ?", "k", "m").join("\n"))
      .toMatch(/SEARCH thread_sub_agents USING INDEX sqlite_autoindex_thread_sub_agents_1 \(thread_id=\? AND monitor_id=\?\)/);
    expect(plans(`SELECT card FROM thread_sub_agents INDEXED BY thread_sub_agents_attention
      WHERE thread_id = ? AND (completed_at IS NULL OR status IN ('failed', 'failure'))`, "k").join("\n"))
      .not.toMatch(/SCAN thread_sub_agents/);
  });

  describe("older writers", () => {
    it.each([false, true])("capture a whole-payload write's cards (recursive_triggers %s)", async (recursive) => {
      const { dbPath, store } = openStore();
      await store.upsertThreadSubAgent({
        backend: "codex",
        subAgent: card(2, { status: "running", completedAt: undefined, updatedAt: 1_900_000_000_000 }),
        threadId: "thread-1",
      });
      const storageKey = "codex:thread-1";

      // An older build on the same profile rewrites the whole row from its own
      // copy: one stale card, one new card, one card this build never saw.
      const older = StateDb.open(dbPath);
      try {
        older.raw.pragma(`recursive_triggers = ${recursive ? "ON" : "OFF"}`);
        older.raw.prepare(`INSERT OR REPLACE INTO threads(thread_id, directory_path, last_seen_at, dismissed_at, snoozed_until, payload)
          VALUES (?, NULL, NULL, NULL, NULL, ?)`).run(storageKey, legacyPayload("thread-1", [
          card(2, { status: "running", completedAt: undefined, updatedAt: 1_000 }),
          card(1),
        ]));
        // And then writes a payload with no array at all.
        older.raw.prepare("UPDATE threads SET payload = ? WHERE thread_id = ?")
          .run(JSON.stringify({ backend: "codex", executionMode: "full-access", extraLinkedDirectories: [], threadId: "thread-1" }), storageKey);
      } finally {
        older.close();
      }

      const stored = await store.listThreadSubAgents({ backend: "codex", threadId: "thread-1" });
      expect(stored.map((entry) => [entry.monitorId, entry.updatedAt])).toEqual([
        [card(2).monitorId, 1_900_000_000_000],
        [card(1).monitorId, card(1).updatedAt],
      ]);
      const overlay = await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" });
      expect(overlay).toMatchObject({ executionMode: "full-access" });
      expect(overlay).not.toHaveProperty("subAgents");
    });
  });

  describe("one-time move of legacy payload arrays", () => {
    /**
     * Rows written before this build's triggers existed, on a profile the
     * move has not finished. Returns a store opened after the seeding.
     */
    function seedLegacyRows(
      stateDb: StateDb,
      rows: Array<{ threadId: string; subAgents: ThreadSubAgentSummary[] }>,
    ): SqliteOverlayStore {
      stateDb.raw.prepare("DELETE FROM meta WHERE key = ?").run(THREAD_SUB_AGENTS_MOVED_META_KEY);
      stateDb.raw.exec("DROP TRIGGER thread_sub_agents_capture_insert; DROP TRIGGER thread_sub_agents_capture_update;");
      const insert = stateDb.raw.prepare(`INSERT INTO threads(thread_id, directory_path, last_seen_at, dismissed_at, snoozed_until, payload)
        VALUES (?, NULL, NULL, NULL, NULL, ?)`);
      for (const row of rows) {
        insert.run(`codex:${row.threadId}`, legacyPayload(row.threadId, row.subAgents));
      }
      ensureThreadSubAgentSchema(stateDb.raw);
      return new SqliteOverlayStore(stateDb);
    }

    const cards = (count: number) => Array.from({ length: count }, (_, index) => card(index));

    it("moves one thread's array on first read, before the sweep reaches it", async () => {
      const { stateDb } = openStore();
      const store = seedLegacyRows(stateDb, [{ threadId: "thread-1", subAgents: cards(3) }]);

      const overlay = await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" });
      expect(overlay).not.toHaveProperty("subAgents");
      expect(await store.listThreadSubAgents({ backend: "codex", threadId: "thread-1" })).toHaveLength(3);
      expect(payloadBytes(stateDb, "thread-1")).toBeLessThan(200);
    });

    it("keeps a legacy card's managed child out of navigation before and after the move", async () => {
      const { stateDb } = openStore();
      const store = seedLegacyRows(stateDb, [{ threadId: "parent", subAgents: [
        card(1, { agentName: "Worker", monitorId: "codex-native:child", monitorThreadId: "child" }),
      ] }]);
      const managedKeys = () =>
        (store as unknown as { listManagedSubAgentThreadKeys(): Set<string> }).listManagedSubAgentThreadKeys();
      const before = [...managedKeys()];
      await store.moveLegacyThreadSubAgents();
      expect([...managedKeys()]).toEqual(before);
      expect(before).toContain("codex:child");
    });

    it("sweeps every row in bounded slices, then never scans again", async () => {
      const { stateDb } = openStore({ metrics: true });
      const store = seedLegacyRows(stateDb, Array.from({ length: 12 }, (_, index) => ({ threadId: `thread-${index}`, subAgents: cards(40) })));
      stateDb.raw.pragma("wal_checkpoint(TRUNCATE)");

      const yields: number[] = [];
      const { result, writes } = await measureSqliteWrites(() => store.moveLegacyThreadSubAgents({
        // About three rows of ~12 KB per slice.
        byteBudget: 36 * 1024,
        yieldBetweenSlices: async () => {
          yields.push(Date.now());
        },
      }));
      expect(result.slices).toBeGreaterThan(3);
      expect(yields).toHaveLength(result.slices - 1);
      expect(stateDb.getMeta(THREAD_SUB_AGENTS_MOVED_META_KEY)).toBe("1");
      expect((stateDb.raw.prepare(
        "SELECT count(*) AS n FROM threads WHERE json_type(payload, '$.subAgents') IS NOT NULL",
      ).get() as { n: number }).n).toBe(0);
      expect((stateDb.raw.prepare("SELECT count(*) AS n FROM thread_sub_agents").get() as { n: number }).n).toBe(480);
      expectSqliteWriteBudget({
        note: "one-time move of 12 legacy payloads holding 40 cards each, in 36 KB slices: one commit per slice, the last one setting the marker. Runs once per profile; the 2,043-card production copy moved in 25 slices (p50 89 ms, ~195 MB WAL once)",
        scenario: "thread-sub-agents-move",
        writes,
      });

      const repeat = await measureSqliteWrites(async () => {
        await store.moveLegacyThreadSubAgents();
        // A fresh store on the same profile trusts the marker too.
        await new SqliteOverlayStore(stateDb).moveLegacyThreadSubAgents();
        await store.getThreadOverlayState({ backend: "codex", threadId: "thread-0" });
      });
      expectSqliteWriteBudget({
        note: "the move and a read after it on a profile already marked moved: no writes",
        scenario: "thread-sub-agents-move-repeat",
        writes: repeat.writes,
      });
      expect(repeat.writes.commits).toBe(0);
    });
  });

  it("deletes a forgotten thread's cards with it", async () => {
    const { stateDb, store } = openStore();
    await store.setThreadReaction({ backend: "codex", emoji: "👀", present: true, threadId: "thread-1" });
    await store.upsertThreadSubAgents({ backend: "codex", subAgents: [card(1), card(2)], threadId: "thread-1" });
    await store.upsertThreadSubAgents({ backend: "codex", subAgents: [card(3)], threadId: "thread-2" });

    await store.forgetThreadArchiveStates([{ backend: "codex", threadId: "thread-1" }]);

    expect((stateDb.raw.prepare("SELECT thread_id, count(*) AS n FROM thread_sub_agents GROUP BY thread_id").all()))
      .toEqual([{ n: 1, thread_id: "codex:thread-2" }]);
    expect(await store.readThreadSubAgentRevision({ backend: "codex", threadId: "thread-1" }))
      .toEqual({ count: 0, revision: 0 });
  });
});
