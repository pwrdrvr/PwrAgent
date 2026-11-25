import { registryContextStandIn } from "./helpers/registry-context-stand-in";
import fc from "fast-check";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadSubAgentSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import type { RegistryContext } from "../app-server/registry-context";
import { ThreadUsageLedger, type ThreadUsageLedgerHost } from "../app-server/thread-usage-ledger";
import { indexTokenMiserCachedReplays, indexTokenMiserPricingLines } from "../app-server/token-miser-ledger-index";
import { formatTaskMonitorNumber, formatTaskMonitorTokenCount } from "../app-server/thread-usage-math";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { estimateTokenCount, type TokenMiserObjectMetadata } from "../token-miser/token-miser-types";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const THREAD = "fixture-ledger";
const AT = Date.UTC(2026, 10, 1);

function gate(index: number): TokenMiserObjectMetadata {
  return {
    version: 1, objectId: `gate-${index}`, threadId: THREAD, turnId: `turn-${index}`,
    toolUseId: `tool-${index}`, toolName: "exec_command", createdAt: AT + index,
    originalCharacters: 12_345, baselineParentTokens: 3_000,
    replacementCharacters: 400, retrievedCharacters: 0,
    parentModel: "gpt-5.5", disposition: "summarized",
    replayTrackingVersion: 2, cachedReplayCount: 0,
    cachedBaselineTokens: 0, cachedRevealedTokens: 0,
    summary: { summary: "Fixture", usefulDetails: [], suggestedNextStep: "Read a range" },
    helperUsage: {
      model: "gpt-5.6-luna", helperThreadId: `helper-${index}`, helperTurnId: `helper-turn-${index}`,
      tokenUsage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100, totalTokens: 1_100 },
    },
  };
}

function line(index: number, overrides: Partial<ThreadUsageLineRecord> = {}): ThreadUsageLineRecord {
  return {
    backend: "codex", threadId: THREAD, turnId: `turn-${index}`, usageLineId: `line-${index}`,
    createdAt: AT + index, provider: "openai", scope: "turn", source: "hydration", status: "finalized",
    model: "gpt-5.5", currency: "USD", priceStatus: "priced", totalCostMicros: 0,
    inputTokens: 1_000, uncachedInputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100,
    reasoningOutputTokens: 0, totalTokens: 1_100, uncachedInputCostMicros: 0,
    cachedInputCostMicros: 0, outputCostMicros: 0, ...overrides,
  };
}

function fixture(database?: StateDb) {
  ledgerOwner.check();
  const db = database ?? openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const ledger = new ThreadUsageLedger({
    ...registryContextStandIn(),
    stores: { usage: store, subAgents: store, toolAccounting: store }, lifecycle: { closed: false },
    emit: async () => {},
  } as unknown as RegistryContext, {} as never, () => ({
    runtimeInstanceId: "fixture-owner", registrySessionId: "fixture-session", invalidateThreadListCache: () => {},
  }) as unknown as ThreadUsageLedgerHost);
  vi.spyOn(ledger, "emitThreadPricingUpdated").mockResolvedValue();
  const internals = ledger as unknown as {
    pendingTokenMiserInterceptions: Map<string, TokenMiserObjectMetadata>;
    liveTokenMiserSubAgents: Map<string, Map<string, ThreadSubAgentSummary>>;
    liveTokenMiserUsageLines: Map<string, Map<string, ThreadUsageLineRecord>>;
    clearLiveTokenMiserLedgerEntries(threadId: string, entries: readonly TokenMiserObjectMetadata[]): boolean;
    persistTokenMiserLedgerEntries(entries: readonly TokenMiserObjectMetadata[]): Promise<string[]>;
    buildTokenMiserLedgerArtifact(params: { entry: TokenMiserObjectMetadata; indexes: unknown }): {
      subAgent: ThreadSubAgentSummary;
    };
  };
  return { db, store, ledger, internals };
}

