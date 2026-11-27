import * as pricingDisplay from "@pwragent/shared/thread-pricing-display";
import { DESKTOP_SPEND_ALERT_POLICY_DEFAULT } from "@pwragent/shared/contracts/settings";
import { readThreadForPeer } from "../federation/federation-owner-thread-reads";
import { LiveGatePricingLines, LivePricingLines } from "../app-server/live-pricing-lines";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { estimateTokenUsageCost } from "@pwragent/shared/token-usage-pricing";
import type { ThreadSubAgentSummary } from "@pwragent/shared/contracts/navigation";
import type {
  ThreadDisplayRead,
  ThreadToolAccounting,
  ThreadToolInvocationRecord,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { SqliteTokenMiserStorage } from "../storage/token-miser-storage-sqlite";
import type { TokenMiserObjectMetadata } from "../token-miser/token-miser-types";
import { countPricingRows as countTurnPricingReads } from "./pricing-read-counts";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { TestTokenMiserStore } from "./token-miser-test-store";

// Thread reads price every Token Miser gate. A packaged profile showed that
// work scanning the whole pricing ledger and re-sorting every tool invocation
// once per gate, and building card text that the totals discard. These tests
// drive the production read, persist, and live-replay paths with a contrived
// workload of G gates, P usage lines, and I invocations, and count the record
// properties each path reads. A count is a pure function of the code path, so
// a budget can be exact about scaling without measuring time.

const THREAD_ID = "thread-scale";
const GATE_MODEL = "gpt-5.6-luna";
const PARENT_MODELS = ["gpt-5.6-terra", "gpt-6-astra"] as const;
const VARIANTS = 8;

type Workload = {
  entries: TokenMiserObjectMetadata[];
  invocations: ThreadToolInvocationRecord[];
  liveLines: ThreadUsageLineRecord[];
  persistedLines: ThreadUsageLineRecord[];
};

/** The usage ledger's private state and steps this test drives. */
type Internals = {
  liveTokenMiserUsageLines: Map<string, Map<string, ThreadUsageLineRecord>>;
  liveTokenMiserSubAgents: Map<string, Map<string, ThreadSubAgentSummary>>;
  withTokenMiserAccounting(params: {
    accounting: ThreadToolAccounting;
    backend: "codex";
    threadId: string;
  }): Promise<ThreadToolAccounting>;
  persistTokenMiserLedgerEntries(
    entries: readonly TokenMiserObjectMetadata[],
  ): Promise<void>;
  publishLiveTokenMiserReplayEntries(
    entries: readonly TokenMiserObjectMetadata[],
  ): Promise<void>;
};

/** Materialized ledger, card and metadata rows, including statements reused after warm-up. */
function countPricingRows(db: StateDb) {
  let count = 0;
  const prepare = db.raw.prepare.bind(db.raw);
  vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const stmt = prepare(sql);
    if (/SELECT/i.test(sql) && /thread_usage_lines|thread_sub_agents|token_miser_objects/.test(sql)) {
      for (const method of ["all", "get"] as const) {
        const read = stmt[method].bind(stmt);
        Object.assign(stmt, { [method]: (...args: unknown[]) => {
          const value = read(...args);
          for (const row of Array.isArray(value) ? value : [value]) {
            if (row && typeof row === "object" && ("usage_line_id" in row || "card" in row || "payload" in row)) count++;
          }
          return value;
        } });
      }
    }
    return stmt;
  });
  return { count: () => count, reset: () => { count = 0; } };
}

