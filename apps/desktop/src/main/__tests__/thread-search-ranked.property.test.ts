import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import fc from "fast-check";
import { ThreadSearchStore } from "../storage/thread-search-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

it.each([1000, 2000, 4000, 8000])("opens one ranked MATCH cursor for %i visible matching threads", (n) => {
  const db = openInMemoryStateDb();
  try {
    const store = new ThreadSearchStore(db);
    const threads = Array.from({ length: n }, (_, i) => ({ id: `match-${i}`, source: "codex" as const,
      title: "Needle matching title", titleSource: "explicit" as const, updatedAt: i + 1, linkedDirectories: [] }));
    store.upsertThreads(threads);
    let matchOpens = 0;
    // A value-preserving, non-deterministic RHS marks each FTS cursor opening.
    // Counting SQL preparations alone cannot see repeated native MATCH setup.
    db.raw.function("ranked_match_probe", (query: string) => { matchOpens++; return query; });
    const prepare = db.raw.prepare.bind(db.raw);
    vi.spyOn(db.raw, "prepare").mockImplementation((sql) => prepare(sql.replace(
      "thread_search_fts MATCH @query", "thread_search_fts MATCH ranked_match_probe(@query)",
    )));
    const start = performance.now();
    const results = store.search({ query: "Needle", identityKeys: threads.map((t) => `codex:${t.id}`), limit: 10 });
    const ms = performance.now() - start;
    if (process.env.THREAD_SEARCH_BENCHMARK) console.log(JSON.stringify({ rankedVisible: n, matchOpens, ms }));
    expect(results.map((r) => r.threadId)).toEqual(threads.slice(-10).reverse().map((t) => t.id));
    expect(matchOpens).toBe(1);
  } finally { db.close(); }
});

it("matches the full ranked-result oracle filtered by inventory before taking the limit", () => {
  const db = openInMemoryStateDb();
  try {
    const store = new ThreadSearchStore(db);
    let matchOpens = 0;
    db.raw.function("ranked_match_probe", (query: string) => { matchOpens++; return query; });
    const prepare = db.raw.prepare.bind(db.raw);
    vi.spyOn(db.raw, "prepare").mockImplementation((sql) => prepare(sql.replace(
      "thread_search_fts MATCH @query", "thread_search_fts MATCH ranked_match_probe(@query)",
    )));
    fc.assert(fc.property(fc.array(fc.record({ visible: fc.boolean(), strong: fc.boolean(), archived: fc.boolean(),
      backend: fc.constantFrom("codex" as const, "acp:gemini" as const),
    }), { minLength: 2, maxLength: 50, size: "max" }), fc.boolean(), fc.integer({ min: 1, max: 10 }),
    (rows, includeArchived, limit) => {
      db.raw.exec("DELETE FROM thread_search_fts; DELETE FROM thread_search_fts_rows; DELETE FROM thread_search_documents");
      const threads = rows.map((row, i) => ({ id: `session:α%/${i}`, source: row.backend,
        title: row.strong ? "Needle Needle Needle" : "Needle with many other words", titleSource: "explicit" as const,
        updatedAt: i + 1, linkedDirectories: [], ...(row.archived ? { archivedAt: 200 } : {}) }));
      store.upsertThreads(threads);
      const identityKeys = threads.filter((_, i) => rows[i].visible).map((t) => `${t.source}:${t.id}`);
      const visible = new Set(identityKeys);
      const oracle = store.search({ query: "Needle", includeArchived, limit: rows.length })
        .filter((r) => visible.has(r.identityKey)).slice(0, limit);
      matchOpens = 0;
      expect(store.search({ query: "Needle", includeArchived, identityKeys: [...identityKeys, ...identityKeys], limit })).toEqual(oracle);
      expect(matchOpens).toBeLessThanOrEqual(1);
    }), { numRuns: 30 });
  } finally { db.close(); }
});
