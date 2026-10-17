import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { attachSqliteWriteMetrics, isSqliteWriteMetricsEnabled, measureSqliteWrites } from "../state/sqlite-write-metrics";
import type { TokenMiserDiagnosticContext } from "../token-miser/token-miser-diagnostics";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

type FixtureLine = {
  id: string;
  thread?: string;
  parent?: string | null;
  backend?: string;
  scope?: string;
  status?: string;
  createdAt?: number;
  model?: string | null;
  provider?: string;
  reasoning?: string | null;
  tier?: string | null;
  priceStatus?: string;
};

// Raw fixture inserts keep setup independent of pricing repair and lifecycle
// writers. Resolution itself always goes through the production registry/store.
function seed(db: StateDb, lines: FixtureLine[]) {
  const insert = db.raw.prepare(`
    INSERT INTO thread_usage_lines
      (usage_line_id, usage_turn_id, backend, thread_id, parent_thread_id,
       source, scope, status, created_at, model, provider, reasoning_effort,
       service_tier, input_tokens, cached_input_tokens, uncached_input_tokens,
       output_tokens, reasoning_output_tokens, total_tokens, price_status,
       currency, uncached_input_cost_micros, cached_input_cost_micros,
       output_cost_micros, total_cost_micros, updated_at)
    VALUES (@id, @id, @backend, @thread, @parent, 'live', @scope, @status,
      @createdAt, @model, @provider, @reasoning, @tier, 10, 0, 10, 2, 0, 12,
      @priceStatus, 'USD', 0, 0, 0, 0, @createdAt)
  `);
  const turn = db.raw.prepare(`
    INSERT INTO thread_usage_turns
      (usage_turn_id, provider, backend, thread_id, parent_thread_id,
       started_at, observed_at, updated_at)
    VALUES (@id, @provider, @backend, @thread, @parent, @createdAt, @createdAt, @createdAt)
  `);
  db.raw.transaction(() => {
    for (const line of lines) {
      const values = {
        thread: "parent", parent: null, backend: "codex", scope: "turn",
        status: "finalized", createdAt: 100, model: "fixture-model",
        provider: "openai", reasoning: "high", tier: "priority",
        priceStatus: "priced", ...line,
      };
      insert.run(values);
      turn.run(values);
    }
  })();
}

function observeReads(db: StateDb) {
  const reads: Array<{ sql: string; rows: number; bytes: number; bindings: unknown[] }> = [];
  const prepare = db.raw.prepare.bind(db.raw);
  const spy = vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "all" || property === "get") {
          return (...bindings: unknown[]) => {
            const result = Reflect.apply(value, target, bindings);
            const rows: unknown[] = property === "all" && Array.isArray(result)
              ? result : result === undefined ? [] : [result];
            reads.push({ sql, rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)), bindings });
            return result;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  return { reads, restore: () => spy.mockRestore() };
}

