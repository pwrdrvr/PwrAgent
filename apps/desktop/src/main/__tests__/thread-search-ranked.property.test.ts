import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import fc from "fast-check";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { ThreadSearchStore } from "../storage/thread-search-store";
import { seedSearchThreads } from "./helpers/thread-search-fixture";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const projection: Pick<AppServerThreadSummary, "source" | "titleSource" | "linkedDirectories"> = {
  source: "codex",
  titleSource: "explicit",
  linkedDirectories: [],
};

it("keeps all-term matches ahead of partial matches and applies scope before filling the limit", () => {
  const db = openInMemoryStateDb();
  try {
    const store = new ThreadSearchStore(db);
    fc.assert(fc.property(fc.shuffledSubarray(["orchard", "lantern", "willow"], { minLength: 3 }),
      fc.boolean(), fc.boolean(), (words, quotePhrase, reverse) => {
        db.raw.exec("DELETE FROM thread_search_fts; DELETE FROM thread_search_fts_rows; DELETE FROM thread_search_documents");
        const [first, second, third] = words;
        const query = quotePhrase ? `"${first} ${second}" ${third}` : words.join(" ");
        const rows = [
          { id: "full", title: words.join(" "), updatedAt: 1 },
          { id: "partial", title: `${first} ${second}`, updatedAt: 2 },
          { id: "excluded", title: words.join(" "), updatedAt: 3 },
          { id: "archived", title: words.join(" "), updatedAt: 4, archivedAt: 5 },
          { id: "wrong", title: quotePhrase ? `${first} beside ${second} ${third}` : "clear sky", updatedAt: 5 },
        ].map((row) => ({ ...row, ...projection }));
        store.upsertThreads(reverse ? rows.reverse() : rows);
        const identityKeys = ["codex:full", "codex:partial", "codex:archived", "codex:wrong"];
        const results = store.search({ query, identityKeys, limit: 2 });
        expect(results.map((result) => result.threadId)).toEqual(["full", "partial"]);
        expect(results[0].score).toBeGreaterThan(results[1].score);
        expect(store.search({ query, identityKeys, limit: 1 })).toEqual(results.slice(0, 1));
      }), { numRuns: 30 });
  } finally {
    db.close();
  }
});

it("recovers one-edit spelling mistakes while keeping quoted terms literal", () => {
  const db = openInMemoryStateDb();
  try {
    const store = new ThreadSearchStore(db);
    store.upsertThreads([
      { ...projection, id: "target", title: "lantern", updatedAt: 1 },
      { ...projection, id: "distant", title: "pattern", updatedAt: 2 },
    ]);
    fc.assert(fc.property(fc.integer({ min: 0, max: 5 }),
      fc.constantFrom("delete", "insert", "substitute", "transpose"), (index, edit) => {
        const original = "lantern";
        const before = original.slice(0, index);
        const after = original.slice(index + 1);
        const letter = original[index];
        const query = before + ({
          delete: after,
          insert: "x" + letter + after,
          substitute: "x" + after,
          transpose: after[0] + letter + after.slice(1),
        }[edit]);
        // The original prefix search already recognizes a final truncation,
        // which is why the generator edits an interior letter or two.
        expect(store.search({ query, limit: 5 }).map((result) => result.threadId)).toEqual(["target"]);
        expect(store.search({ query: `"${query}"`, limit: 5 })).toEqual([]);
      }), { numRuns: 30 });
  } finally {
    db.close();
  }
});

it("ranks a corrected query above a one-term match, with each thread returned once", () => {
  const db = openInMemoryStateDb();
  try {
    const store = new ThreadSearchStore(db);
    store.upsertThreads([
      { ...projection, id: "corrected", title: "lantern willow", updatedAt: 1 },
      { ...projection, id: "partial", title: "willow willow willow", updatedAt: 2 },
    ]);
    const results = store.search({ query: "lanetrn willow", limit: 2 });
    expect(results.map((result) => result.threadId)).toEqual(["corrected", "partial"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  } finally {
    db.close();
  }
});

it.each([1000, 2000, 4000, 8000])("opens one ranked MATCH cursor for %i visible matching threads", (n) => {
  const db = openInMemoryStateDb();
  try {
    const store = new ThreadSearchStore(db);
    const threads = Array.from({ length: n }, (_, i) => ({ id: `match-${i}`, source: "codex" as const,
      title: "Needle matching title", titleSource: "explicit" as const, updatedAt: i + 1, linkedDirectories: [] }));
    seedSearchThreads(db, threads);
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
    const matchOpens = new Map<string, number>();
    db.raw.function("ranked_match_probe", (query: string) => {
      matchOpens.set(query, (matchOpens.get(query) ?? 0) + 1);
      return query;
    });
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
      matchOpens.clear();
      expect(store.search({ query: "Needle", includeArchived, identityKeys: [...identityKeys, ...identityKeys], limit })).toEqual(oracle);
      expect([...matchOpens.values()].every((opens) => opens === 1)).toBe(true);
      expect(matchOpens.size).toBeLessThanOrEqual(oracle.length > 0 ? 1 : 2);
    }), { numRuns: 30 });
  } finally { db.close(); }
});
