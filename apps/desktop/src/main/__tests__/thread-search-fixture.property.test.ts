import { expect, it, vi } from "vitest";
import fc from "fast-check";
import type { AppServerBackendKind, AppServerThreadSummary } from "@pwragent/shared";
import type { StateDb } from "../state/state-db";
import { ThreadSearchStore } from "../storage/thread-search-store";
import { seedSearchThreads } from "./helpers/thread-search-fixture";
import { openInMemoryStateDb } from "./sqlite-test-utils";

it("compiles fixture SQL once while preserving the uncached store's documents, FTS and ranking", () => {
  const baseline = openInMemoryStateDb();
  const fixture = openInMemoryStateDb();
  const now = vi.spyOn(Date, "now").mockReturnValue(100);
  const totals = { baseline: 0, fixture: 0 };
  try {
    fc.assert(fc.property(fc.array(fc.record({
      backend: fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:gemini"),
      title: fc.string({ maxLength: 20 }),
      archived: fc.boolean(),
      directory: fc.boolean(),
    }), { minLength: 2, maxLength: 8, size: "max" }), (rows) => {
      for (const db of [baseline, fixture]) {
        db.raw.exec("DELETE FROM thread_search_documents; DELETE FROM thread_search_fts; DELETE FROM thread_search_fts_rows");
      }
      const threads: AppServerThreadSummary[] = rows.map((row, i) => ({
        id: `session:α%/${i}`, source: row.backend,
        title: `Needle ${row.title}`, titleSource: "explicit", summary: `Summary ${i}`,
        projectKey: `project-${i % 2}`, createdAt: i, updatedAt: 100 + i,
        archivedAt: row.archived ? 50 : undefined, gitBranch: `branch-${i}`,
        gitOriginUrl: "https://example.com/fixture.git", model: "fixture-model",
        linkedDirectories: row.directory ? [{ id: `dir-${i}`, label: `Directory ${i}`,
          path: `/fixture/${i}`, worktreePath: `/fixture/worktree/${i}`, kind: "local" }] : [],
      }));
      const originalStore = new ThreadSearchStore(baseline);
      // Initial inserts, unchanged rows and replacements must all agree with
      // the production store. The unchanged batch must still make no writes.
      for (const batch of [threads, threads, threads.map((thread) => ({
        ...thread, title: `Revised ${thread.title}`,
      }))]) {
        const oldSources = preparations(baseline, () => originalStore.upsertThreads(batch));
        const sources = preparations(fixture, () => seedSearchThreads(fixture, batch));
        // Negative control: the exact pre-fix setup recompiles SQL per row,
        // violating this same compile-once property on every generated input.
        expect(oldSources.length).toBeGreaterThan(new Set(oldSources).size);
        expect(sources.length).toBe(new Set(sources).size);
        expect(new Set(sources)).toEqual(new Set(oldSources));
        totals.baseline += oldSources.length;
        totals.fixture += sources.length;
        for (const sql of [
          "SELECT * FROM thread_search_documents ORDER BY identity_key",
          "SELECT * FROM thread_search_fts_rows ORDER BY identity_key",
          "SELECT rowid, * FROM thread_search_fts ORDER BY rowid",
          "SELECT total_changes()",
        ]) {
          expect(fixture.raw.prepare(sql).all()).toEqual(baseline.raw.prepare(sql).all());
        }
        for (const query of [undefined, "Needle", "Revised", "Summary", "Directory"]) {
          expect(new ThreadSearchStore(fixture).search({ query, includeArchived: true, limit: 100 }))
            .toEqual(originalStore.search({ query, includeArchived: true, limit: 100 }));
        }
      }
    }), { numRuns: 25 });
    if (process.env.CI || process.env.THREAD_SEARCH_BENCHMARK) {
      console.log(JSON.stringify({ oracle: "search fixture native SQL compilation", ...totals }));
    }
  } finally {
    now.mockRestore();
    baseline.close();
    fixture.close();
  }
});

it("restores native preparation and rolls back when fixture SQL fails", () => {
  const db = openInMemoryStateDb();
  try {
    db.raw.exec(`CREATE TRIGGER reject_fixture BEFORE INSERT ON thread_search_documents
      BEGIN SELECT RAISE(ABORT, 'fixture write rejected'); END`);
    const prepare = db.raw.prepare;
    expect(() => seedSearchThreads(db, [{ id: "rejected", source: "codex",
      title: "Needle", titleSource: "explicit", linkedDirectories: [] }])).toThrow("fixture write rejected");
    expect(db.raw.prepare).toBe(prepare);
    expect(db.raw.prepare("SELECT count(*) FROM thread_search_documents").pluck().get()).toBe(0);
    expect(db.raw.inTransaction).toBe(false);
  } finally { db.close(); }
});

function preparations(db: StateDb, work: () => void): string[] {
  const prepare = vi.spyOn(db.raw, "prepare");
  try {
    work();
    return prepare.mock.calls.map(([sql]) => sql);
  } finally { prepare.mockRestore(); }
}
