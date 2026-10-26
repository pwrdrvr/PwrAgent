import type {
  AgentEvent,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import type { TokenMiserObjectMetadata } from "../token-miser/token-miser-types";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";
import { TestTokenMiserStore } from "./token-miser-test-store";

// A packaged build beachballed when a turn ended on a thread with 2,509 usage
// lines and 1,986 Token Miser gates: one turn end read the whole pricing
// ledger several times and re-parsed the thread overlay between them. These
// tests drive one real turn end through the real registry and store, and
// count the whole-thread work it does. The counts are a pure function of the
// code path, so a small thread and a large one must produce the same numbers.

const THREAD_ID = "thread-turn-end";
const FINAL_TURN_ID = "turn-final";
const GATE_MODEL = "gpt-5.6-luna";
const PARENT_MODEL = "gpt-5.6-terra";
/** Gates the final turn created; they persist at its end. */
const FINAL_TURN_GATES = 5;

type Internals = {
  emit(event: AgentEvent): Promise<void>;
  flushLiveThreadUsageLines(): Promise<void>;
  pendingTokenMiserInterceptions: Map<string, TokenMiserObjectMetadata>;
  persistTokenMiserLedgerEntries(
    entries: readonly TokenMiserObjectMetadata[],
  ): Promise<void>;
  tokenMiserStore?: TestTokenMiserStore;
};

type TurnEndCounts = {
  /** Whole-ledger SELECTs for the finished thread during the turn end. */
  ledgerReads: number;
  /** Ledger rows they materialized, as a multiple of the ledger's size. */
  ledgerRowsPerLedger: number;
  /** Whole-ledger SELECTs for the renderer's follow-up reads after it. */
  followUpLedgerReads: number;
  /** Thread overlay payload parses during the turn end. */
  overlayParses: number;
  /** Serialized size of the overlay state those parses produced. */
  overlayParseBytes: number;
  /** `thread/pricing/updated` events for the finished thread. */
  pricingEmits: number;
  /** Token Miser thread accounting builds during the turn end. */
  tokenMiserAccountingBuilds: number;
};

/**
 * Count the rows each whole-ledger SELECT materializes for one thread. This
 * watches the statement rather than a store method, so it counts the same
 * thing whichever method issues the read.
 */
function countWholeLedgerReads(stateDb: StateDb, threadId: string) {
  const counts = { reads: 0, rows: 0 };
  const raw = stateDb.raw;
  const prepare = raw.prepare.bind(raw);
  vi.spyOn(raw, "prepare").mockImplementation(((sql: string) => {
    const statement = prepare(sql);
    const wholeLedger =
      /FROM thread_usage_lines/.test(sql)
      && /parent_thread_id = \?/.test(sql)
      && /ORDER BY created_at DESC, usage_line_id DESC/.test(sql)
      && !/json_each/.test(sql);
    if (!wholeLedger) {
      return statement;
    }
    const all = statement.all.bind(statement);
    statement.all = ((...args: unknown[]) => {
      const rows = all(...args) as unknown[];
      if (args.includes(threadId)) {
        counts.reads += 1;
        counts.rows += rows.length;
      }
      return rows;
    }) as typeof statement.all;
    return statement;
  }) as typeof raw.prepare);
  return counts;
}

describe("turn end read budget", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  async function setupThread(params: {
    historicalTurns: number;
    stateDb: StateDb;
  }) {
    const store = new SqliteOverlayStore(params.stateDb);
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-turn-end-"));
    const registry = new DesktopBackendRegistry({
      codexClient: {
        close: async () => {},
        getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [],
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
      } as never,
      overlayStore: store,
    });
    const internals = registry as unknown as Internals;
    internals.tokenMiserStore = new TestTokenMiserStore(
      path.join(directory, "token-miser"),
    );
    cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
    cleanups.push(() => registry.close());

    // History: one parent usage line and one persisted gate per earlier turn.
    await store.upsertThreadUsageLines({
      lines: Array.from({ length: params.historicalTurns }, (_, index) =>
        parentLine(`turn-${index}`, index)),
    });
    await internals.persistTokenMiserLedgerEntries(
      Array.from({ length: params.historicalTurns }, (_, index) =>
        gateEntry(index, `turn-${index}`)),
    );
    const ledgerSize = (await store.readThreadPricing({
      backend: "codex",
      threadId: THREAD_ID,
    })).lines.length;
    expect(ledgerSize).toBe(2 * params.historicalTurns);

    // The final turn: started, one usage observation still buffered, and
    // gates waiting to persist at its end.
    await internals.emit({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: THREAD_ID,
          turnId: FINAL_TURN_ID,
          turn: { id: FINAL_TURN_ID, status: "inProgress" },
        },
      } as AgentEvent["notification"],
    });
    await internals.emit({
      backend: "codex",
      notification: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: THREAD_ID,
          turnId: FINAL_TURN_ID,
          model: PARENT_MODEL,
          tokenUsage: {
            last: { inputTokens: 2_000, cachedInputTokens: 500, outputTokens: 40, totalTokens: 2_040 },
            total: { inputTokens: 900_000, cachedInputTokens: 500_000, outputTokens: 9_000, totalTokens: 909_000 },
          },
        },
      } as AgentEvent["notification"],
    });
    for (let index = 0; index < FINAL_TURN_GATES; index += 1) {
      const entry = gateEntry(100_000 + index, FINAL_TURN_ID);
      internals.pendingTokenMiserInterceptions.set(entry.objectId, entry);
    }
    return { internals, ledgerSize, registry, store };
  }

  async function endTurn(internals: Internals): Promise<void> {
    await internals.emit({
      backend: "codex",
      notification: {
        method: "thread/status/changed",
        params: { threadId: THREAD_ID, status: { type: "idle" } },
      } as AgentEvent["notification"],
    });
    await internals.emit({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: THREAD_ID,
          turnId: FINAL_TURN_ID,
          turn: { id: FINAL_TURN_ID, status: "completed", completedAt: 1_900_000_000 },
        },
      } as AgentEvent["notification"],
    });
  }

  async function measureTurnEnd(historicalTurns: number): Promise<TurnEndCounts> {
    const stateDb = openInMemoryStateDb();
    cleanups.push(() => stateDb.close());
    const { internals, ledgerSize, registry, store } = await setupThread({
      historicalTurns,
      stateDb,
    });

    const ledger = countWholeLedgerReads(stateDb, THREAD_ID);
    let overlayParses = 0;
    let overlayParseBytes = 0;
    const overlayStore = store as unknown as {
      getThread(threadKey: string): unknown;
    };
    const getThread = overlayStore.getThread.bind(store);
    vi.spyOn(overlayStore, "getThread").mockImplementation((threadKey) => {
      const overlay = getThread(threadKey);
      if (threadKey.endsWith(THREAD_ID)) {
        overlayParses += 1;
        overlayParseBytes += JSON.stringify(overlay ?? null).length;
      }
      return overlay;
    });
    const accountingInternals = registry as unknown as {
      buildTokenMiserThreadSavings(...args: unknown[]): unknown;
      withTokenMiserAccounting(...args: unknown[]): unknown;
    };
    const accountingBuilds = [
      vi.spyOn(accountingInternals, "withTokenMiserAccounting"),
      vi.spyOn(accountingInternals, "buildTokenMiserThreadSavings"),
    ];
    let pricingEmits = 0;
    registry.onEvent((event) => {
      if (
        event.notification.method === "thread/pricing/updated"
        && event.notification.params.threadId === THREAD_ID
      ) {
        pricingEmits += 1;
      }
    });

    await endTurn(internals);
    const turnEnd = {
      ledgerReads: ledger.reads,
      ledgerRows: ledger.rows,
      overlayParseBytes,
      overlayParses,
      tokenMiserAccountingBuilds: accountingBuilds.reduce(
        (total, spy) => total + spy.mock.calls.length,
        0,
      ),
    };

    // What the focused thread's renderer reads next: the accounting display
    // and an open context panel's Pricing tab.
    for (const display of [
      { resource: "accounting" as const },
      { resource: "pricing" as const, limit: 20, deferPricingGates: true },
    ]) {
      await registry.readThread({
        backend: "codex",
        display,
        includeTurns: false,
        threadId: THREAD_ID,
        viewOnly: true,
      });
    }
    const followUpLedgerReads = ledger.reads - turnEnd.ledgerReads;

    // The turn end did its job: the final usage line, its end time, and the
    // final turn's gates are all durable.
    vi.mocked(stateDb.raw.prepare).mockRestore();
    const pricing = await store.readThreadPricing({ backend: "codex", threadId: THREAD_ID });
    const finalLine = pricing.lines.find((line) =>
      line.turnId === FINAL_TURN_ID && line.parentThreadId === undefined);
    expect(finalLine?.completedAt).toBeDefined();
    expect(pricing.lines.length).toBe(ledgerSize + 1 + FINAL_TURN_GATES);
    expect((await store.readThreadSubAgentRevision({
      backend: "codex",
      threadId: THREAD_ID,
    })).count).toBe(historicalTurns + FINAL_TURN_GATES);
    expect(internals.pendingTokenMiserInterceptions.size).toBe(0);

    return {
      followUpLedgerReads,
      ledgerReads: turnEnd.ledgerReads,
      ledgerRowsPerLedger: Number((turnEnd.ledgerRows / pricing.lines.length).toFixed(2)),
      overlayParseBytes: turnEnd.overlayParseBytes,
      overlayParses: turnEnd.overlayParses,
      pricingEmits,
      tokenMiserAccountingBuilds: turnEnd.tokenMiserAccountingBuilds,
    };
  }

  it("does the same whole-thread work for a small and a large thread", async () => {
    const small = await measureTurnEnd(20);
    const large = await measureTurnEnd(2_000);
    // One ledger read serves the turn end's one pricing publish, and the
    // renderer's follow-up reads reuse it. The Token Miser persist looks up
    // only its own gates' lines.
    const { overlayParseBytes: _smallBytes, overlayParses, ...rest } = small;
    expect(rest).toEqual({
      followUpLedgerReads: 0,
      ledgerReads: 1,
      ledgerRowsPerLedger: 1,
      pricingEmits: 1,
      tokenMiserAccountingBuilds: 0,
    });
    const { overlayParseBytes, ...largeRest } = large;
    expect(largeRest).toEqual({ ...rest, overlayParses });
    // Gate cards live in their own table, so the overlay row a turn end
    // parses does not grow with the thread's 2,005 cards: each parse read
    // ~3.5 MB when they were in the row. Bytes are bounded rather than
    // compared, because the large thread also carries a pending spend alert.
    expect(overlayParses).toMatchInlineSnapshot(`5`);
    expect(overlayParseBytes).toBeLessThan(overlayParses * 1_024);
  }, 60_000);

  // Each display read rebuilds the thread's whole display: Token Miser
  // accounting, every sub-agent card, the overlay, and tool accounting. A
  // renderer refresh after a turn end therefore asks for every loaded turn
  // and every loaded Pricing row in one read each, not in 256-turn chunks and
  // 20-row pages.
  async function measureRendererRefresh(historicalTurns: number) {
    const stateDb = openInMemoryStateDb();
    cleanups.push(() => stateDb.close());
    const { internals, registry, store } = await setupThread({ historicalTurns, stateDb });
    await endTurn(internals);
    const builds = {
      cardLists: vi.spyOn(store, "listThreadSubAgents"),
      overlays: vi.spyOn(store, "getThreadOverlayState"),
      tokenMiser: vi.spyOn(
        registry as unknown as { withTokenMiserAccounting(...args: unknown[]): unknown },
        "withTokenMiserAccounting",
      ),
      toolAccounting: vi.spyOn(store, "readThreadToolAccounting"),
    };
    const loadedTurns = [
      ...Array.from({ length: historicalTurns }, (_, index) => `turn-${index}`),
      FINAL_TURN_ID,
    ].map((id) => ({ id, status: "completed" as const }));
    const accounting = await registry.readThread({
      backend: "codex",
      display: { resource: "accounting", turns: loadedTurns },
      includeTurns: false,
      threadId: THREAD_ID,
      viewOnly: true,
    });
    // Five loaded 20-row pages, or every row of a thread with fewer.
    const pricing = await registry.readThread({
      backend: "codex",
      display: { resource: "pricing", limit: 100, deferPricingGates: true },
      includeTurns: false,
      threadId: THREAD_ID,
      viewOnly: true,
    });
    const totalRows = pricing.display?.pricingPage?.totalRows ?? 0;
    expect(accounting.replay.entries.map((entry) => entry.turn?.id).sort())
      .toEqual(loadedTurns.map((turn) => turn.id).sort());
    expect(pricing.display?.pricingPage?.rows).toHaveLength(Math.min(100, totalRows));
    expect(Boolean(pricing.display?.nextCursor)).toBe(totalRows > 100);
    vi.restoreAllMocks();
    return Object.fromEntries(Object.entries(builds).map(([name, spy]) => [name, spy.mock.calls.length]));
  }

  it("serves a renderer refresh with one display build per resource for a small and a large thread", async () => {
    const small = await measureRendererRefresh(20);
    const large = await measureRendererRefresh(2_000);
    expect(small).toEqual({ cardLists: 2, overlays: 2, tokenMiser: 2, toolAccounting: 2 });
    expect(large).toEqual(small);
  }, 60_000);

  function countPricingEmits(registry: DesktopBackendRegistry): Map<string, number> {
    const emits = new Map<string, number>();
    registry.onEvent((event) => {
      if (event.notification.method === "thread/pricing/updated") {
        const threadId = event.notification.params.threadId;
        emits.set(threadId, (emits.get(threadId) ?? 0) + 1);
      }
    });
    return emits;
  }

  it("still publishes the pricing it wrote when the gate persist fails", async () => {
    const stateDb = openInMemoryStateDb();
    cleanups.push(() => stateDb.close());
    const { internals, registry, store } = await setupThread({ historicalTurns: 3, stateDb });
    const emits = countPricingEmits(registry);
    let completedEvents = 0;
    registry.onEvent((event) => {
      if (event.notification.method === "turn/completed") {
        completedEvents += 1;
      }
    });
    vi.spyOn(
      registry as unknown as { flushPendingTokenMiserLedger(...args: unknown[]): Promise<boolean> },
      "flushPendingTokenMiserLedger",
    ).mockRejectedValue(new Error("gate persist failed"));

    await expect(endTurn(internals)).rejects.toThrow("gate persist failed");

    // The final usage line and its end time were written before the failure.
    expect(emits.get(THREAD_ID)).toBe(1);
    expect(completedEvents).toBe(0);
    const pricing = await store.readThreadPricing({ backend: "codex", threadId: THREAD_ID });
    const finalLine = pricing.lines.find((line) =>
      line.turnId === FINAL_TURN_ID && line.parentThreadId === undefined);
    expect(finalLine?.completedAt).toBeDefined();
  });

  it("publishes another thread's usage from the same flush on its own", async () => {
    const stateDb = openInMemoryStateDb();
    cleanups.push(() => stateDb.close());
    const { internals, registry, store } = await setupThread({ historicalTurns: 3, stateDb });
    const otherThreadId = "thread-other";
    await internals.emit({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: otherThreadId,
          turnId: "turn-other",
          turn: { id: "turn-other", status: "inProgress" },
        },
      } as AgentEvent["notification"],
    });
    await internals.emit({
      backend: "codex",
      notification: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: otherThreadId,
          turnId: "turn-other",
          model: PARENT_MODEL,
          tokenUsage: {
            last: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 20, totalTokens: 1_020 },
            total: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 20, totalTokens: 1_020 },
          },
        },
      } as AgentEvent["notification"],
    });
    const emits = countPricingEmits(registry);

    await endTurn(internals);

    expect(Object.fromEntries(emits)).toEqual({ [otherThreadId]: 1, [THREAD_ID]: 1 });
    const other = await store.readThreadPricing({ backend: "codex", threadId: otherThreadId });
    expect(other.lines.map((line) => line.turnId)).toEqual(["turn-other"]);
  });

  it("holds one turn end with new gates to its write budget", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-turn-end-writes-");
    const stateDb = StateDb.open(temp.dbPath);
    cleanups.push(() => removeTempStateDbDir(temp.tempDir));
    cleanups.push(() => stateDb.close());
    const { internals } = await setupThread({ historicalTurns: 2_000, stateDb });
    // Setup fills the WAL past auto-checkpoint; the turn end would then reuse
    // its pages without growing the file, and measure no bytes at all.
    stateDb.raw.pragma("wal_checkpoint(TRUNCATE)");

    const { writes } = await measureSqliteWrites(async () => {
      await endTurn(internals);
    });

    expectSqliteWriteBudget({
      note: "one Codex turn end on a 2,000-turn thread with 2,000 persisted gate cards and 5 new gates: final usage line, 5 keyed gate-card rows (the overlay row is not rewritten), gate usage lines",
      scenario: "codex-turn-end-with-token-miser-gates",
      writes,
    });
  }, 60_000);
});