describe("Token Miser savings scaling", () => {
  let directory: string;
  let stateDb: StateDb;
  let store: SqliteOverlayStore;
  let registry: DesktopBackendRegistry;
  let internals: Internals;
  let tokenMiserStore: TestTokenMiserStore;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-token-miser-scale-"));
    stateDb = openInMemoryStateDb();
    store = new SqliteOverlayStore(stateDb);
    registry = createDesktopBackendRegistry({
      codexClient: {
        close: async () => {},
        getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [],
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
      } as never,
      overlayStore: store,
      // The spend-publication tests exercise the alert's live gate adjustments.
      resolveSpendAlertPolicy: () => ({
        ...DESKTOP_SPEND_ALERT_POLICY_DEFAULT,
        threadSpendEnabled: true,
      }),
    });
    internals = registryModules(registry).threadUsageLedger as unknown as Internals;
    tokenMiserStore = new TestTokenMiserStore(
      path.join(directory, "token-miser"),
    );
    (registry as unknown as { tokenMiserStore?: TestTokenMiserStore }).tokenMiserStore = tokenMiserStore;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await registry.close();
    } finally {
      stateDb.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refreshes a grouped Codex Pricing page from changed rows and keeps the owner's full-ledger ordering and spend", async () => {
    const thread = { backend: "codex", threadId: THREAD_ID } as const;
    const request = { ...thread, includeTurns: false, viewOnly: true, display: { resource: "pricing", limit: 2, deferPricingGates: true } } as const;
    const rowsRead = countPricingRows(stateDb);
    const metadataRead = countPricingRows(tokenMiserStore.stateDb);
    const entries = buildWorkload(1).entries.slice(0, 4).map((entry, i) => ({
      ...entry, turnId: i < 2 ? "turn-0" : "orphan", parentModel: PARENT_MODELS[0],
      baselineParentTokens: i % 2 ? 3_000 : 5_000_000, replayTrackingVersion: 2 as const,
    }));
    const write = tokenMiserStore.stateDb.raw.prepare(`INSERT INTO token_miser_objects(object_id, thread_id, created_at, payload)
      VALUES (?, ?, ?, ?) ON CONFLICT(object_id) DO UPDATE SET payload = excluded.payload`);
    const persist = (entry: TokenMiserObjectMetadata) => write.run(entry.objectId, THREAD_ID, entry.createdAt, JSON.stringify(entry));
    for (const entry of entries) persist(entry);
    for (let i = 0; i < 8; i++) {
      const line = parentLine({ id: String(i), turnId: "turn-" + i, model: PARENT_MODELS[0] });
      // A helper thread can itself dispatch helpers. Two billing identities
      // then tie on provider and currency; the newest raw line breaks the tie.
      await store.upsertThreadUsageLine({ line: { ...line, parentThreadId: "outer-thread",
        priceStatus: "priced", createdAt: line.createdAt + i * 100 } });
    }
    await internals.persistTokenMiserLedgerEntries(entries);
    await internals.publishLiveTokenMiserReplayEntries(entries);

    const folds = vi.spyOn(pricingDisplay.PricingRunningTotals.prototype, "add");
    const grouped = vi.spyOn(pricingDisplay, "isTokenMiserGateLine");
    const read = async (peer: boolean, display: ThreadDisplayRead = request.display) =>
      (await (peer ? readThreadForPeer(registry, { ...request, display }) : registry.readThread({ ...request, display }))).display!;
    const oracle = async (display: ThreadDisplayRead) => {
      const full = vi.spyOn(store, "readThreadPricingPage").mockResolvedValue(undefined);
      const fresh = new SqliteOverlayStore(stateDb);
      const ledger = vi.spyOn(store, "readThreadPricing").mockImplementation((params) => fresh.readThreadPricing(params));
      try { return (await read(false, display)).pricingPage; } finally { ledger.mockRestore(); full.mockRestore(); }
    };
    const check = async (peer: boolean, rows: number, groupVisits: number, folded: number, objects = 0) => {
      rowsRead.reset();
      metadataRead.reset();
      folds.mockClear();
      grouped.mockClear();
      const result = await read(peer);
      expect([rowsRead.count(), grouped.mock.calls.length, folds.mock.calls.length, metadataRead.count()])
        .toEqual([rows, groupVisits, folded, objects]);
      expect(result.pricingPage).toEqual(await oracle(request.display));
      return result;
    };
    await read(false);
    const turnId = "later";
    vi.spyOn(Date, "now").mockReturnValue(entries[0]!.createdAt + 10000);
    await registry.publishLocalEvent({ ...thread, notification: { method: "turn/started",
      params: { threadId: THREAD_ID, turnId, turn: { id: turnId, status: "inProgress" } } } });
    const tokens = { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 20, totalTokens: 1020 };
    await registry.publishLocalEvent({ ...thread, notification: { method: "thread/tokenUsage/updated",
      params: { threadId: THREAD_ID, turnId, model: PARENT_MODELS[0], tokenUsage: { last: tokens, total: tokens } } } });
    await registry.publishLocalEvent({ ...thread, notification: { method: "turn/completed",
      params: { threadId: THREAD_ID, turnId, turn: { id: turnId, status: "completed", output: [] } } } });
    const first = await check(false, 1, 1, 1);
    await check(true, 0, 0, 0);
    await internals.publishLiveTokenMiserReplayEntries(entries);
    expect((await check(true, 0, 0, 0)).nextCursor).toBe(first.nextCursor);
    await read(true, { ...request.display, cursor: first.nextCursor });

    const all = { ...request.display, limit: 50, deferPricingGates: false };
    const expanded = (await read(true, all)).pricingPage!;
    expect(expanded).toEqual(await oracle(all));
    const parent = expanded.rows.find((row) => row.line.turnId === "turn-0")!;
    expect(parent.gates).toHaveLength(2);
    expect(expanded.rows.some((row) => row.orphan)).toBe(true);
    for (const filter of ["primary", "small"] as const) {
      const selection = { ...request.display, pricingGateGroup: { usageLineId: parent.line.usageLineId, filter } };
      const selected = (await read(true, selection)).pricingPage!;
      expect(selected).toEqual(await oracle(selection));
      expect(selected.totalRows).toBe(1);
    }

    const reassigned = { ...entries[0]!, turnId };
    persist(reassigned);
    await internals.publishLiveTokenMiserReplayEntries([reassigned]);
    await check(false, 1, 2, 0, 1);
    await expect(read(true, { ...request.display, cursor: first.nextCursor })).rejects.toThrow("Thread display history changed");

    // The stored helper price still owns the savings equation while the live
    // replacement owns the displayed spend and every newer row's running total.
    const live = internals.liveTokenMiserUsageLines.get(THREAD_ID)!;
    const original = [...live.values()][0]!;
    live.set(original.usageLineId, { ...original, totalCostMicros: original.totalCostMicros + 10001, outputTokens: original.outputTokens + 100 });
    await check(true, 1, 2, 0);
    expect((await read(false, all)).pricingPage).toEqual(await oracle(all));
  });

  it.each([false, true])("refolds only the gate and its completing parent (parent already displayed: %s)", async (pending) => {
    const thread = { backend: "codex", threadId: THREAD_ID } as const;
    const request = { ...thread, includeTurns: false, viewOnly: true, display: { resource: "pricing", limit: 4 } } as const;
    const parent = (i: number) => ({
      ...parentLine({ id: String(i), turnId: "turn-" + i, model: PARENT_MODELS[0] }),
      priceStatus: "priced" as const, createdAt: 1_800_000_000_000 + i * 100,
    });
    const active = parent(24);
    await store.upsertThreadUsageLines({ lines: Array.from({ length: pending ? 25 : 24 }, (_, i) => parent(i)) });
    await registry.readThread(request);
    const entry = { ...buildWorkload(1).entries[0]!, turnId: active.turnId!, createdAt: active.createdAt + 10 };
    await internals.publishLiveTokenMiserReplayEntries([entry]);
    await readThreadForPeer(registry, request);
    // The gate can be repriced in place before the parent settles.
    const live = internals.liveTokenMiserUsageLines.get(THREAD_ID)!;
    const gate = [...live.values()][0]!;
    live.set(gate.usageLineId, { ...gate, totalCostMicros: gate.totalCostMicros + 100, outputTokens: gate.outputTokens + 100 });
    const correction = vi.spyOn(pricingDisplay.PricingRunningTotals.prototype, "add");
    await registry.readThread(request);
    expect(correction).not.toHaveBeenCalled();
    correction.mockRestore();
    await store.upsertThreadUsageLine({ line: { ...active, completedAt: active.createdAt + 100, outputTokens: 250 } });
    const folds = vi.spyOn(pricingDisplay.PricingRunningTotals.prototype, "add");
    const warm = (await readThreadForPeer(registry, request)).display!.pricingPage;
    expect(folds).toHaveBeenCalledTimes(2);
    vi.spyOn(store, "readThreadPricingPage").mockResolvedValue(undefined);
    expect(warm).toEqual((await registry.readThread(request)).display!.pricingPage);
  });

  it("keeps a cursor issued after retiring a stored policy card across eviction", async () => {
    const thread = { backend: "codex", threadId: THREAD_ID } as const;
    const request = { ...thread, includeTurns: false, viewOnly: true, display: { resource: "pricing", limit: 1 } } as const;
    const entry = buildWorkload(1).entries[2]!;
    for (const id of ["first", "second"]) {
      await store.upsertThreadUsageLine({ line: parentLine({ id, turnId: id, model: PARENT_MODELS[0] }) });
    }
    await internals.publishLiveTokenMiserReplayEntries([entry]);
    await registry.readThread(request);
    await internals.persistTokenMiserLedgerEntries([entry]);
    internals.liveTokenMiserSubAgents.delete(THREAD_ID);
    const cursor = (await registry.readThread(request)).display!.nextCursor;
    expect(cursor).toBeTruthy();
    const next = { ...request, display: { ...request.display, cursor } };
    const expected = (await registry.readThread(next)).display;
    for (let i = 0; i < 8; i++) await store.readThreadPricingPage({ ...thread, threadId: "other-" + i, offset: 0, limit: 1 });
    expect((await readThreadForPeer(registry, next)).display).toEqual(expected);
  });

  it("reconciles observation membership with point reads after the initial baseline", () => {
    const db = tokenMiserStore.stateDb.raw;
    let scans = 0;
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const stmt = prepare(sql);
      if (/^SELECT.*FROM token_miser_observations/i.test(sql.trim()) && !/observation_id\s*=/.test(sql)) {
        for (const method of ["get", "all"] as const) {
          const read = stmt[method].bind(stmt);
          Object.assign(stmt, { [method]: (...args: unknown[]) => { scans++; return read(...args); } });
        }
      }
      return stmt;
    });
    const insert = db.prepare("INSERT INTO token_miser_observations(observation_id, thread_id, created_at, payload) VALUES (?, ?, 10, '{}')");
    const watch = tokenMiserStore.watchPricingMetadata(THREAD_ID, () => {})!;
    try {
      watch.dataVersion();
      insert.run("a", THREAD_ID);
      expect(watch.observationCount()).toBe(1);
      scans = 0;
      insert.run("b", THREAD_ID);
      expect(watch.observationCount()).toBe(2);
      db.prepare("UPDATE token_miser_observations SET created_at = 20 WHERE observation_id = 'b'").run();
      expect(watch.observationCount()).toBe(2);
      db.exec("BEGIN");
      insert.run("rolled-back", THREAD_ID);
      db.exec("ROLLBACK");
      db.prepare("UPDATE token_miser_observations SET thread_id = 'elsewhere' WHERE observation_id = 'a'").run();
      expect(watch.observationCount()).toBe(1);
      db.prepare("DELETE FROM token_miser_observations WHERE observation_id = 'b'").run();
      expect(watch.observationCount()).toBe(0);
      // REPLACE reports an implicit delete even with SQLite recursive triggers off.
      const replace = db.prepare("INSERT OR REPLACE INTO token_miser_observations(observation_id, thread_id, created_at, payload) VALUES ('a', ?, 30, '{}')");
      replace.run(THREAD_ID);
      expect(watch.observationCount()).toBe(1);
      replace.run("elsewhere");
      expect(watch.observationCount()).toBe(0);
      expect(scans).toBe(0);
    } finally { watch.close(); }
  });

  it("updates legacy replay decisions and focused helper charges on the open page", async () => {
    const thread = { backend: "codex", threadId: THREAD_ID } as const;
    const work = buildWorkload(1);
    const entry = { ...work.entries[1]!, replayTrackingVersion: undefined, parentModel: PARENT_MODELS[0] };
    tokenMiserStore.stateDb.raw.prepare("INSERT INTO token_miser_objects(object_id, thread_id, created_at, payload) VALUES (?, ?, ?, ?)")
      .run(entry.objectId, THREAD_ID, entry.createdAt, JSON.stringify(entry));
    await internals.persistTokenMiserLedgerEntries([entry]);
    const line = gateLine({ monitorId: "system:token-miser-focused:request", index: 10, inputTokens: 500 });
    await store.upsertThreadUsageLine({ line });
    const request = { ...thread, includeTurns: false, viewOnly: true, display: { resource: "pricing" } } as const;
    const check = async () => {
      const page = (await readThreadForPeer(registry, request)).display!.pricingPage!;
      const full = vi.spyOn(store, "readThreadPricingPage").mockResolvedValue(undefined);
      try { expect(page).toEqual((await registry.readThread(request)).display!.pricingPage); } finally { full.mockRestore(); }
      return page.tokenMiserSummary!;
    };
    const initial = await check();
    for (const call of work.invocations.filter((row) => row.turnId === entry.turnId)) {
      await store.upsertThreadToolInvocation({ invocation: call });
    }
    const replayed = await check();
    stateDb.raw.prepare("UPDATE thread_usage_lines SET total_cost_micros = total_cost_micros + 1234 WHERE usage_line_id = ?").run(line.usageLineId);
    expect((await check()).terms!.gateCostMicros).toBe(replayed.terms!.gateCostMicros + 1234);
    expect(initial.decisionCount).toBe(1);
  });

  async function readSavings(
    work: Workload,
    counter: ReadCounter = new ReadCounter(),
  ) {
    const lines = counter.wrap("pricing", work.persistedLines);
    vi.spyOn(store, "readThreadPricing").mockResolvedValue({ lines, summaries: [] });
    vi.spyOn(tokenMiserStore, "listMetadata").mockResolvedValue(work.entries);
    internals.liveTokenMiserUsageLines.set(
      THREAD_ID,
      new Map(counter.wrap("pricing", work.liveLines).map((line) => [line.usageLineId, line])),
    );
    const accounting = await store.readThreadToolAccounting({
      backend: "codex",
      threadId: THREAD_ID,
    });
    return internals.withTokenMiserAccounting({
      accounting: {
        ...accounting,
        invocations: counter.wrap("invocations", work.invocations),
      },
      backend: "codex",
      threadId: THREAD_ID,
    });
  }

  it("reads a completed transcript turn without visiting live monitor prices", async () => {
    const counter = new ReadCounter();
    const gate = gateLine({ monitorId: "active-gate", index: 0, inputTokens: 1000, live: true });
    internals.liveTokenMiserUsageLines.set(THREAD_ID, new LivePricingLines([[gate.usageLineId, counter.wrap("pricing", [gate])[0]!]]));
    counter.reads.pricing = 0;
    const turn = { id: "parent-turn", status: "completed" as const, completedAt: 1_800_000_100_000 };
    await store.upsertThreadUsageLine({ line: parentLine({ id: turn.id, turnId: turn.id }) });
    const display = await registry.readThread({
      backend: "codex", threadId: THREAD_ID, includeTurns: false, viewOnly: true,
      display: { resource: "accounting", turns: [turn] },
    });
    expect(display.replay.entries.map((entry) => entry.turn?.id)).toEqual([turn.id]);
    expect(counter.reads.pricing).toBe(0);
  });

  it("completes a cold owner turn without rebuilding history and loads only gates whose replay advances", async () => {
    const thread = { backend: "codex", threadId: THREAD_ID } as const;
    const model = PARENT_MODELS[0];
    const tokens = { inputTokens: 100, cachedInputTokens: 10, outputTokens: 5, totalTokens: 105 };
    const persisted = new SqliteTokenMiserStorage(tokenMiserStore.stateDb);
    const entries = buildWorkload(1).entries.map((entry, i) => ({
      ...entry, objectId: "00000000-0000-4000-8000-" + String(i).padStart(12, "0"),
      parentModel: model, replayTrackingVersion: 2 as const, parentRequestsObservedAfterGate: 2,
      ...(i >= 2 ? { replayTrackingStoppedAt: entry.createdAt + 1 } : {}),
    }));
    for (const entry of entries) persisted.writeMetadata(entry);
    await store.upsertThreadUsageLines({ lines: entries.map((entry, i) => ({
      ...parentLine({ id: String(i), turnId: entry.turnId, model }), priceStatus: "priced", totalCostMicros: 10,
    })) });
    await internals.persistTokenMiserLedgerEntries(entries);
    await internals.publishLiveTokenMiserReplayEntries(entries);

    const usageReads = countTurnPricingReads(stateDb);
    const replayReads = countTurnPricingReads(tokenMiserStore.stateDb);
    const published: string[][] = [];
    registry.onEvent(({ notification }) => {
      if (notification.method === "thread/pricing/updated") {
        const pricing = notification.params.pricing as { lines: ThreadUsageLineRecord[] };
        published.push(pricing.lines.map(line => line.turnId ?? ""));
      }
    });
    const turnId = "next";
    await registry.publishLocalEvent({ backend: thread.backend, notification: { method: "turn/started",
      params: { threadId: THREAD_ID, turnId, turn: { id: turnId, status: "inProgress" } } } });
    await registry.publishLocalEvent({ backend: thread.backend, notification: { method: "thread/tokenUsage/updated",
      params: { threadId: THREAD_ID, turnId, model, tokenUsage: { last: tokens, total: tokens } } } });
    await registry.publishLocalEvent({ backend: thread.backend, notification: { method: "turn/completed",
      params: { threadId: THREAD_ID, turnId, turn: { id: turnId, status: "completed", output: [] } } } });

    expect(published).toEqual([[turnId]]);
    expect(usageReads.usageRows).toBeLessThanOrEqual(2);
    expect(replayReads).toMatchObject({ metadataRows: 2, metadataKeys: 2, payloadQueries: 1 });
    await tokenMiserStore.flushAll();
    for (const [i, entry] of entries.entries()) {
      const actual = persisted.readMetadata(entry.objectId) as TokenMiserObjectMetadata;
      expect(actual.parentRequestsObservedAfterGate).toBe(i < 2 ? 3 : 2);
      expect(actual.cachedReplayCount ?? 0).toBe((entry.cachedReplayCount ?? 0) + Number(i < 2));
    }
  });

  it("probes only changed gate IDs as spend publications accumulate", async () => {
    const live = new LiveGatePricingLines();
    internals.liveTokenMiserUsageLines.set(THREAD_ID, live);
    const lookup = vi.spyOn(store as unknown as { readThreadUsageLineSync(id: string): unknown }, "readThreadUsageLineSync");
    const ledger = registryModules(registry).threadUsageLedger;
    for (let i = 0; i < 8; i++) {
      const line = gateLine({ index: i, inputTokens: 100, monitorId: `gate-${i}`, live: true });
      live.set(line.usageLineId, line);
      await ledger.emitThreadPricingUpdated({ backend: "codex", threadId: THREAD_ID });
    }
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(8);
    lookup.mockClear();
    await ledger.emitThreadPricingUpdated({ backend: "codex", threadId: THREAD_ID });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps the gate adjustment equal to full spend across storage, replacement and retirement", async () => {
    const thread = { backend: "codex", threadId: THREAD_ID } as const;
    const live = new LiveGatePricingLines();
    internals.liveTokenMiserUsageLines.set(THREAD_ID, live);
    const spend = vi.spyOn(store, "readThreadSpendMicros");
    const ledger = registryModules(registry).threadUsageLedger;
    const check = async () => {
      spend.mockClear();
      await ledger.emitThreadPricingUpdated(thread);
      const full = await ledger.readThreadPricingWithLiveTokenMiser(thread);
      const expected = full.lines.reduce((sum, line) => sum + line.totalCostMicros, 0);
      const request = { ...thread, liveGates: live, localModelIds: [], liveLines: [] };
      const alerted = await spend.mock.results[0]?.value;
      if (alerted === null) expect(expected).toBeLessThan(25_000_000);
      else expect(alerted).toBe(expected);
      expect(await store.readThreadSpendMicros(request)).toBe(expected);
      expect(await store.readThreadSpendMicros({ ...request, thresholdMicros: expected })).toBe(expected);
    };
    const gate = gateLine({ index: 0, inputTokens: 1000, monitorId: "first", live: true });
    live.set(gate.usageLineId, gate);
    await check();
    await store.upsertThreadUsageLine({ line: { ...gate, status: "pending" } });
    await check();
    stateDb.raw.prepare("UPDATE thread_usage_lines SET total_cost_micros = 7 WHERE usage_line_id = ?").run(gate.usageLineId);
    await check();
    live.set(gate.usageLineId, { ...gate, totalCostMicros: gate.totalCostMicros + 100 });
    await check();
    const extra = gateLine({ index: 1, inputTokens: 100, monitorId: "second", live: true });
    live.set(extra.usageLineId, extra);
    live.delete(gate.usageLineId);
    await check();
    live.clear();
    await check();
    live.set(gate.usageLineId, gate);
    await check();
  });

  it("counts a native child's charge summarized only on its parent before ruling out a spend alert", async () => {
    const hidden = gateLine({ index: 0, inputTokens: 1000, monitorId: "parent-charge" });
    const thread = { backend: "codex" as const, threadId: hidden.threadId };
    const own = { ...parentLine({ ...thread, id: "own", turnId: "own" }), priceStatus: "priced" as const, totalCostMicros: 1 };
    await store.upsertThreadUsageLine({ line: own });
    await store.upsertThreadUsageLine({ line: { ...hidden, provider: "anthropic", pricingBasis: "provider-reported" } });
    const held = { ...own, usageLineId: "held", totalCostMicros: 2 };
    const liveGates = new LiveGatePricingLines();
    liveGates.set(held.usageLineId, held);
    const full = await store.readThreadPricing(thread);
    const expected = full.lines.reduce((sum, row) => sum + row.totalCostMicros, held.totalCostMicros);
    expect(full.lines).toContainEqual(expect.objectContaining({ usageLineId: hidden.usageLineId, totalCostMicros: hidden.totalCostMicros }));
    expect(expected).toBeGreaterThan(full.summaries.reduce((sum, row) => sum + row.totalCostMicros, held.totalCostMicros));
    expect(await store.readThreadSpendMicros({ ...thread, liveGates, liveLines: [], localModelIds: [], thresholdMicros: expected })).toBe(expected);
  });

  it("reconciles live-only turns and replacements as a usage line changes scope", async () => {
    const original = parentLine({ id: "usage", turnId: "first" });
    await store.upsertThreadUsageLine({ line: original });
    const live = new LivePricingLines();
    internals.liveTokenMiserUsageLines.set(THREAD_ID, live);
    const readTurns = async () => {
      const turns = ["first", "second"].map((id) => ({ id, status: "completed" as const, completedAt: original.createdAt + 100 }));
      const display = await registry.readThread({ backend: "codex", threadId: THREAD_ID, includeTurns: false,
        viewOnly: true, display: { resource: "accounting", turns } });
      return display.replay.entries.map((entry) => entry.turn?.id);
    };
    live.set(original.usageLineId, { ...original, turnId: "second" });
    expect(await readTurns()).toEqual(["second"]);
    live.set(original.usageLineId, { ...original, scope: "monitor" });
    expect(await readTurns()).toEqual([]);
    live.delete(original.usageLineId);
    expect(await readTurns()).toEqual(["first"]);
    const extra = parentLine({ id: "live-only", turnId: "second" });
    live.set(extra.usageLineId, extra);
    expect((await readTurns()).sort()).toEqual(["first", "second"]);
    live.clear();
    expect(await readTurns()).toEqual(["first"]);
  });

  it("keeps thread-read savings totals and replay counts identical to the per-gate path", async () => {
    const result = (await readSavings(buildWorkload(2))).tokenMiser!;
    expect(result.savings).toMatchInlineSnapshot(`
      {
        "currency": "USD",
        "directlyObservedReplayCount": 7,
        "gateCostMicros": 4828,
        "gateCount": 16,
        "gateModel": "gpt-5.6-luna",
        "helperDecisionCount": 14,
        "helperPassThroughCount": 2,
        "parentModel": "gpt-5.6-terra",
        "passThroughCount": 4,
        "policyPassThroughCount": 2,
        "pricedGateCount": 12,
        "reconstructedReplayCount": 18,
        "revealedCostMicros": 14566,
        "savingsMicros": 330034,
        "withoutGateCostMicros": 349428,
      }
    `);
    expect(result.cachedReplayCount).toMatchInlineSnapshot(`30`);
    expect(result.interceptions?.map((entry) =>
      `${entry.objectId} ${entry.cachedReplayCount} ${entry.cachedBaselineTokens} ${entry.cachedRevealedTokens}`
    )).toMatchInlineSnapshot(`
      [
        "gate-0000 0 0 0",
        "gate-0001 1 3060 103",
        "gate-0002 7 21840 735",
        "gate-0003 3 9540 360",
        "gate-0004 3 9720 930",
        "gate-0005 0 0 0",
        "gate-0006 2 6720 230",
        "gate-0007 3 10260 300",
        "gate-0008 3 10440 360",
        "gate-0009 1 3540 105",
        "gate-0010 0 0 0",
        "gate-0011 1 3660 120",
        "gate-0012 3 11160 939",
        "gate-0013 1 3780 115",
        "gate-0014 2 7680 200",
        "gate-0015 0 0 0",
      ]
    `);
  });

  it("keeps the first priced parent by either turn id as live rows move or acquire a model", () => {
    const first = parentLine({ id: "first", turnId: "active" });
    const second = parentLine({ id: "second", turnId: "alias", usageTurnId: "active", model: PARENT_MODELS[1] });
    const live = new LivePricingLines([[first.usageLineId, first], [second.usageLineId, second]]);
    const check = () => {
      for (const thread of [THREAD_ID, "other"]) {
        for (const turn of ["active", "alias"]) {
          const expected = [...live.values()].find((line) => line.threadId === thread && line.scope !== "monitor" && line.model
            && (line.turnId === turn || line.usageTurnId === turn));
          expect(live.forParent(thread, turn)).toBe(expected);
        }
      }
    };
    check();
    live.set(first.usageLineId, { ...first, model: PARENT_MODELS[0] });
    check();
    live.set(second.usageLineId, { ...second, threadId: "other" });
    check();
    live.delete(first.usageLineId);
    check();
    live.set(first.usageLineId, { ...first, threadId: "other", model: PARENT_MODELS[0] });
    check();
    live.clear();
    check();
  });

  it("keeps persisted and live gate artifacts identical", async () => {
    const work = buildWorkload(1);
    vi.spyOn(store, "readThreadPricing").mockResolvedValue({
      lines: work.persistedLines,
      summaries: [],
    });
    vi.spyOn(store, "readTokenMiserGatePricingLines").mockResolvedValue(work.persistedLines);
    for (const invocation of work.invocations) await store.upsertThreadToolInvocation({ invocation });
    await internals.persistTokenMiserLedgerEntries(work.entries);
    const subAgents = await store.listThreadSubAgents({ backend: "codex", threadId: THREAD_ID });
    expect(subAgents.map(projectSubAgent)).toMatchSnapshot("persisted sub-agents");

    internals.liveTokenMiserUsageLines.set(
      THREAD_ID,
      new LivePricingLines([...work.persistedLines, ...work.liveLines].map((line) => [line.usageLineId, line])),
    );
    await internals.publishLiveTokenMiserReplayEntries(work.entries);
    expect(
      [...internals.liveTokenMiserSubAgents.get(THREAD_ID)!.values()].map(projectSubAgent),
    ).toMatchSnapshot("live replay sub-agents");
    expect(
      [...internals.liveTokenMiserUsageLines.get(THREAD_ID)!.values()]
        .map((line) => [line.usageLineId, line.totalCostMicros, line.createdAt]),
    ).toMatchSnapshot("live replay usage lines");
  });

  it("skips the invocation read when every persisted gate tracks replays directly", async () => {
    const work = buildWorkload(1);
    const observed = work.entries.filter((entry) => entry.replayTrackingVersion === 2);
    expect(observed.length).toBeGreaterThan(0);
    vi.spyOn(store, "readThreadPricing").mockResolvedValue({
      lines: work.persistedLines,
      summaries: [],
    });
    vi.spyOn(store, "readTokenMiserGatePricingLines").mockResolvedValue(work.persistedLines);
    const readInvocations = vi.spyOn(store, "readThreadToolAccounting");
    const readLegacy = vi.spyOn(store, "readTokenMiserLegacyReplayCounts");
    await internals.persistTokenMiserLedgerEntries(observed);
    expect(readInvocations).not.toHaveBeenCalled();
    expect(readLegacy).not.toHaveBeenCalled();
    const subAgents = await store.listThreadSubAgents({ backend: "codex", threadId: THREAD_ID });
    expect(subAgents.map((subAgent) => subAgent.monitorId).sort()).toEqual(
      observed.map((entry) => `system:token-miser:${entry.objectId}`).sort(),
    );
  });

  it("reads the pricing ledger and invocations a bounded number of times per thread read", async () => {
    const measured = [];
    for (const multiple of [6, 24]) {
      const work = buildWorkload(multiple);
      const counter = new ReadCounter();
      // Spies are restored per sample: re-spying returns the same spy, whose
      // calls would otherwise accumulate across samples.
      const formats = countNumberFormatting();
      const result = await readSavings(work, counter);
      const formatting = formats.calls();
      formats.restore();
      expect(result.tokenMiser?.savings?.gateCount).toBe(work.entries.length);
      measured.push({
        formatting,
        gates: work.entries.length,
        invocationReads: counter.reads.invocations,
        invocations: work.invocations.length,
        lineReads: counter.reads.pricing,
        lines: work.persistedLines.length + work.liveLines.length,
      });
    }
    for (const sample of measured) {
      // Linear budgets: one index pass per record, plus the fields each gate
      // reads from the two lines it resolves. A per-gate scan is G × P.
      expect(sample).toMatchObject({ formatting: 0 });
      expect(sample.lineReads).toBeLessThanOrEqual(
        LINE_READS_PER_LINE * sample.lines + LINE_READS_PER_GATE * sample.gates,
      );
      expect(sample.invocationReads).toBeLessThanOrEqual(
        INVOCATION_READS_PER_INVOCATION * sample.invocations,
      );
    }
    // Four times the workload costs about four times the reads; a per-gate
    // scan costs about sixteen times.
    const [small, large] = measured as [typeof measured[0], typeof measured[0]];
    expect(large.lineReads).toBeLessThanOrEqual(SCALING_LIMIT * small.lineReads);
    expect(large.invocationReads).toBeLessThanOrEqual(
      SCALING_LIMIT * small.invocationReads,
    );
  });

  it("persists and republishes gate cards with linear ledger reads", async () => {
    const measured = [];
    for (const multiple of [6, 24]) {
      const work = buildWorkload(multiple);
      const counter = new ReadCounter();
      const lines = counter.wrap("pricing", work.persistedLines);
      const invocations = counter.wrap("invocations", work.invocations);
      // Count the persist path's own ledger read, here given every line to
      // bound the indexing itself. The pricing publish after the write
      // re-reads and emits the whole ledger once, which is O(P) regardless
      // of how gates are priced.
      vi.spyOn(store, "readTokenMiserGatePricingLines").mockResolvedValueOnce(lines);
      vi.spyOn(store, "readThreadPricing")
        .mockResolvedValue({ lines: work.persistedLines, summaries: [] });
      vi.spyOn(store, "readThreadToolAccounting").mockImplementation(async (params) => ({
        ...await (SqliteOverlayStore.prototype.readThreadToolAccounting.call(store, params)),
        invocations,
      }));
      await internals.persistTokenMiserLedgerEntries(work.entries);
      const persistReads = { ...counter.reads };
      internals.liveTokenMiserUsageLines.set(
        THREAD_ID,
        new LivePricingLines(counter.wrap("pricing", [...work.persistedLines, ...work.liveLines])
          .map((line) => [line.usageLineId, line])),
      );
      counter.reads.pricing = 0;
      await internals.publishLiveTokenMiserReplayEntries(work.entries);
      measured.push({
        gates: work.entries.length,
        invocations: work.invocations.length,
        lines: work.persistedLines.length + work.liveLines.length,
        liveLineReads: counter.reads.pricing,
        persistInvocationReads: persistReads.invocations,
        persistLineReads: persistReads.pricing,
      });
      vi.restoreAllMocks();
      internals.liveTokenMiserSubAgents.clear();
      internals.liveTokenMiserUsageLines.clear();
    }
    for (const sample of measured) {
      const lineBudget =
        LINE_READS_PER_LINE * sample.lines + LINE_READS_PER_GATE * sample.gates;
      expect(sample.persistLineReads).toBeLessThanOrEqual(lineBudget);
      expect(sample.liveLineReads).toBeLessThanOrEqual(lineBudget);
      expect(sample.persistInvocationReads).toBeLessThanOrEqual(
        INVOCATION_READS_PER_INVOCATION * sample.invocations,
      );
    }
    const [small, large] = measured as [typeof measured[0], typeof measured[0]];
    for (const key of ["liveLineReads", "persistInvocationReads", "persistLineReads"] as const) {
      expect(large[key]).toBeLessThanOrEqual(SCALING_LIMIT * small[key]);
    }
  });
});

