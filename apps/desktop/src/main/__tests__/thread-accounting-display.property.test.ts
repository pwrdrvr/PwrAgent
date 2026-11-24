import fc from "fast-check";
import { expect, it, vi } from "vitest";
import {
  THREAD_DISPLAY_MAX_ACCOUNTING_TURNS,
  type AppServerReadThreadRequest,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { projectThreadDisplay } from "../app-server/thread-display";
import { readThreadForPeer } from "../federation/federation-owner-thread-reads";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { archiveCoordinatorStandIn } from "./helpers/archive-coordinator-stand-in";
import { usageLedgerStandIn } from "./helpers/usage-ledger-stand-in";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const thread = { backend: "codex", threadId: "parent" } as const;
const turn = { id: "loaded", status: "completed" } as const;
const request: AppServerReadThreadRequest = {
  ...thread, display: { resource: "accounting", turns: [turn] }, includeTurns: false, viewOnly: true,
};
const replay = { entries: [], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } };

function usage(id: string, overrides: Partial<ThreadUsageLineRecord> = {}): ThreadUsageLineRecord {
  return {
    ...thread, usageLineId: id, turnId: id, provider: "openai", scope: "turn", source: "live",
    status: "finalized", model: "gpt-5.5", priceStatus: "priced", pricingBasis: "provider-reported",
    createdAt: 1000, startedAt: 1001, completedAt: 1500, currency: "USD", turnUsageAttributed: true,
    inputTokens: 100, uncachedInputTokens: 80, cachedInputTokens: 20, outputTokens: 10,
    reasoningOutputTokens: 0, totalTokens: 110, uncachedInputCostMicros: 500,
    cachedInputCostMicros: 0, outputCostMicros: 100, totalCostMicros: 600, ...overrides,
  };
}

function makeRegistry(store: SqliteOverlayStore, options: {
  activeTurnId?: string;
  localModelIds?: string[];
  liveLines?: ThreadUsageLineRecord[];
  workerLines?: ThreadUsageLineRecord[];
} = {}) {
  const subAgentMonitorService = {
    liveCodexNativeSubAgentUsageRecords: new Map(options.workerLines ? [["parent", new Map([
      ["worker", { lines: new Map(options.workerLines.map((line) => [line.usageLineId, line])) }],
    ])]] : []),
  };
  const registry: DesktopBackendRegistry = Object.assign(Object.create(DesktopBackendRegistry.prototype), {
    overlayStore: store,
    threadArchiveCoordinator: archiveCoordinatorStandIn({ registry: () => registry, overlayStore: store }),
    assertNotBootstrap: () => {},
    resolveCodexLocalModelIdsFn: () => options.localModelIds ?? [],
    getActiveTurnForThread: () => options.activeTurnId ? { turnId: options.activeTurnId } : undefined,
    getThreadTranscriptImageRoots: async () => [],
  });
  const ledger = usageLedgerStandIn({
    registry: () => registry, overlayStore: store, subAgentMonitorService,
    usageLines: options.liveLines && new Map([[thread.threadId, new Map(options.liveLines.map((line) => [line.usageLineId, line]))]]),
  });
  Object.assign(registry, { threadUsageLedger: ledger, subAgentMonitorService });
  return { registry, ledger };
}

