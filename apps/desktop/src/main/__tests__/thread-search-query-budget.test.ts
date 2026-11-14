import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { ThreadSearchStore } from "../storage/thread-search-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

import { seedSearchUsage } from "./helpers/thread-search-fixture";

it.each([100, 1000, 10000].flatMap((n) => [false, true].map((analyzed) => ({ n, analyzed }))))("budgets deletion queries against $n rows (ANALYZE: $analyzed)", ({ n, analyzed }) => {
  const db = openInMemoryStateDb();
  try {
    const store = new ThreadSearchStore(db);
    store.upsertThreads(Array.from({ length: n }, (_, i) => ({ id: `document-${i}`, source: "codex" as const,
      title: `Needle ${i}`, titleSource: "explicit" as const, linkedDirectories: [] })));
    seedSearchUsage(db, n);
    // Both direct and automation execution checks must retain superseded-only
    // usage, across providers. This is a title-history predicate, not billing.
    for (const id of ["execution-1", "owner-1", "absent"]) store.upsertThread({ id,
      source: "codex", title: `Needle ${id}`, titleSource: "explicit", linkedDirectories: [] });
    if (analyzed) db.raw.exec("ANALYZE");
    const prepare = db.raw.prepare.bind(db.raw);
    const queries: Array<{ sql: string; plans: string[]; ms: number }> = [];
    vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
      const stmt = prepare(sql);
      if (!/^\s*(DELETE|INSERT)/.test(sql)) return stmt;
      const run = stmt.run.bind(stmt);
      stmt.run = (...args: unknown[]) => {
        const plans = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail);
        const start = performance.now();
        const result = run(...args);
        queries.push({ sql, plans, ms: performance.now() - start });
        return result;
      };
      return stmt;
    });
    for (const id of ["execution-1", "owner-1", "absent"]) store.deleteThread({ backend: "codex", threadId: id });
    if (process.env.THREAD_SEARCH_BENCHMARK) console.log(JSON.stringify({ n, analyzed, sqlite: prepare("SELECT sqlite_version()").pluck().get(),
      queries: queries.map((q) => ({ table: q.sql.match(/(?:INTO|FROM) (\w+)/)?.[1], plans: q.plans, ms: q.ms })) }));
    for (const q of queries.filter((q) => q.sql.includes("DELETE FROM thread_search_fts WHERE"))) {
      expect(q.plans.some((p) => /VIRTUAL TABLE INDEX \d+:=/.test(p))).toBe(true);
      expect(q.plans.some((p) => /SEARCH thread_search_fts_rows USING COVERING INDEX/.test(p))).toBe(true);
    }
    for (const q of queries.filter((q) => q.sql.includes("INSERT INTO thread_usage_titles"))) {
      expect(q.plans.join("\n")).toContain("SEARCH thread_usage_lines USING COVERING INDEX idx_thread_usage_lines_identity (backend=? AND thread_id=?)");
      expect(q.plans.join("\n")).toContain("SEARCH l USING COVERING INDEX idx_thread_usage_lines_identity (backend=? AND thread_id=?)");
      expect(q.plans.join("\n")).toMatch(/SEARCH r USING INDEX idx_automation_runs_/);
      expect(q.plans.join("\n")).not.toMatch(/SCAN (thread_usage_lines|l|r)\b/);
    }
    expect(queries).toHaveLength(12);
    expect(prepare("SELECT identity_key FROM thread_usage_titles ORDER BY identity_key").pluck().all()).toEqual(["codex:execution-1", "codex:owner-1"]);
  } finally { db.close(); }
});