class LedgerModelOwner {
  readonly work = new Set<Promise<void>>();
  private closing = false;
  constructor(private readonly signal: AbortSignal) {}
  check(): void {
    this.signal.throwIfAborted();
    if (this.closing) throw new Error("Ledger model owner retired");
  }
  async close(): Promise<void> {
    this.closing = true;
    while (this.work.size) {
      const pending = [...this.work];
      // The test owns failures; teardown joins work before restoring its spies.
      await Promise.allSettled(pending);
      for (const admitted of pending) this.work.delete(admitted);
    }
  }
}
let ledgerOwner: LedgerModelOwner;
beforeEach(({ signal }) => { ledgerOwner = new LedgerModelOwner(signal); });
function ownLedgerTest<Args extends unknown[]>(run: (...args: Args) => Promise<void>): (...args: Args) => Promise<void> {
  return (...args) => {
    const owner = ledgerOwner;
    owner.check();
    const work = run(...args);
    owner.work.add(work);
    return work;
  };
}
async function cleanupLedgerTests(): Promise<void> {
  await ledgerOwner.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
}
afterEach(cleanupLedgerTests);

async function checkOverlappingFlushes(retrievedCharacters: number, failFirst: boolean) {
  const { db, store, ledger, internals } = fixture();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const getMany = store.getThreadSubAgents.bind(store);
  vi.spyOn(store, "getThreadSubAgents").mockImplementationOnce(async (params) => {
    entered();
    await held;
    if (failFirst) throw new Error("fixture first-batch failure");
    return getMany(params);
  });
  try {
    const older = gate(0);
    ledger.rememberPendingTokenMiserInterception(older);
    const first = internals.persistTokenMiserLedgerEntries([older]);
    // Observe rejection immediately; the next write must still proceed.
    const settledFirst = first.then(() => "fulfilled", () => "rejected");
    await reading;
    const newer = { ...older, retrievedCharacters };
    ledger.rememberPendingTokenMiserInterception(newer);
    const second = internals.persistTokenMiserLedgerEntries([newer]);
    // Drain the second call's ready microtasks before releasing the blocked
    // first read. This models a later flush arriving during a paced batch.
    await yieldToEventLoop();
    release();
    await second;
    expect(await settledFirst).toBe(failFirst ? "rejected" : "fulfilled");
    const card = await store.getThreadSubAgent({
      backend: "codex", threadId: THREAD, monitorId: "system:token-miser:gate-0",
    });
    expect(card?.tokenMiserAccounting?.revealedParentTokens)
      .toBe(estimateTokenCount(newer.replacementCharacters) + estimateTokenCount(retrievedCharacters));
    expect(internals.pendingTokenMiserInterceptions.size).toBe(0);
  } finally { release(); vi.restoreAllMocks(); db.close(); }
}

