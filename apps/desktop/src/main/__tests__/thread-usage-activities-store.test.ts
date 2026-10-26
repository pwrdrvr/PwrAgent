import {
  MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES,
  type AppServerThreadActivityEntry,
  type AppServerThreadSummary,
  type PrSummary,
} from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import {
  ensureThreadUsageActivitySchema,
  THREAD_USAGE_ACTIVITIES_MOVED_META_KEY,
} from "../state/thread-usage-activities";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

// Turn and monitor usage activities used to live in the thread's
// `threads.payload.immutableUsageActivities` array: up to 100 entries, about
// 65 KB on a gated thread (115 KB at most in a production profile), so every
// per-turn scalar write rewrote them. These tests hold the table to the
// property that replaced it, and cover the equality guards that keep a
// re-asserted value from rewriting the row at all.

const FULL = MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES;

function activity(index: number, overrides: Partial<AppServerThreadActivityEntry> = {}): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: `live-turn-usage-turn-${String(index).padStart(4, "0")}`,
    summary: "Turn usage: 1,200 uncached in · 48,000 cached · 900 out (300 reasoning)",
    status: "completed",
    createdAt: 1_800_000_000_000 + index,
    turn: { id: `turn-${String(index).padStart(4, "0")}`, status: "completed" },
    details: [
      { id: `usage-${index}-input`, kind: "read", label: "Input: 49,200 tokens (1,200 uncached, 48,000 cached)", status: "completed" },
      { id: `usage-${index}-output`, kind: "read", label: "Output: 900 tokens (300 reasoning)", status: "completed" },
      { id: `usage-${index}-cost`, kind: "read", label: "Cost: $0.0412 at list price", status: "completed" },
    ],
    ...overrides,
  } as AppServerThreadActivityEntry;
}

function legacyPayload(threadId: string, activities: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    backend: "codex",
    executionMode: "default",
    extraLinkedDirectories: [],
    immutableUsageActivities: activities,
    threadId,
    ...extra,
  });
}

const pr = {
  provider: "github.com",
  number: 179,
  org: "contrived",
  repo: "project",
  state: "passing",
  checkState: "passing",
  lifecycleState: "open",
  reviewState: "ready_for_review",
  mergeState: "unknown",
  url: "https://github.com/contrived/project/pull/179",
} as PrSummary;