it.each([100, 1000, 10000])("uses inventory-key seeks before matching/limiting search with %i omitted matches", (n) => {
  const db = openInMemoryStateDb();
  try {
    const store = new ThreadSearchStore(db);
    store.upsertThreads(Array.from({ length: n }, (_, i) => ({ id: `old-${i}`, source: "codex" as const,
      title: "Needle", titleSource: "explicit" as const, linkedDirectories: [] })));
    store.upsertThread({ id: "current", source: "codex", title: "Needle current", titleSource: "explicit", linkedDirectories: [] });
    db.raw.exec("ANALYZE");
    const prepare = db.raw.prepare.bind(db.raw);
    const plans: string[][] = [];
    let calls = 0;
    vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
      const stmt = prepare(sql);
      const all = stmt.all.bind(stmt);
      stmt.all = (...args: unknown[]) => {
        calls++;
        plans.push((prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail));
        return all(...args);
      };
      return stmt;
    });
    for (const query of [undefined, "Needle"]) {
      expect(store.search({ query, limit: 1, identityKeys: ["codex:current", "codex:current"] }).map((r) => r.threadId)).toEqual(["current"]);
      expect(store.search({ query, limit: 1, identityKeys: [] })).toEqual([]);
    }
    expect(calls).toBe(4);
    for (const plan of plans) {
      expect(plan.join("\n")).toMatch(/SEARCH d USING INDEX .* \(identity_key=\?\)/);
      expect(plan.join("\n")).not.toMatch(/SCAN d\b/);
    }
    for (const plan of [plans[2], plans[3]]) {
      expect(plan.join("\n")).toMatch(/VIRTUAL TABLE INDEX \d+:.*=/);
      expect(plan.join("\n")).toMatch(/SEARCH k USING COVERING INDEX .* \(identity_key=\?\)/);
    }
  } finally { db.close(); }
});

it.each([100, 1000, 10000])("inspects at most 64 documents per maintenance slice even when all %i are retained", (n) => {
  const db = openInMemoryStateDb();
  try {
    const store = new ThreadSearchStore(db);
    const threads = Array.from({ length: n }, (_, i) => ({ id: `keep-${i}`, source: "codex" as const,
      title: "Needle", titleSource: "explicit" as const, linkedDirectories: [] }));
    store.upsertThreads(threads);
    const prepare = db.raw.prepare.bind(db.raw);
    let reads = 0;
    let visited = 0;
    vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
      const stmt = prepare(sql);
      const all = stmt.all.bind(stmt);
      stmt.all = (...args: unknown[]) => {
        reads++;
        const rows = all(...args);
        visited += rows.length;
        expect(rows.length).toBeLessThanOrEqual(64);
        const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join("\n");
        expect(plan).toMatch(/SEARCH thread_search_documents USING INDEX .* \(identity_key>\?\)/);
        return rows;
      };
      return stmt;
    });
    for (let i = 0; i < 10; i++) store.pruneMissingThreads({ includeArchived: true,
      retainedIdentityKeys: threads.map((t) => `codex:${t.id}`) });
    expect(reads).toBe(10);
    expect(visited).toBeLessThanOrEqual(640);
    expect(prepare("SELECT count(*) FROM thread_search_documents").pluck().get()).toBe(n);
  } finally { db.close(); }
});

it("allocates FTS keys with an indexed maximum and a descending LIMIT 1 cursor", () => {
  const db = openInMemoryStateDb();
  try {
    const store = new ThreadSearchStore(db);
    const prepare = vi.spyOn(db.raw, "prepare");
    store.upsertThread({ id: "new", source: "codex", title: "Needle", titleSource: "explicit", linkedDirectories: [] });
    const sql = prepare.mock.calls.map(([sql]) => sql).find((sql) => sql.includes("INSERT INTO thread_search_fts_rows"));
    prepare.mockRestore();
    expect(sql).toBeDefined();
    const plans = (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("codex:next", "codex:next") as Array<{ detail: string }>).map((r) => r.detail).join("\n");
    expect(plans).toContain("SEARCH thread_search_fts_rows");
    expect(plans).not.toContain("USE TEMP B-TREE");
    expect(plans).toMatch(/SCAN thread_search_fts VIRTUAL TABLE INDEX [1-9]\d*:/);
  } finally { db.close(); }
});