describe("Token Miser persistence work budgets", () => {
  it("cannot overwrite one later retrieval with an overlapping older flush", ownLedgerTest(async () => {
    await checkOverlappingFlushes(400, false);
  }));

  it.each([
    [400, true],
    [4_000, false],
    [4_000, true],
  ] as const)("orders overlapping flushes with %i retrieved characters (first flush fails: %s)", ownLedgerTest(
    async (retrievedCharacters, failFirst) => {
      await checkOverlappingFlushes(retrievedCharacters, failFirst);
    },
  ));

  it.each([65, 128, 129, 130])("retains an arriving gate while persisting %i entries across batches", ownLedgerTest(async (count) => {
    const { db, ledger, internals } = fixture();
    try {
      const entries = Array.from({ length: count }, (_, index) => gate(index));
      for (const entry of entries) ledger.rememberPendingTokenMiserInterception(entry);
      const newer = { ...entries[0]!, retrievedCharacters: 800 };
      const liveCard = { monitorId: "system:token-miser:gate-0" } as ThreadSubAgentSummary;
      const arriving = yieldToEventLoop().then(() => {
        ledger.rememberPendingTokenMiserInterception(newer);
        internals.liveTokenMiserSubAgents.set(THREAD, new Map([[liveCard.monitorId, liveCard]]));
      });
      await internals.persistTokenMiserLedgerEntries(entries);
      await arriving;
      expect(internals.pendingTokenMiserInterceptions.get(newer.objectId)).toBe(newer);
      expect(internals.liveTokenMiserSubAgents.get(THREAD)?.get(liveCard.monitorId)).toBe(liveCard);
      await ledger.flushPendingTokenMiserLedger({ threadId: THREAD });
      expect(internals.pendingTokenMiserInterceptions.size).toBe(0);
      expect(internals.liveTokenMiserSubAgents.size).toBe(0);
    } finally { vi.restoreAllMocks(); db.close(); }
  }));

  it.each([128, 256])("clears %i live entries in one line pass", (count) => {
    const { db, internals } = fixture();
    try {
      const entries = Array.from({ length: count }, (_, index) => gate(index));
      let reads = 0;
      internals.liveTokenMiserUsageLines.set(THREAD, new Map(entries.map((entry, index) => [
        `line-${index}`, { get sourceItemId() { reads += 1; return `system:token-miser:${entry.objectId}`; } } as ThreadUsageLineRecord,
      ])));
      expect(internals.clearLiveTokenMiserLedgerEntries(THREAD, entries)).toBe(true);
      expect(reads).toBeLessThanOrEqual(count);
      expect(internals.liveTokenMiserUsageLines.size).toBe(0);
    } finally { db.close(); }
  });

  it.each([2, 128, 256])("paces %i gates in batches of at most 64 and rebuilds none on an identical flush", ownLedgerTest(async (count) => {
    const { db, store, internals } = fixture();
    let done = false;
    const builds = vi.spyOn(internals, "buildTokenMiserLedgerArtifact");
    const batch = vi.spyOn(store, "getThreadSubAgents");
    const observed = [0];
    const observing = (async () => {
      while (!done) { await yieldToEventLoop(); observed.push(builds.mock.calls.length); }
    })();
    try {
      const entries = Array.from({ length: count }, (_, index) => gate(index));
      await internals.persistTokenMiserLedgerEntries(entries);
      done = true;
      await observing;
      expect(builds).toHaveBeenCalledTimes(count);
      expect(batch).toHaveBeenCalledTimes(Math.ceil(count / 64));
      expect(batch.mock.calls.every(([params]) => params.monitorIds.length <= 64)).toBe(true);
      for (let index = 1; index < observed.length; index += 1) {
        expect(observed[index]! - observed[index - 1]!).toBeLessThanOrEqual(64);
      }
      builds.mockClear();
      await internals.persistTokenMiserLedgerEntries(entries);
      expect(builds).toHaveBeenCalledTimes(0);
    } finally { done = true; await observing; db.close(); }
  }));

  // The database owns the persisted comparison. Repeated input must do no
  // display work, and a sparse change must rebuild only the affected cards.
  it.each([2, 36])("rebuilds only changed cards and uses one keyed read in a batch of %i", ownLedgerTest(async (count) => {
    const { db, store, internals } = fixture();
    try {
      const entries = Array.from({ length: count }, (_, index) => gate(index));
      await internals.persistTokenMiserLedgerEntries(entries);
      const build = vi.spyOn(internals, "buildTokenMiserLedgerArtifact");
      const single = vi.spyOn(store, "getThreadSubAgent");
      const batch = vi.spyOn(store, "getThreadSubAgents");
      const formats = vi.spyOn(Number.prototype, "toLocaleString");
      // TypeScript declares a method; the runtime exposes a bound accessor.
      const intlPrototype = Intl.NumberFormat.prototype as unknown as { readonly format: unknown };
      const intlFormats = vi.spyOn(intlPrototype, "format", "get");
      await internals.persistTokenMiserLedgerEntries(entries);
      expect(build).toHaveBeenCalledTimes(0);
      expect(formats).toHaveBeenCalledTimes(0);
      expect(intlFormats).toHaveBeenCalledTimes(0);
      expect(single).toHaveBeenCalledTimes(0);
      expect(batch).toHaveBeenCalledTimes(1);

      entries[0] = { ...entries[0]!, retrievedCharacters: 800, replayTrackingStoppedAt: AT + 500 };
      await internals.persistTokenMiserLedgerEntries(entries);
      expect(build).toHaveBeenCalledTimes(1);
      expect(intlFormats.mock.calls.length).toBeLessThanOrEqual(6);
      expect(single).toHaveBeenCalledTimes(0);
      expect(batch).toHaveBeenCalledTimes(2);
    } finally { vi.restoreAllMocks(); db.close(); }
  }));

  it.each([
    { cohort: "legacy", legacy: true, operations: ["retrieve", "reparent", "retrieve", "delete", "retrieve"] },
    { cohort: "tracked", legacy: false, operations: ["replay", "retrieve", "replay", "stop", "reparent", "retrieve", "delete"] },
    { cohort: "stopped first", legacy: false, operations: ["stop", "retrieve", "delete", "reparent", "retrieve"] },
  ] as const)("follows database edits for a $cohort gate instead of caching a flush", ownLedgerTest(async ({ legacy, operations }) => {
    const { db, store, internals } = fixture();
    try {
      // The store never downgrades a gate's tracking version or observes
      // replays after it stops.
      let entry: TokenMiserObjectMetadata = {
        ...gate(0), replayTrackingVersion: legacy ? undefined : 2 as const,
        originalCharacters: 12_000,
        cachedReplayCount: legacy ? undefined : 0,
        cachedBaselineTokens: legacy ? undefined : 0,
        cachedRevealedTokens: legacy ? undefined : 0,
        parentRequestsObservedAfterGate: legacy ? undefined : 2,
        lastParentCumulativeInputTokens: legacy ? undefined : 2_000,
      };
      for (const operation of operations) {
        if (operation === "retrieve") entry = { ...entry, retrievedCharacters: entry.retrievedCharacters + 400 };
        const active = entry.replayTrackingVersion === 2 && entry.replayTrackingStoppedAt === undefined;
        if (operation === "replay" && active) entry = { ...entry, cachedReplayCount: (entry.cachedReplayCount ?? 0) + 1,
          cachedBaselineTokens: (entry.cachedBaselineTokens ?? 0) + entry.baselineParentTokens,
          cachedRevealedTokens: (entry.cachedRevealedTokens ?? 0)
            + estimateTokenCount(entry.replacementCharacters + entry.retrievedCharacters),
          parentRequestsObservedAfterGate: (entry.parentRequestsObservedAfterGate ?? 0) + 1,
          lastParentCumulativeInputTokens: (entry.lastParentCumulativeInputTokens ?? 0) + 1_000 };
        if (operation === "stop" && active) entry = { ...entry, replayTrackingStoppedAt: AT + 100 };
        if (operation === "delete") db.raw.prepare("DELETE FROM thread_sub_agents WHERE monitor_id = ?").run("system:token-miser:gate-0");
        // Legacy persisted cards can lack nesting; the gate's turn is fixed.
        if (operation === "reparent") db.raw.prepare("UPDATE thread_sub_agents SET card = json_remove(card, '$.parentTurnId') WHERE monitor_id = ?")
          .run("system:token-miser:gate-0");
        // Slow oracle: build a complete card on every transition from the
        // authoritative whole ledger, regardless of the comparison shortcut.
        const pricing = await store.readThreadPricing({ backend: "codex", threadId: THREAD });
        const expected = internals.buildTokenMiserLedgerArtifact({ entry, indexes: {
          pricing: indexTokenMiserPricingLines(pricing.lines), replays: indexTokenMiserCachedReplays([]),
        } }).subAgent;
        await internals.persistTokenMiserLedgerEntries([entry]);
        const actual = await store.getThreadSubAgent({ backend: "codex", threadId: THREAD, monitorId: expected.monitorId });
        expect(actual?.parentTurnId).toEqual(expected.parentTurnId);
        expect(actual?.tokenMiserAccounting).toEqual(expected.tokenMiserAccounting);
      }
    } finally { vi.restoreAllMocks(); db.close(); }
  }));
});