// Per-record budgets. Indexing reads a few fields of every line and
// invocation once; each gate then reads the fields of the two lines it
// resolved. The per-gate scans read about 15× these budgets at 48 gates.
const LINE_READS_PER_LINE = 6;
const LINE_READS_PER_GATE = 16;
const INVOCATION_READS_PER_INVOCATION = 6;
const SCALING_LIMIT = 4.5;

class ReadCounter {
  readonly reads = { invocations: 0, pricing: 0 };

  wrap<T extends object>(kind: keyof ReadCounter["reads"], records: readonly T[]): T[] {
    const reads = this.reads;
    return records.map((record) => new Proxy(record, {
      get(target, key, receiver) {
        reads[kind] += 1;
        return Reflect.get(target, key, receiver);
      },
    }));
  }
}

/**
 * Counts locale number formatting: the gate card's character counts and the
 * helper usage summary both format through these. Savings totals need none.
 */
function countNumberFormatting(): { calls(): number; restore(): void } {
  const toLocaleString = vi.spyOn(Number.prototype, "toLocaleString");
  const NumberFormat = Intl.NumberFormat;
  let constructed = 0;
  const numberFormat = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (
    this: unknown,
    ...args: ConstructorParameters<typeof Intl.NumberFormat>
  ) {
    constructed += 1;
    return new NumberFormat(...args);
  } as typeof Intl.NumberFormat);
  return {
    calls: () => toLocaleString.mock.calls.length + constructed,
    restore: () => {
      toLocaleString.mockRestore();
      numberFormat.mockRestore();
    },
  };
}