describe("Token Miser parent model resolution", () => {
  let db: StateDb;
  let store: SqliteOverlayStore;
  let registry: DesktopBackendRegistry;
  let tempDir: string | undefined;

  beforeEach(() => {
    db = openInMemoryStateDb();
    store = new SqliteOverlayStore(db);
    registry = new DesktopBackendRegistry({
      codexClient: {
        close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [], onNotification: () => () => {},
        onPendingRequest: () => () => {},
      } as never,
      overlayStore: store,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await registry.close();
    db.close();
    if (tempDir) removeTempStateDbDir(tempDir);
    tempDir = undefined;
  });

  function resolve() {
    return (registry as unknown as {
      resolveTokenMiserParentModel(threadId: string): Promise<TokenMiserDiagnosticContext | undefined>;
    }).resolveTokenMiserParentModel("parent");
  }

  async function legacySelection() {
    const { lines } = await store.readThreadPricing({ backend: "codex", threadId: "parent" });
    const line = lines.filter((entry) => entry.scope !== "monitor" && Boolean(entry.model))
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    return line ? {
      model: line.model, provider: line.provider, reasoningEffort: line.reasoningEffort,
      ...(line.serviceTier ? { serviceTier: line.serviceTier } : {}),
    } : undefined;
  }

  it.each([10, 1000, 10000])("bounds production reads with %s historical lines and turns", async (size) => {
    seed(db, Array.from({ length: size }, (_, index) => ({
      id: `history-${index}`, createdAt: index,
      thread: index % 2 ? "child" : "parent", parent: index % 2 ? "parent" : null,
    })));
    seed(db, [{ id: "latest", createdAt: size + 1 }]);
    const pricing = vi.spyOn(store, "readThreadPricing");
    const observation = observeReads(db);
    expect(await resolve()).toEqual({
      model: "fixture-model", provider: "openai", reasoningEffort: "high", serviceTier: "priority",
    });
    observation.restore();
    const totals = {
      size, queries: observation.reads.length,
      rows: observation.reads.reduce((sum, read) => sum + read.rows, 0),
      bytes: observation.reads.reduce((sum, read) => sum + read.bytes, 0),
      pricingReads: pricing.mock.calls.length,
      turnReads: observation.reads.filter((read) => read.sql.includes("FROM thread_usage_turns")).length,
    };
    console.info("parent-model read budget", JSON.stringify(totals));
    expect(totals).toMatchObject({ queries: 1, rows: 1, pricingReads: 0, turnReads: 0 });
    expect(totals.bytes).toBeLessThanOrEqual(256);
    const [read] = observation.reads;
    const plan = db.raw.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.bindings) as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes("idx_thread_usage_lines_read_thread"))).toBe(true);
    expect(plan.some(({ detail }) => detail.includes("idx_thread_usage_lines_read_parent"))).toBe(true);
    expect(plan.filter(({ detail }) => /SCAN thread_usage_lines|USE TEMP B-TREE/.test(detail))).toEqual([]);
  });

  it("preserves selection and field normalization across both ledger branches", async () => {
    expect(await resolve()).toBeUndefined();
    const cases: FixtureLine[] = [
      { id: "initial", model: null },
      { id: "empty", model: "", createdAt: 200 },
      { id: "old", createdAt: 1 },
      { id: "new-monitor", scope: "monitor", createdAt: 900 },
      { id: "new-superseded", status: "superseded", createdAt: 900 },
      { id: "other-backend", backend: "acp:qwen", createdAt: 900 },
      { id: "unrelated", thread: "other", createdAt: 900 },
      { id: "pending-child", thread: "child", parent: "parent", status: "pending", createdAt: 20 },
      { id: "a-tie", createdAt: 20, model: "a-tie" },
      { id: "z-tie", parent: "parent", createdAt: 20, model: "z-tie" },
      { id: "unpriced", priceStatus: "unpriced", createdAt: 30, provider: "fixture-provider" },
      { id: "fork", scope: "fork-baseline", createdAt: 40, model: " ", provider: "", reasoning: "", tier: "" },
      { id: "null-fields", createdAt: 50, reasoning: null, tier: null },
    ];
    for (const line of cases) {
      seed(db, [line]);
      expect(await resolve(), line.id).toEqual(await legacySelection());
    }
    expect(await resolve()).toEqual({ model: "fixture-model", provider: "openai", reasoningEffort: undefined });
  });

  it("keeps rejected candidates inside SQLite even when no eligible model exists", async () => {
    seed(db, Array.from({ length: 10000 }, (_, index) => ({
      id: `ineligible-${index}`, createdAt: index + 1,
      thread: index % 2 ? "child" : "parent", parent: index % 2 ? "parent" : null,
      ...(index % 3 === 0 ? { scope: "monitor" } : { model: index % 3 === 1 ? "" : null }),
    })));
    const observation = observeReads(db);
    expect(await resolve()).toBeUndefined();
    expect(observation.reads).toHaveLength(1);
    expect(observation.reads[0]).toMatchObject({ rows: 0, bytes: 2 });
    observation.restore();
    seed(db, [{ id: "old-eligible", createdAt: 0 }]);
    const withCandidate = observeReads(db);
    expect((await resolve())?.model).toBe("fixture-model");
    expect(withCandidate.reads).toHaveLength(1);
    expect(withCandidate.reads[0].rows).toBe(1);
    expect(withCandidate.reads[0].bytes).toBeLessThanOrEqual(256);
    withCandidate.restore();
  });

  it("does not repair prices or write when resolving an unpriced model", async () => {
    db.close();
    const temp = createTempStateDb("pwragent-parent-model-read-only-");
    tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath);
    store = new SqliteOverlayStore(db);
    Object.assign(registry, { overlayStore: store });
    seed(db, [{ id: "unpriced", model: "gpt-6-astra", createdAt: Date.UTC(2026, 9, 17), priceStatus: "unpriced" }]);
    if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: db.raw, dbPath: db.raw.name });
    const { result, writes } = await measureSqliteWrites(resolve);
    expect(result?.model).toBe("gpt-6-astra");
    expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 });
    expect(db.raw.prepare("SELECT price_status FROM thread_usage_lines WHERE usage_line_id = 'unpriced'").get())
      .toEqual({ price_status: "unpriced" });
  });

  it("keeps native review precedence without reading the ledger", async () => {
    const records = new Map([
      ["other-thread", { mode: "native", reviewThreadId: "other", model: "other" }],
      ["non-native", { mode: "managed", reviewThreadId: "parent", model: "managed" }],
      ["no-model", { mode: "native", reviewThreadId: "parent", model: "" }],
      ["review", { mode: "native", reviewThreadId: "parent", model: "review-model", reasoningEffort: "high", serviceTier: "priority" }],
      ["later-review", { mode: "native", reviewThreadId: "parent", model: "later" }],
    ]);
    Object.assign(registry, { activeReviewSubAgents: records });
    const observation = observeReads(db);
    expect(await resolve()).toEqual({ model: "review-model", reasoningEffort: "high", serviceTier: "priority" });
    expect(observation.reads).toEqual([]);
    observation.restore();
    records.clear();
    expect(await resolve()).toBeUndefined();
  });

  it("sees other connections' commits, rollbacks and deletions without a stale cache", async () => {
    db.close();
    const temp = createTempStateDb("pwragent-parent-model-");
    tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath);
    store = new SqliteOverlayStore(db);
    Object.assign(registry, { overlayStore: store });
    const writer = StateDb.open(temp.dbPath);
    try {
      seed(writer, [{ id: "old", model: "old" }]);
      expect((await resolve())?.model).toBe("old");
      writer.raw.exec("BEGIN");
      seed(writer, [{ id: "new", model: "new", thread: "child", parent: "parent", createdAt: 200 }]);
      expect((await resolve())?.model).toBe("old");
      writer.raw.exec("COMMIT");
      expect((await resolve())?.model).toBe("new");
      writer.raw.exec("BEGIN");
      writer.raw.prepare("UPDATE thread_usage_lines SET model = 'rolled-back' WHERE usage_line_id = 'new'").run();
      writer.raw.exec("ROLLBACK");
      expect((await resolve())?.model).toBe("new");
      writer.raw.prepare("UPDATE thread_usage_lines SET status = 'superseded' WHERE usage_line_id = 'new'").run();
      expect((await resolve())?.model).toBe("old");
      writer.raw.prepare("DELETE FROM thread_usage_lines WHERE usage_line_id = 'old'").run();
      expect(await resolve()).toBeUndefined();
    } finally {
      writer.close();
    }
  });
});