describe("Token Miser pricing projection", () => {
  it.each([20, 40])("materializes %i repair candidates in groups of at most ten", ownLedgerTest(async (count) => {
    const { db, store } = fixture();
    try {
      await store.upsertThreadUsageLines({ lines: Array.from({ length: count }, (_, index) => line(index, { model: "unknown-fixture" })) });
      db.raw.prepare("UPDATE thread_usage_lines SET model = 'gpt-5.5'").run();
      const attach = vi.spyOn(store as unknown as {
        attachUsageTurnMetadataSync(backend: string, threadId: string, lines: ThreadUsageLineRecord[]): void;
      }, "attachUsageTurnMetadataSync");
      await store.readTokenMiserGatePricingLines({ backend: "codex", threadId: THREAD, sourceItemIds: [], turnIds: ["turn-1"] });
      const sizes = attach.mock.calls.map((call) => call[2].length);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(10);
      expect(sizes.reduce((total, size) => total + size, 0)).toBe(count + 1);
    } finally { db.close(); }
  }));

  it.each([128, 256].flatMap((count) => [false, true].map((unpriced) => ({ count, unpriced }))))(
    "bounds pricing and turn rows for $count history rows, unpriced=$unpriced", ownLedgerTest(async ({ count, unpriced }) => {
    const { db, store } = fixture();
    try {
      await store.upsertThreadUsageLines({ lines: Array.from({ length: count }, (_, index) => line(index, {
        model: unpriced && index % 2 ? "unknown-fixture" : "gpt-5.5",
      })) });
      const materialize = vi.spyOn(store as unknown as { materializeThreadPricing(params: unknown): unknown }, "materializeThreadPricing");
      const returned = { lines: 0, turns: 0 };
      const prepare = db.raw.prepare.bind(db.raw);
      vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        const kind = /FROM thread_usage_lines/.test(sql) ? "lines" : /(?:FROM|JOIN) thread_usage_turns/.test(sql) ? "turns" : undefined;
        if (kind) {
          const all = statement.all.bind(statement);
          vi.spyOn(statement, "all").mockImplementation((...args) => {
            const rows = all(...args);
            returned[kind] += rows.length;
            const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>;
            // Keyset pages must seek the existing ledger indexes, rather
            // than re-sort or fully scan the history for every ten rows.
            if (/LIMIT \?/.test(sql)) {
              expect(plan.some((row) => /SCAN thread_usage_lines|USE TEMP B-TREE/.test(row.detail))).toBe(false);
            }
            return rows;
          });
        }
        return statement;
      });
      const result = await store.readTokenMiserGatePricingLines({
        backend: "codex", threadId: THREAD, sourceItemIds: [], turnIds: ["turn-1"],
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.priceStatus).toBe(unpriced ? "unpriced" : "priced");
      expect(materialize).toHaveBeenCalledTimes(0);
      expect(returned.lines).toBe(unpriced ? 12 : 1);
      expect(returned.turns).toBe(unpriced ? 11 : 1);
    } finally { vi.restoreAllMocks(); db.close(); }
  }));

  it.each(["local", "rollback", "peer"] as const)("restarts a yielded repair pass after a %s edit", ownLedgerTest(async (writer) => {
    vi.spyOn(Date, "now").mockReturnValue(AT + 1_000);
    const temp = createTempStateDb("pwragent-gate-repricing-");
    const { db, store } = fixture(StateDb.open(temp.dbPath));
    const peer = writer === "peer" ? StateDb.open(temp.dbPath) : undefined;
    try {
      await store.upsertThreadUsageLines({ lines: Array.from({ length: 24 }, (_, index) => line(index, { model: "unknown-fixture" })) });
      db.raw.prepare("UPDATE thread_usage_lines SET model = 'gpt-5.5'").run();
      // The first ten candidates are already captured when this callback
      // runs. A changed price input must discard that pass's derived prices.
      const editing = yieldToEventLoop().then(() => {
        const connection = peer?.raw ?? db.raw;
        if (writer === "rollback") connection.exec("BEGIN");
        connection.prepare("UPDATE thread_usage_lines SET model = 'unknown-fixture'").run();
        if (writer === "rollback") connection.exec("ROLLBACK");
      });
      const actual = await store.readTokenMiserGatePricingLines({
        backend: "codex", threadId: THREAD, sourceItemIds: [], turnIds: ["turn-23"],
      });
      await editing;
      expect(actual[0]!.priceStatus).toBe(writer === "rollback" ? "priced" : "unpriced");
      const oracle = await store.readThreadPricing({ backend: "codex", threadId: THREAD });
      expect(actual).toEqual(oracle.lines.filter((row) => row.turnId === "turn-23"));
    } finally { peer?.close(); db.close(); removeTempStateDbDir(temp.tempDir); }
  }));

  it("keeps a caller's transaction synchronous and never retains rolled-back repairs", ownLedgerTest(async () => {
    const { db, store } = fixture();
    try {
      await store.upsertThreadUsageLines({ lines: Array.from({ length: 24 }, (_, index) => line(index, { model: "unknown-fixture" })) });
      db.raw.prepare("UPDATE thread_usage_lines SET model = 'gpt-5.5'").run();
      let yielded = false;
      const observing = yieldToEventLoop().then(() => { yielded = true; });
      db.raw.exec("BEGIN");
      const actual = await store.readTokenMiserGatePricingLines({
        backend: "codex", threadId: THREAD, sourceItemIds: [], turnIds: ["turn-23"],
      });
      expect(actual[0]!.priceStatus).toBe("priced");
      expect(yielded).toBe(false);
      db.raw.exec("ROLLBACK");
      expect(db.raw.prepare("SELECT price_status FROM thread_usage_lines WHERE usage_line_id = 'line-23'").get())
        .toEqual({ price_status: "unpriced" });
      await observing;
    } finally { if (db.raw.inTransaction) db.raw.exec("ROLLBACK"); db.close(); }
  }));

  // Keep the old whole-ledger implementation as the differential oracle:
  // repairing just the requested gate can jump past a ten-row no-progress
  // barrier, and stopping after one repair pass can miss regrouped rows.
  it.each([
    { scenario: "no repairable rows", repairable: Array<boolean>(12).fill(false) },
    { scenario: "multiple repair passes", repairable: Array<boolean>(32).fill(true) },
    { scenario: "no progress after two passes", repairable: [...Array<boolean>(20).fill(true), ...Array<boolean>(10).fill(false)] },
    { scenario: "repairable rows beyond the first barrier", repairable: [...Array<boolean>(10).fill(false), ...Array<boolean>(28).fill(true)] },
    { scenario: "alternating repairs with timestamp ties", repairable: Array.from({ length: 38 }, (_, index) => index % 2 === 0) },
  ])("matches the whole-ledger repricing fixed point with $scenario", ownLedgerTest(async ({ repairable }) => {
    await runRepricingCase(repairable);
  }));
});