function projectSubAgent(subAgent: ThreadSubAgentSummary) {
  const {
    ownerRegistrySessionId: _ownerRegistrySessionId,
    ownerRuntimeInstanceId: _ownerRuntimeInstanceId,
    ...rest
  } = subAgent;
  return rest;
}

/**
 * `multiple` copies of eight gate variants, each pair of gates sharing a
 * parent turn. P and I grow linearly with G.
 */
function buildWorkload(multiple: number): Workload {
  const entries: TokenMiserObjectMetadata[] = [];
  const persistedLines: ThreadUsageLineRecord[] = [];
  const liveLines: ThreadUsageLineRecord[] = [];
  const invocations: ThreadToolInvocationRecord[] = [];
  let observedAt = 1_800_000_000_000;
  const gateCount = multiple * VARIANTS;

  for (let index = 0; index < gateCount; index += 1) {
    const variant = index % VARIANTS;
    const sharedTurn = `turn-${Math.floor(index / 2)}`;
    const turnId = variant === 6
      ? `orphan-turn-${index}`
      : variant === 7
        ? `stamped-turn-${index}`
        : sharedTurn;
    const objectId = `gate-${String(index).padStart(4, "0")}`;
    const monitorId = `system:token-miser:${objectId}`;
    const toolUseId = `tool-${index}`;
    const helperModel = variant === 5 ? "unknown-fixture-model" : GATE_MODEL;
    const entry: TokenMiserObjectMetadata = {
      version: 1,
      objectId,
      threadId: THREAD_ID,
      turnId,
      toolUseId,
      toolName: index % 3 === 0 ? "commandExecution" : "mcpToolCall",
      createdAt: 1_800_000_000_000 + index,
      originalCharacters: 12_000 + 250 * index,
      baselineParentTokens: 3_000 + 60 * index,
      replacementCharacters: 400 + 10 * (index % 7),
      retrievedCharacters: index % 4 === 0 ? 800 : 0,
      summary: {
        summary: "Large fixture result.",
        usefulDetails: [],
        suggestedNextStep: "Read a targeted range.",
      },
      ...(variant === 2 ? {} : {
        helperUsage: {
          helperThreadId: `helper-thread-${index}`,
          helperTurnId: `helper-turn-${index}`,
          model: helperModel,
          reasoningEffort: "medium",
          tokenUsage: {
            inputTokens: 1_500 + 10 * index,
            cachedInputTokens: 200,
            outputTokens: 80 + (index % 9),
            totalTokens: 1_580 + 10 * index + (index % 9),
          },
        },
      }),
      ...(variant === 2 || variant === 3 ? { disposition: "passed_through" as const } : { disposition: "summarized" as const }),
      ...(variant === 0 || variant === 3 || index % 5 === 0
        ? {
            replayTrackingVersion: 2 as const,
            cachedReplayCount: index % 5,
            cachedBaselineTokens: (3_000 + 60 * index) * (index % 5),
            cachedRevealedTokens: 120 * (index % 5),
          }
        : {}),
      ...(variant === 7 ? { parentModel: PARENT_MODELS[index % 2], parentServiceTier: "standard" } : {}),
    };
    entries.push(entry);

    if (variant === 0 || variant === 3) {
      persistedLines.push(gateLine({ monitorId, index, inputTokens: 1_500 + 10 * index }));
    }
    if (variant === 3) {
      // Persisted lines precede live ones; the persisted price must win.
      liveLines.push(gateLine({ monitorId, index, inputTokens: 9_000, live: true }));
    }
    if (variant === 4) {
      liveLines.push(gateLine({ monitorId, index, inputTokens: 2_200, live: true }));
    }

    // Every gate's own tool call plus later model round trips in its turn.
    for (let step = 0; step < 2 + (index % 4); step += 1) {
      observedAt += step === 1 ? 0 : 1; // A tie forces the invocationId tiebreak.
      invocations.push(invocation({
        itemId: step === 0 ? toolUseId : `${toolUseId}-follow-${step}`,
        invocationId: `invocation-${String(index).padStart(4, "0")}-${step}`,
        observedAt,
        turnId,
      }));
    }

    if (index % 2 === 0) {
      const model = PARENT_MODELS[(index / 2) % 2]!;
      const other = PARENT_MODELS[((index / 2) + 1) % 2]!;
      persistedLines.push(
        // Never a parent: another thread, a monitor line, or no model.
        parentLine({ id: `${sharedTurn}-other-thread`, model, threadId: "thread-other", turnId: sharedTurn }),
        parentLine({ id: `${sharedTurn}-monitor`, model, scope: "monitor", turnId: sharedTurn }),
        parentLine({ id: `${sharedTurn}-no-model`, turnId: sharedTurn }),
        // First match is by usage turn; a later direct turn match must lose.
        parentLine({
          id: `${sharedTurn}-usage-turn`,
          model,
          serviceTier: index % 4 === 0 ? "priority" : "standard",
          turnId: `request-${sharedTurn}`,
          usageTurnId: sharedTurn,
        }),
        parentLine({ id: `${sharedTurn}-later`, model: other, turnId: sharedTurn }),
      );
    }
  }

  // Focused helper inference is charged separately from any gate.
  persistedLines.push(
    gateLine({ monitorId: "system:token-miser-focused:focus-a", index: 9_001, inputTokens: 700 }),
    gateLine({ monitorId: "system:token-miser-focused:focus-b", index: 9_002, inputTokens: 900 }),
  );
  return { entries, invocations, liveLines, persistedLines };
}