async function checkReadWork(unrelatedCount: number) {
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteOverlayStore(db);
    await store.upsertThreadUsageLines({ lines: [
      usage(turn.id),
      usage("child-loaded", { threadId: "child", parentThreadId: thread.threadId, turnId: turn.id }),
    ] });
    db.raw.prepare(`WITH RECURSIVE history(n) AS (
        SELECT 1 WHERE ? > 0 UNION ALL SELECT n + 1 FROM history WHERE n < ?
      )
      INSERT INTO thread_usage_lines (
        usage_line_id, backend, thread_id, parent_thread_id, turn_id,
        source, scope, status, created_at, updated_at, input_tokens, cached_input_tokens,
        uncached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
        price_status, currency, uncached_input_cost_micros, cached_input_cost_micros,
        output_cost_micros, total_cost_micros
      )
      SELECT 'old-' || n, 'codex',
        CASE n % 2 WHEN 0 THEN 'parent' ELSE 'child' END,
        CASE n % 2 WHEN 1 THEN 'parent' END, 'old-turn-' || n,
        'live', 'turn', 'finalized', 100, 100, 100, 0, 100, 10, 0, 110, 'priced', 'USD', 0, 0, 0, 0
      FROM history`).run(unrelatedCount, unrelatedCount);
    db.raw.exec("ANALYZE");
    const { registry } = makeRegistry(store);
    const prepare = db.raw.prepare.bind(db.raw);
    const reads: Array<{ rows: number; plan: string[] }> = [];
    const spy = vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!/\b(FROM|JOIN) thread_usage_lines\b/.test(sql)) return statement;
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
        const rows = all(...args);
        const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
          .map(({ detail }) => detail);
        reads.push({ rows: rows.length, plan });
        return rows;
      });
      return statement;
    });
    try {
      const result = await registry.readThread(request);
      expect(result.replay.entries.map(({ id }) => id)).toEqual(["live-turn-usage-loaded"]);
    } finally {
      spy.mockRestore();
    }
    // Both row materialization and index searches must stay scoped to the requested turn.
    expect(reads.map(({ rows }) => rows)).toEqual([2]);
    expect(reads.flatMap(({ plan }) => plan.filter((detail) => /^(SEARCH|SCAN) thread_usage_lines\b/.test(detail))))
      .toEqual([
        expect.stringMatching(/\(backend=\? AND thread_id=\? AND turn_id=\?\)/),
        expect.stringMatching(/\(backend=\? AND parent_thread_id=\? AND turn_id=\?\)/),
      ]);
  } finally {
    db.close();
  }
}

it("reads two matching rows with 1,000 unrelated historical turns", () => checkReadWork(1_000));

it("bounds accounting work by the requested turns as unrelated history grows", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 100, max: 2_000 }), checkReadWork), { numRuns: 20 });
});

it("matches full-ledger usage activities for local and federated reads", async () => {
  const turnIds = [
    "loaded", "child", "active", "fallback", "unattributed", "superseded", "monitor",
    "local", "replaced", "removed", "worker", "live-only", "missing", "unfinished",
  ];
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("codex" as const, "claude" as const),
    fc.shuffledSubarray(turnIds),
    fc.constantFrom("completed" as const, "failed" as const, "cancelled" as const, "interrupted" as const),
    fc.boolean(),
    async (backend, ids, status, live) => {
      const db = openInMemoryStateDb();
      try {
        const store = new SqliteOverlayStore(db);
        const localThread = { ...thread, backend };
        const stored = (id: string, overrides: Partial<ThreadUsageLineRecord> = {}) =>
          usage(id, { backend, ...overrides });
        await store.upsertThreadUsageLines({ lines: [
          stored("loaded", { parentThreadId: thread.threadId }),
          stored("loaded-backfill", { turnId: "loaded", source: "backfill", provider: "openrouter", createdAt: 900 }),
          stored("child", { threadId: "child", parentThreadId: thread.threadId }),
          stored("active"), stored("fallback", { completedAt: undefined, status: "pending" }),
          stored("unattributed", { turnUsageAttributed: false }),
          stored("superseded", { status: "superseded" }),
          stored("monitor", { scope: "monitor" }),
          stored("local", { model: "fixture-local" }),
          stored("replaced"), stored("removed"), stored("worker"), stored("unrequested"),
          stored("unfinished", { completedAt: undefined, status: "pending" }),
          stored("wrong-thread", { threadId: "other", turnId: "missing" }),
          stored("wrong-backend", { backend: backend === "codex" ? "claude" : "codex", turnId: "missing" }),
        ] });
        const { registry, ledger } = makeRegistry(store, {
          activeTurnId: "active",
          localModelIds: ["fixture-local"],
          liveLines: live ? [
            usage("replaced", { totalCostMicros: 9000 }),
            usage("removed", { turnUsageAttributed: false }),
            usage("live-only"),
          ] : undefined,
          workerLines: live
            ? [usage("worker", { threadId: "child", parentThreadId: thread.threadId, totalCostMicros: 8000 })]
            : undefined,
        });
        const turns = ids.map((id) => ({ id, status, ...(id === "fallback" ? { completedAt: 2000 } : {}) }));
        // A repeated turn carries its newest metadata. Some requested IDs have
        // only excluded rows or no stored usage at all.
        const demand: AppServerReadThreadRequest = {
          ...request, ...localThread,
          display: { resource: "accounting", turns: [{ ...turn, status: "in_progress" }, ...turns] },
        };
        const full = await ledger.readThreadPricingWithLiveTokenMiser(localThread);
        const expected = projectThreadDisplay({ ...localThread, fetchedAt: 0, pricing: full, replay }, demand, {
          activeTurnId: "active",
        });
        for (const actual of [await registry.readThread(demand), await readThreadForPeer(registry, demand)]) {
          expect({ ...actual, fetchedAt: 0 }).toEqual(expected);
        }
      } finally {
        db.close();
      }
    },
  ), { numRuns: 32, examples: [["codex", turnIds, "completed", true], ["codex", turnIds, "failed", false]] });
});