function parentLine(turnId: string, index: number): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 0,
    cachedInputTokens: 4_000,
    completedAt: 1_800_000_000_000 + index * 1_000 + 500,
    createdAt: 1_800_000_000_000 + index * 1_000,
    currency: "USD",
    inputTokens: 10_000,
    model: PARENT_MODEL,
    outputCostMicros: 0,
    outputTokens: 100,
    priceStatus: "unpriced",
    provider: "openai",
    reasoningOutputTokens: 0,
    scope: "turn",
    serviceTier: "standard",
    source: "live",
    sourceItemId: "thread-token-usage",
    status: "finalized",
    threadId: THREAD_ID,
    totalCostMicros: 0,
    totalTokens: 10_100,
    turnId,
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 6_000,
    usageLineId: `parent:${turnId}`,
  };
}

function gateEntry(index: number, turnId: string): TokenMiserObjectMetadata {
  return {
    version: 1,
    objectId: `gate-${String(index).padStart(6, "0")}`,
    threadId: THREAD_ID,
    turnId,
    toolUseId: `tool-${index}`,
    toolName: "commandExecution",
    createdAt: 1_800_000_000_000 + index,
    originalCharacters: 12_000,
    baselineParentTokens: 3_000,
    replacementCharacters: 400,
    retrievedCharacters: 0,
    summary: {
      summary: "Large fixture result.",
      usefulDetails: [],
      suggestedNextStep: "Read a targeted range.",
    },
    helperUsage: {
      helperThreadId: `helper-thread-${index}`,
      helperTurnId: `helper-turn-${index}`,
      model: GATE_MODEL,
      reasoningEffort: "medium",
      tokenUsage: {
        inputTokens: 1_500,
        cachedInputTokens: 200,
        outputTokens: 80,
        totalTokens: 1_580,
      },
    },
    disposition: "summarized",
    replayTrackingVersion: 2,
    cachedReplayCount: 1,
    cachedBaselineTokens: 3_000,
    cachedRevealedTokens: 120,
  };
}