describe("thread usage activity table", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  function openStore(options: { metrics?: boolean } = {}) {
    if (options.metrics) vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-usage-activities-");
    const stateDb = StateDb.open(temp.dbPath);
    cleanups.push(() => removeTempStateDbDir(temp.tempDir));
    cleanups.push(() => stateDb.close());
    return { dbPath: temp.dbPath, stateDb, store: new SqliteOverlayStore(stateDb) };
  }

  const read = async (store: SqliteOverlayStore, threadId: string) =>
    (await store.readThreadUsageActivities({ backend: "codex", threadIds: [threadId] }))[threadId] ?? [];

  /** Two threads with overlay rows: one with no activities, one with a full window. */
  async function seedSmallAndLarge(store: SqliteOverlayStore, stateDb: StateDb) {
    for (const threadId of ["thread-small", "thread-large"]) {
      await store.setThreadReaction({ backend: "codex", emoji: "👀", present: true, threadId });
    }
    for (let index = 0; index < FULL; index += 1) {
      await store.persistThreadUsageActivity({ backend: "codex", threadId: "thread-large", activity: activity(index) });
    }
    // A launched app has finished the one-time move; measure that state.
    await store.moveLegacyThreadUsageActivities();
    stateDb.raw.pragma("wal_checkpoint(TRUNCATE)");
  }

  function payloadBytes(stateDb: StateDb, threadId: string): number {
    return (stateDb.raw.prepare(
      "SELECT octet_length(payload) AS bytes FROM threads WHERE json_extract(payload, '$.threadId') = ?",
    ).get(threadId) as { bytes: number }).bytes;
  }

  const counts = ({ writes }: { writes: { commits: number; rowsChanged: number; statements: number } }) =>
    ({ commits: writes.commits, rowsChanged: writes.rowsChanged, statements: writes.statements });

  it("appends an activity at the same cost on a thread with 0 or 100 activities", async () => {
    const { stateDb, store } = openStore({ metrics: true });
    await seedSmallAndLarge(store, stateDb);

    const append = (threadId: string) => measureSqliteWrites(() =>
      store.persistThreadUsageActivity({ backend: "codex", threadId, activity: activity(FULL) }));
    const small = await append("thread-small");
    const large = await append("thread-large");
    const repeat = await append("thread-large");

    expect(small.result.persisted).toBe(true);
    expect(large.result.persisted).toBe(true);
    expect(counts(large)).toEqual(counts(small));
    // A retained id is a duplicate: nothing is written.
    expect(repeat.result.persisted).toBe(false);
    expect(repeat.writes.rowsChanged).toBe(0);
    expectSqliteWriteBudget({
      note: "one turn-usage activity appended to a thread already holding 100: one ~0.6 KB row and its two index entries, never the overlay row, and equal to the same append on a thread with none. Each one rewrote the thread's 65-115 KB overlay row before",
      scenario: "thread-usage-activity-append-flat",
      writes: large.writes,
    });
    expect(payloadBytes(stateDb, "thread-large")).toBe(payloadBytes(stateDb, "thread-small"));
  });

  it("writes an overlay scalar at the same cost on a thread with 0 or 100 activities", async () => {
    const { stateDb, store } = openStore({ metrics: true });
    await seedSmallAndLarge(store, stateDb);

    const seen = (threadId: string) => measureSqliteWrites(() =>
      store.markThreadSeen({ backend: "codex", threadId, seenUpdatedAt: 5_000 }));
    const small = await seen("thread-small");
    const large = await seen("thread-large");

    expect(counts(large)).toEqual(counts(small));
    expect(payloadBytes(stateDb, "thread-large")).toBeLessThan(1_024);
    expectSqliteWriteBudget({
      note: "one seen-watermark write on a thread holding 100 usage activities: the small overlay row only. It rewrote the 65-115 KB row while the activities lived there",
      scenario: "overlay-scalar-write-with-usage-history",
      writes: large.writes,
    });
  });

  it("parses the same overlay bytes on a thread with 0 or 100 activities", async () => {
    const { stateDb, store } = openStore();
    await seedSmallAndLarge(store, stateDb);
    const parsed: number[] = [];
    const parse = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      parsed.push(text.length);
      return parse(text, reviver);
    });
    const readOverlay = async (threadId: string) => {
      parsed.length = 0;
      await store.getThreadOverlayState({ backend: "codex", threadId });
      return parsed.reduce((total, bytes) => total + bytes, 0);
    };
    const small = await readOverlay("thread-small");
    const large = await readOverlay("thread-large");
    spy.mockRestore();

    expect(large).toBe(small);
    expect(await read(store, "thread-large")).toHaveLength(FULL);
  });

  it("keeps the newest 100, oldest first, trimming in batches", async () => {
    const { stateDb, store } = openStore();
    for (let index = 0; index < FULL + 30; index += 1) {
      await store.persistThreadUsageActivity({ backend: "codex", threadId: "thread-1", activity: activity(index) });
    }
    const stored = await read(store, "thread-1");
    expect(stored.map((entry) => entry.id)).toEqual(
      Array.from({ length: FULL }, (_, index) => activity(index + 30).id),
    );
    // 130 appends crossed the 125-row slack once, back down to 100.
    expect((stateDb.raw.prepare("SELECT count(*) AS n FROM thread_usage_activities").get() as { n: number }).n)
      .toBe(FULL + 4);
    // A trimmed id is no longer retained: it reads as absent and may be re-appended.
    expect(await store.readThreadUsageActivityForTurn({ backend: "codex", threadId: "thread-1", turnId: "turn-0029" }))
      .toBeUndefined();
    expect(await store.readThreadUsageActivityForTurn({ backend: "codex", threadId: "thread-1", turnId: "turn-0030" }))
      .toMatchObject({ id: activity(30).id });
  });

  it("finds a turn's activity from the turn index, not by scanning the thread", async () => {
    const { stateDb, store } = openStore();
    await seedSmallAndLarge(store, stateDb);
    const plan = (stateDb.raw.prepare(`EXPLAIN QUERY PLAN SELECT activity FROM thread_usage_activities
      WHERE thread_id = ? AND turn_id = ? ORDER BY rowid`).all("k", "t") as Array<{ detail: string }>)
      .map((row) => row.detail).join("\n");
    expect(plan).toMatch(/USING INDEX thread_usage_activities_by_turn \(thread_id=\? AND turn_id=\?\)/);
    expect(await store.readThreadUsageActivityForTurn({ backend: "codex", threadId: "thread-large", turnId: "turn-0042" }))
      .toEqual(activity(42));
  });

  it("deletes a forgotten thread's activities with it", async () => {
    const { stateDb, store } = openStore();
    await seedSmallAndLarge(store, stateDb);
    await store.forgetThreadArchiveStates([{ backend: "codex", threadId: "thread-large" }]);
    expect((stateDb.raw.prepare("SELECT count(*) AS n FROM thread_usage_activities").get() as { n: number }).n).toBe(0);
  });

  describe("older writers", () => {
    it.each([false, true])("capture a whole-payload write's activities (recursive_triggers %s)", async (recursive) => {
      const { dbPath, store } = openStore();
      await store.persistThreadUsageActivity({ backend: "codex", threadId: "thread-1", activity: activity(1) });
      const storageKey = "codex:thread-1";

      // An older build on the same profile rewrites the whole row from its
      // own copy: a stale copy of a stored activity, one new activity, and a
      // legacy card array, which the card triggers move alongside.
      const older = StateDb.open(dbPath);
      try {
        older.raw.pragma(`recursive_triggers = ${recursive ? "ON" : "OFF"}`);
        older.raw.prepare(`INSERT OR REPLACE INTO threads(thread_id, directory_path, last_seen_at, dismissed_at, snoozed_until, payload)
          VALUES (?, NULL, NULL, NULL, NULL, ?)`).run(storageKey, legacyPayload("thread-1", [
          activity(1, { summary: "Turn usage: stale copy" }),
          activity(2),
        ], {
          subAgents: [{ monitorId: "monitor-1", createdAt: 1, updatedAt: 1, status: "success", task: "Fixture" }],
        }));
        // And then writes a payload with no arrays at all.
        older.raw.prepare("UPDATE threads SET payload = ? WHERE thread_id = ?")
          .run(JSON.stringify({ backend: "codex", executionMode: "full-access", extraLinkedDirectories: [], threadId: "thread-1" }), storageKey);
      } finally {
        older.close();
      }

      expect(await read(store, "thread-1")).toEqual([activity(1), activity(2)]);
      expect(await store.listThreadSubAgents({ backend: "codex", threadId: "thread-1" })).toHaveLength(1);
      const overlay = await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" });
      expect(overlay).toMatchObject({ executionMode: "full-access" });
      expect(overlay).not.toHaveProperty("immutableUsageActivities");
    });
  });

  describe("one-time move of legacy payload arrays", () => {
    /**
     * Rows written before this build's triggers existed, on a profile the
     * move has not finished. Returns a store opened after the seeding.
     */
    function seedLegacyRows(
      stateDb: StateDb,
      rows: Array<{ threadId: string; activities: AppServerThreadActivityEntry[] }>,
    ): SqliteOverlayStore {
      stateDb.raw.prepare("DELETE FROM meta WHERE key = ?").run(THREAD_USAGE_ACTIVITIES_MOVED_META_KEY);
      stateDb.raw.exec(`DROP TRIGGER thread_usage_activities_capture_insert;
        DROP TRIGGER thread_usage_activities_capture_update;`);
      const insert = stateDb.raw.prepare(`INSERT INTO threads(thread_id, directory_path, last_seen_at, dismissed_at, snoozed_until, payload)
        VALUES (?, NULL, NULL, NULL, NULL, ?)`);
      for (const row of rows) {
        insert.run(`codex:${row.threadId}`, legacyPayload(row.threadId, row.activities));
      }
      ensureThreadUsageActivitySchema(stateDb.raw);
      return new SqliteOverlayStore(stateDb);
    }

    const activities = (count: number) => Array.from({ length: count }, (_, index) => activity(index));

    it("moves one thread's array on first touch, before the sweep reaches it", async () => {
      const { stateDb } = openStore();
      const store = seedLegacyRows(stateDb, [
        { threadId: "thread-1", activities: activities(3) },
        { threadId: "thread-2", activities: activities(2) },
      ]);

      const overlay = await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" });
      expect(overlay).not.toHaveProperty("immutableUsageActivities");
      expect(await read(store, "thread-1")).toEqual(activities(3));
      expect(payloadBytes(stateDb, "thread-1")).toBeLessThan(200);
      // A read of the activities moves them too, and an append keeps their order.
      await store.persistThreadUsageActivity({ backend: "codex", threadId: "thread-2", activity: activity(9) });
      expect((await read(store, "thread-2")).map((entry) => entry.id))
        .toEqual([activity(0).id, activity(1).id, activity(9).id]);
    });

    it("keeps a legacy array when a scalar write replaces the row", async () => {
      const { stateDb } = openStore();
      const store = seedLegacyRows(stateDb, [{ threadId: "thread-1", activities: activities(4) }]);
      await store.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "full-access" });
      expect(await read(store, "thread-1")).toEqual(activities(4));
    });

    it("sweeps every row in bounded slices, then never scans again", async () => {
      const { stateDb } = openStore({ metrics: true });
      const store = seedLegacyRows(stateDb, Array.from({ length: 12 }, (_, index) => ({
        threadId: `thread-${index}`,
        activities: activities(40),
      })));
      stateDb.raw.pragma("wal_checkpoint(TRUNCATE)");

      const yields: number[] = [];
      const { result, writes } = await measureSqliteWrites(() => store.moveLegacyThreadUsageActivities({
        // About three rows of ~24 KB per slice.
        byteBudget: 72 * 1024,
        yieldBetweenSlices: async () => {
          yields.push(Date.now());
        },
      }));
      expect(result.slices).toBeGreaterThan(3);
      expect(yields).toHaveLength(result.slices - 1);
      expect(stateDb.getMeta(THREAD_USAGE_ACTIVITIES_MOVED_META_KEY)).toBe("1");
      expect((stateDb.raw.prepare(
        "SELECT count(*) AS n FROM threads WHERE json_type(payload, '$.immutableUsageActivities') IS NOT NULL",
      ).get() as { n: number }).n).toBe(0);
      expect((stateDb.raw.prepare("SELECT count(*) AS n FROM thread_usage_activities").get() as { n: number }).n).toBe(480);
      expectSqliteWriteBudget({
        note: "one-time move of 12 legacy payloads holding 40 usage activities each, in 72 KB slices: one commit per slice, the last one setting the marker. Runs once per profile; a production copy holds 10.6 MB of activities across 2,482 rows",
        scenario: "thread-usage-activities-move",
        writes,
      });

      const repeat = await measureSqliteWrites(async () => {
        await store.moveLegacyThreadUsageActivities();
        // A fresh store on the same profile trusts the marker too.
        await new SqliteOverlayStore(stateDb).moveLegacyThreadUsageActivities();
        await store.getThreadOverlayState({ backend: "codex", threadId: "thread-0" });
        await read(store, "thread-0");
      });
      expectSqliteWriteBudget({
        note: "the usage-activity move and reads after it on a profile already marked moved: no writes",
        scenario: "thread-usage-activities-move-repeat",
        writes: repeat.writes,
      });
      expect(repeat.writes.commits).toBe(0);
    });

    it("marks a profile with no overlay rows moved when the schema step runs", () => {
      const { stateDb } = openStore();
      expect(stateDb.getMeta(THREAD_USAGE_ACTIVITIES_MOVED_META_KEY)).toBe("1");
    });
  });

  describe("unchanged re-assertions", () => {
    const thread = { backend: "codex" as const, threadId: "thread-1" };

    async function seedThread(store: SqliteOverlayStore, stateDb: StateDb) {
      await store.setThreadModelSettings({ ...thread, model: "fixture-model", reasoningEffort: "high", fastMode: false });
      await store.setThreadExecutionMode({ ...thread, executionMode: "full-access", updatedAt: 1_000 });
      await store.markThreadSeen({ ...thread, seenAt: 1_000_000, seenUpdatedAt: 900 });
      await store.setThreadPullRequests({ ...thread, prs: [pr], fetchedAt: 1_000_000, refreshKey: "fixture-key" });
      stateDb.raw.pragma("wal_checkpoint(TRUNCATE)");
    }

    it("write nothing", async () => {
      const { stateDb, store } = openStore({ metrics: true });
      await seedThread(store, stateDb);

      const modelSettings = await measureSqliteWrites(() =>
        store.setThreadModelSettings({ ...thread, model: "fixture-model", reasoningEffort: "high", fastMode: false }));
      const executionMode = await measureSqliteWrites(() =>
        store.setThreadExecutionMode({ ...thread, executionMode: "full-access" }));
      const seen = await measureSqliteWrites(() =>
        store.markThreadSeen({ ...thread, seenAt: 1_060_000, seenUpdatedAt: 900 }));
      const pullRequests = await measureSqliteWrites(() =>
        store.setThreadPullRequests({ ...thread, prs: [pr], fetchedAt: 1_060_000, refreshKey: "fixture-key" }));

      expectSqliteWriteBudget({
        note: "a turn start re-asserting the thread's model, effort and fast mode: no writes. It rewrote the whole overlay row every turn",
        scenario: "thread-model-settings-unchanged",
        writes: modelSettings.writes,
      });
      expectSqliteWriteBudget({
        note: "a turn start re-asserting a Codex thread's execution mode: no writes. Only ACP threads read the mode's timestamp",
        scenario: "thread-execution-mode-unchanged",
        writes: executionMode.writes,
      });
      expectSqliteWriteBudget({
        note: "re-marking an unchanged seen watermark a minute later: no writes. lastSeenAt refreshes at most every five minutes",
        scenario: "thread-seen-unchanged",
        writes: seen.writes,
      });
      expectSqliteWriteBudget({
        note: "a PR lookup that found the stored list a minute later: no writes. prsFetchedAt refreshes at most every five minutes",
        scenario: "thread-pull-requests-unchanged",
        writes: pullRequests.writes,
      });
      const overlay = await store.getThreadOverlayState(thread);
      expect(overlay).toMatchObject({
        model: "fixture-model",
        executionMode: "full-access",
        executionModeUpdatedAt: 1_000,
        lastSeenAt: 1_000_000,
        prsFetchedAt: 1_000_000,
      });
    });

    it("still write a changed value or a stale stamp", async () => {
      const { stateDb, store } = openStore({ metrics: true });
      await seedThread(store, stateDb);
      const commits = async (write: () => Promise<unknown>) => (await measureSqliteWrites(write)).writes.commits;

      expect(await commits(() => store.setThreadModelSettings({ ...thread, model: "fixture-model", reasoningEffort: "low", fastMode: false }))).toBe(1);
      expect(await commits(() => store.setThreadModelSettings({ ...thread, model: "fixture-model", reasoningEffort: "low", fastMode: false, modelMigrationRevision: "r2" }))).toBe(1);
      expect(await commits(() => store.setThreadExecutionMode({ ...thread, executionMode: "default" }))).toBe(1);
      expect(await commits(() => store.markThreadSeen({ ...thread, seenAt: 1_070_000, seenUpdatedAt: 950 }))).toBe(1);
      expect(await commits(() => store.markThreadSeen({ ...thread, seenAt: 1_070_000 + 5 * 60_000, seenUpdatedAt: 950 }))).toBe(1);
      expect(await commits(() => store.setThreadPullRequests({ ...thread, prs: [], fetchedAt: 1_070_000, refreshKey: "fixture-key" }))).toBe(1);
      expect(await commits(() => store.setThreadPullRequests({ ...thread, prs: [], fetchedAt: 1_080_000, refreshKey: "other-key" }))).toBe(1);
      expect(await commits(() => store.setThreadPullRequests({ ...thread, prs: [], fetchedAt: 1_080_000 + 5 * 60_000, refreshKey: "other-key" }))).toBe(1);
      // An older observation is still refused.
      expect(await commits(() => store.setThreadPullRequests({ ...thread, prs: [pr], fetchedAt: 1_000, refreshKey: "other-key" }))).toBe(0);
    });

    it("rewrite an ACP thread's mode when its timestamp moves", async () => {
      const { store } = openStore();
      const acp = { backend: "acp:kimi" as const, threadId: "session-1" };
      await store.setThreadExecutionMode({ ...acp, executionMode: "full-access", updatedAt: 1_000 });
      await store.setThreadExecutionMode({ ...acp, executionMode: "full-access", updatedAt: 1_000 });
      expect((await store.getThreadOverlayState(acp))?.executionModeUpdatedAt).toBe(1_000);
      await store.setThreadExecutionMode({ ...acp, executionMode: "full-access", updatedAt: 2_000 });
      expect((await store.getThreadOverlayState(acp))?.executionModeUpdatedAt).toBe(2_000);
    });

    it("create the row for a thread with none", async () => {
      const { store } = openStore();
      await store.markThreadSeen({ ...thread, seenAt: 1_000 });
      expect(await store.getThreadOverlayState(thread)).toMatchObject({ lastSeenAt: 1_000 });
      await store.setThreadExecutionMode({ backend: "codex", threadId: "thread-2", executionMode: "default" });
      expect(await store.getThreadOverlayState({ backend: "codex", threadId: "thread-2" }))
        .toMatchObject({ executionMode: "default" });
    });
  });

  describe("narrow reads", () => {
    it("read the live-usage scalars without parsing the overlay row", async () => {
      const { stateDb, store } = openStore();
      const thread = { backend: "codex" as const, threadId: "thread-1" };
      await store.setThreadModelSettings({ ...thread, model: "fixture-model", reasoningEffort: "high", serviceTier: "flex", fastMode: true });
      await store.setThreadForkOrigin({ ...thread, forkSourceThreadId: "source", forkBaselineCaptured: false });
      stateDb.raw.prepare("UPDATE threads SET payload = json_set(payload, '$.managedReviewEntries', json(?))")
        .run(JSON.stringify([{ text: "contrived review ".repeat(2_000) }]));
      const parse = vi.spyOn(JSON, "parse");

      expect(await store.readThreadUsageSettings(thread)).toEqual({
        model: "fixture-model",
        reasoningEffort: "high",
        serviceTier: "flex",
        fastMode: true,
        forkSourceThreadId: "source",
        forkBaselineCaptured: false,
      });
      expect(parse).not.toHaveBeenCalled();
      parse.mockRestore();
      expect(await store.readThreadUsageSettings({ backend: "codex", threadId: "missing" })).toBeUndefined();
    });

    it("reconcile navigation without parsing review bodies, and keep them through a rewrite", async () => {
      const { stateDb, store } = openStore();
      const review = "contrived review ".repeat(4_000);
      const summary = (overrides: Partial<AppServerThreadSummary> = {}): AppServerThreadSummary => ({
        id: "thread-1", title: "Renamed agent", titleSource: "explicit", linkedDirectories: [],
        source: "codex", updatedAt: 1_000, ...overrides,
      });
      await store.reconcileNavigationSnapshot({ backend: "codex", fetchedAt: 1_000, threads: [summary()] });
      stateDb.raw.prepare(`UPDATE threads SET payload = json_set(payload,
          '$.agent', json(?), '$.managedReviewEntries', json(?), '$.detachedPrs', json(?))`)
        .run(
          JSON.stringify({ name: "Old agent", instructions: "Be brief.", createdAt: 1, updatedAt: 1 }),
          JSON.stringify([{ text: review }]),
          JSON.stringify([pr]),
        );
      const parsedBytes: number[] = [];
      const parse = JSON.parse;
      const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
        parsedBytes.push(text.length);
        return parse(text, reviver);
      });

      const snapshot = await store.reconcileNavigationSnapshot({ backend: "codex", fetchedAt: 2_000, threads: [summary()] });
      const steady = parsedBytes.length;
      await store.reconcileNavigationSnapshot({ backend: "codex", fetchedAt: 3_000, threads: [summary()] });
      spy.mockRestore();

      expect(snapshot.threads[0]?.agent?.name).toBe("Renamed agent");
      // The rename re-read the full row once to write it; the next snapshot
      // parses only the narrowed row.
      expect(parsedBytes.slice(steady).every((bytes) => bytes < review.length)).toBe(true);
      const stored = await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" });
      expect(stored?.agent?.name).toBe("Renamed agent");
      expect(stored?.managedReviewEntries).toEqual([{ text: review }]);
      expect(stored?.detachedPrs).toEqual([pr]);
    });
  });
});