describe("Token Miser display formatting", () => {
  it("preserves the process locale's number output and token rounding", () => {
    fc.assert(fc.property(fc.double(), (value) => {
      expect(formatTaskMonitorNumber(value)).toBe(value.toLocaleString());
      expect(formatTaskMonitorTokenCount(value)).toBe(Math.round(value).toLocaleString());
    }));
  });
});

describe("Token Miser ledger SQLite commit budgets", () => {
  it("keeps terminal writes batched and identical/idle flushes at zero commits", ownLedgerTest(async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-gate-commits-");
    const { db, internals } = fixture(StateDb.open(temp.dbPath));
    try {
      const entries = Array.from({ length: 9 }, (_, index) => gate(index));
      for (const scenario of ["insert", "identical", "sparse-change", "idle"] as const) {
        if (scenario === "sparse-change") entries[0] = { ...entries[0]!, retrievedCharacters: 800 };
        const { writes } = await measureSqliteWrites(async () => {
          await internals.persistTokenMiserLedgerEntries(scenario === "idle" ? [] : entries);
        });
        expectSqliteWriteBudget({
          scenario: `token-miser-persistence-${scenario}`, writes,
          note: "Real ledger persistence: nine gates; insert, identical repeat, one retrieval change, or empty flush. Setup excluded.",
        });
      }
    } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
  }));

  it("retains one repair commit per repricing pass and zero on a repeated read", ownLedgerTest(async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-gate-repair-commits-");
    const { db, store } = fixture(StateDb.open(temp.dbPath));
    try {
      await store.upsertThreadUsageLines({ lines: Array.from({ length: 24 }, (_, index) => line(index, { model: "unknown-fixture" })) });
      db.raw.prepare("UPDATE thread_usage_lines SET model = 'gpt-5.5'").run();
      const totalChanges = db.raw.prepare<[], number>("SELECT total_changes()").pluck();
      for (const scenario of ["repair", "repeat"] as const) {
        const before = totalChanges.get()!;
        const { writes } = await measureSqliteWrites(async () => {
          await store.readTokenMiserGatePricingLines({
            backend: "codex", threadId: THREAD, sourceItemIds: [], turnIds: ["turn-23"],
          });
        });
        // The repair changes 24 ledger lines and applies 24 summary deltas.
        expect(totalChanges.get()! - before).toBe(scenario === "repair" ? 48 : 0);
        expectSqliteWriteBudget({
          scenario: `token-miser-pricing-${scenario}`, writes,
          note: "Targeted gate pricing with 24 legacy repairable rows, or an identical repeat; setup excluded.",
        });
      }
    } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
  }));
});