it("accepts a full accounting batch and rejects a larger one before the ledger read", async () => {
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteOverlayStore(db);
    await store.upsertThreadUsageLine({ line: usage(turn.id) });
    const { registry } = makeRegistry(store);
    const turns = Array.from({ length: THREAD_DISPLAY_MAX_ACCOUNTING_TURNS }, (_, index) =>
      index === 0 ? turn : { ...turn, id: `absent-${index}` });
    const read = vi.spyOn(store, "readThreadTurnUsageLines");
    const selected = await readThreadForPeer(registry, { ...request, display: { resource: "accounting", turns } });
    expect(selected.replay.entries.map(({ id }) => id)).toEqual(["live-turn-usage-loaded"]);
    await expect(registry.readThread({ ...request, display: { resource: "accounting", turns: [...turns, turn] } }))
      .rejects.toThrow("Too many display turns in one request.");
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    db.close();
  }
});

it.each([9, 10])("matches the legacy repricing barrier with %i newer unpriceable rows", async (count) => {
  async function read(fullLedger: boolean) {
    const db = openInMemoryStateDb();
    try {
      const store = new SqliteOverlayStore(db);
      const createdAt = Date.UTC(2026, 10, 1);
      await store.upsertThreadUsageLines({ lines: [
        usage(turn.id, { createdAt, startedAt: createdAt, completedAt: createdAt + 1000 }),
        ...Array.from({ length: count }, (_, i) => usage(`unknown-${i}`, {
          threadId: "child", parentThreadId: thread.threadId, model: "fixture-unknown",
          createdAt: createdAt + 2000 + i, priceStatus: "unpriced",
        })),
      ] });
      // A ledger written before this model's rates were available.
      db.raw.prepare(`UPDATE thread_usage_lines SET price_status = 'unpriced', pricing_basis = NULL,
        total_cost_micros = 0 WHERE usage_line_id = ?`).run(turn.id);
      const { registry, ledger } = makeRegistry(store);
      const response = fullLedger
        ? projectThreadDisplay({ ...thread, fetchedAt: 0, pricing: await ledger.readThreadPricingWithLiveTokenMiser(thread), replay }, request)
        : await readThreadForPeer(registry, request);
      const price = db.raw.prepare("SELECT price_status FROM thread_usage_lines WHERE usage_line_id = ?").pluck().get(turn.id);
      return { replay: response.replay, price };
    } finally {
      db.close();
    }
  }
  const expected = await read(true);
  // The first batch must make progress before the next batch can retry.
  expect(expected.price).toBe(count === 9 ? "priced" : "unpriced");
  expect(await read(false)).toEqual(expected);
});