function gateLine(params: {
  index: number;
  inputTokens: number;
  live?: boolean;
  monitorId: string;
}): ThreadUsageLineRecord {
  const outputTokens = 90;
  const cost = estimateTokenUsageCost({
    cachedInputTokens: 0,
    model: GATE_MODEL,
    outputTokens,
    uncachedInputTokens: params.inputTokens,
  })!;
  return {
    backend: "codex",
    cachedInputCostMicros: cost.cachedInputCostMicros,
    cachedInputTokens: 0,
    createdAt: 1_800_000_100_000 + params.index,
    currency: "USD",
    inputTokens: params.inputTokens,
    model: GATE_MODEL,
    outputCostMicros: cost.outputCostMicros,
    outputTokens,
    parentThreadId: THREAD_ID,
    priceStatus: "priced",
    provider: "openai",
    reasoningOutputTokens: 0,
    scope: "monitor",
    source: params.live ? "live" : "monitor",
    sourceItemId: params.monitorId,
    status: "finalized",
    threadId: `helper-thread-${params.index}`,
    totalCostMicros: cost.totalCostMicros,
    totalTokens: params.inputTokens + outputTokens,
    turnId: `helper-turn-${params.index}`,
    uncachedInputCostMicros: cost.uncachedInputCostMicros,
    uncachedInputTokens: params.inputTokens,
    usageLineId: `${params.monitorId}:${params.live ? "live" : "persisted"}`,
  };
}