async function runRepricingCase(repairable: readonly boolean[], afterRead?: (target: ReturnType<typeof fixture>) => Promise<void>): Promise<void> {
  vi.spyOn(Date, "now").mockReturnValue(AT + 1_000);
  const target = fixture();
  const oracle = fixture();
  try {
    const lines = repairable.map((_, index) => line(index, {
      createdAt: AT + Math.floor(index / 3),
      model: "unknown-fixture", parentThreadId: index % 3 ? undefined : THREAD,
      threadId: index % 3 ? THREAD : `child-${index}`,
      scope: index % 3 ? "turn" : "monitor", sourceItemId: `gate-${index}`,
      inputTokens: index % 2 ? 350_000 : 1_000,
      uncachedInputTokens: index % 2 ? 350_000 : 1_000,
      totalTokens: index % 2 ? 350_100 : 1_100,
    }));
    for (const { db, store } of [target, oracle]) {
      await store.upsertThreadUsageLines({ lines });
      db.raw.prepare("UPDATE thread_usage_turns SET model_context_window = 1000000, started_at = ?, completed_at = ?")
        .run(AT, AT + 500);
      for (let index = 0; index < repairable.length; index += 1) {
        if (repairable[index]) db.raw.prepare("UPDATE thread_usage_lines SET model = 'gpt-5.5' WHERE usage_line_id = ?").run(`line-${index}`);
      }
    }
    const actual = await target.store.readTokenMiserGatePricingLines({
      backend: "codex", threadId: THREAD, sourceItemIds: ["gate-0"], turnIds: ["turn-1"],
    });
    if (afterRead) await afterRead(target);
    const expected = await oracle.store.readThreadPricing({ backend: "codex", threadId: THREAD });
    expect(actual).toEqual(expected.lines.filter((row) => row.sourceItemId === "gate-0" || row.threadId === THREAD && row.turnId === "turn-1"));
    expect(await target.store.readThreadPricingSummaries([{ backend: "codex", threadId: THREAD }]))
      .toEqual(expected.summaries);
  } finally { vi.restoreAllMocks(); target.db.close(); oracle.db.close(); }
}

function repricingGate() {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  return {
    ready,
    release,
    afterRead: async (target: ReturnType<typeof fixture>) => {
      expect(target.db.raw.prepare("SELECT count(*) AS count FROM thread_usage_lines").get()).toEqual({ count: 12 });
      entered();
      await hold;
    },
  };
}

it("ledger owner teardown joins real repricing before restoring its clock", async () => {
  const gate = repricingGate();
  const work = ownLedgerTest(() => runRepricingCase(Array<boolean>(12).fill(true), gate.afterRead))()
    .then(() => undefined, error => error);
  await gate.ready;
  let retired = false;
  const first = cleanupLedgerTests().then(() => { retired = true; });
  const second = cleanupLedgerTests();
  try {
    await yieldToEventLoop();
    expect({ clockOwned: vi.isMockFunction(Date.now), retired }).toEqual({ clockOwned: true, retired: false });
  } finally {
    gate.release();
    await work;
    await Promise.all([first, second]);
  }
  expect(await work).toBeUndefined();
});

it.each(["abort", "retire"] as const)("ledger owner %s admits no further real database cases", async (stop) => {
  const controller = new AbortController();
  ledgerOwner = new LedgerModelOwner(controller.signal);
  const gate = repricingGate();
  let admitted = 0;
  const work = ownLedgerTest(async () => {
    await fc.assert(fc.asyncProperty(fc.constant(Array<boolean>(12).fill(true)), async repairable => {
      admitted++;
      await runRepricingCase(repairable, admitted === 1 ? gate.afterRead : undefined);
    }).beforeEach(() => ledgerOwner.check()), { numRuns: 2 });
  })().then(() => undefined, error => error);
  await gate.ready;
  let retiring: Promise<void> | undefined;
  try {
    if (stop === "abort") controller.abort(new Error("controlled repricing abort"));
    else retiring = ledgerOwner.close();
    gate.release();
    const error = await work;
    expect({ admitted, rejected: error !== undefined }).toEqual({ admitted: 1, rejected: true });
  } finally { gate.release(); await work; await retiring; }
});

it("ledger owner rejects work before opening a database after abort", async () => {
  const reason = new Error("already retired ledger model");
  ledgerOwner = new LedgerModelOwner(AbortSignal.abort(reason));
  const run = vi.fn(async () => { const { db } = fixture(); db.close(); });
  expect(() => ownLedgerTest(run)()).toThrow(reason);
  expect(run).not.toHaveBeenCalled();
});