function parentLine(params: {
  id: string;
  model?: string;
  scope?: ThreadUsageLineRecord["scope"];
  serviceTier?: string;
  threadId?: string;
  turnId: string;
  usageTurnId?: string;
}): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 0,
    cachedInputTokens: 4_000,
    createdAt: 1_800_000_000_000,
    currency: "USD",
    inputTokens: 10_000,
    ...(params.model ? { model: params.model } : {}),
    outputCostMicros: 0,
    outputTokens: 100,
    priceStatus: "unpriced",
    provider: "openai",
    reasoningOutputTokens: 0,
    scope: params.scope ?? "turn",
    serviceTier: params.serviceTier ?? "standard",
    source: "live",
    sourceItemId: "thread-token-usage",
    status: "finalized",
    threadId: params.threadId ?? THREAD_ID,
    totalCostMicros: 0,
    totalTokens: 10_100,
    turnId: params.turnId,
    ...(params.usageTurnId ? { usageTurnId: params.usageTurnId } : {}),
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 6_000,
    usageLineId: `parent:${params.id}`,
  };
}

function invocation(params: {
  invocationId: string;
  itemId: string;
  observedAt: number;
  turnId: string;
}): ThreadToolInvocationRecord {
  return {
    backend: "codex",
    threadId: THREAD_ID,
    turnId: params.turnId,
    itemId: params.itemId,
    invocationId: params.invocationId,
    toolName: "commandExecution",
    category: "search",
    status: "completed",
    observedAt: params.observedAt,
    updatedAt: params.observedAt,
    outputChars: 1_000,
    outputLines: 10,
    estimatedOutputTokens: 250,
    warningLines: 0,
    errorLines: 0,
    infoLines: 0,
    debugLines: 0,
    outputTruncated: false,
    noisy: false,
  };
}
