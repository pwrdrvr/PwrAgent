import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { buildThreadSearchFtsQuery } from "../thread-search/thread-search-fts-query";
import { ThreadSearchStore } from "../thread-search/thread-search-store";

let stateDb: StateDb;
let store: ThreadSearchStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-thread-search-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new ThreadSearchStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ThreadSearchStore", () => {
  it("creates metadata and FTS tables without transcript columns", () => {
    const tables = stateDb.raw
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE name IN ('thread_search_documents', 'thread_search_fts')
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual([
      "thread_search_documents",
      "thread_search_fts",
    ]);

    const columns = stateDb.raw
      .prepare("PRAGMA table_info(thread_search_documents)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("transcript");
    expect(columns.map((column) => column.name)).not.toContain("messages");
  });

  it("upserts and searches compact thread projections", () => {
    store.upsertThread(threadSummary({ id: "thread-1", title: "Branch drift screenshots" }));
    store.upsertThread(
      threadSummary({
        id: "thread-2",
        title: "Release notes",
        summary: "Prepared release copy",
      }),
    );

    const results = store.search({ query: "branch drift", limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      title: "Branch drift screenshots",
      projectKey: "PwrAgent",
    });
    expect(results[0]?.snippets[0]?.scope).toBe("projection");
  });

  it("searches by thread id", () => {
    store.upsertThread(
      threadSummary({
        id: "7f2f4bd1-8e7b-4d3b-92e5-0e9ef15c9c84",
        title: "Release notes",
        summary: "Prepared release copy",
      }),
    );

    expect(
      store
        .search({ query: "7f2f4bd1-8e7b-4d3b-92e5", limit: 10 })
        .map((result) => result.threadId),
    ).toEqual(["7f2f4bd1-8e7b-4d3b-92e5-0e9ef15c9c84"]);
  });

  it("falls back to recent projection rows for filter-only searches", () => {
    store.upsertThread(
      threadSummary({ id: "old", title: "Old", updatedAt: 1_000 }),
    );
    store.upsertThread(
      threadSummary({ id: "new", title: "New", updatedAt: 2_000 }),
    );

    expect(store.search({ limit: 10 }).map((result) => result.threadId)).toEqual([
      "new",
      "old",
    ]);
  });

  it("applies structured filters before limiting projection results", () => {
    store.upsertThread(
      threadSummary({
        id: "pwragent",
        projectKey: "PwrAgent",
        title: "Branch drift in PwrAgent",
        updatedAt: 3_000,
      }),
    );
    store.upsertThread(
      threadSummary({
        id: "docs",
        projectKey: "Docs",
        title: "Branch drift in docs",
        updatedAt: 1_000,
      }),
    );

    const results = store.search({
      filters: { projectKeys: ["Docs"] },
      limit: 1,
      query: "branch drift",
    });

    expect(results.map((result) => result.threadId)).toEqual(["docs"]);
  });

  it("excludes archived rows by default", () => {
    store.upsertThread(
      threadSummary({ id: "active", title: "Active", archivedAt: undefined }),
    );
    store.upsertThread(
      threadSummary({ id: "archived", title: "Archived", archivedAt: 2_000 }),
    );

    expect(store.search({ limit: 10 }).map((result) => result.threadId)).toEqual([
      "active",
    ]);
    expect(
      store
        .search({ includeArchived: true, limit: 10 })
        .map((result) => result.threadId),
    ).toEqual(["active", "archived"]);
  });

  it("deletes document and FTS rows together", () => {
    store.upsertThread(threadSummary({ id: "thread-1", title: "Branch drift" }));
    store.deleteThread({ backend: "codex", threadId: "thread-1" });

    expect(store.search({ query: "branch", limit: 10 })).toEqual([]);
  });

  it("prunes rows missing from a refreshed active thread list", () => {
    store.upsertThread(threadSummary({ id: "stale", title: "Stale branch drift" }));
    store.upsertThread(threadSummary({ id: "active", title: "Active branch drift" }));

    store.pruneMissingThreads({
      includeArchived: false,
      retainedIdentityKeys: ["codex:active"],
    });

    expect(
      store
        .search({ query: "branch drift", limit: 10 })
        .map((result) => result.threadId),
    ).toEqual(["active"]);
  });
});

describe("buildThreadSearchFtsQuery", () => {
  it("quotes tokens and strips unsupported FTS syntax", () => {
    expect(buildThreadSearchFtsQuery('branch OR "drift"')).toBe(
      '"branch"* "OR"* "drift"*',
    );
    expect(buildThreadSearchFtsQuery("!!!")).toBeNull();
  });
});

function threadSummary(
  overrides: Partial<AppServerThreadSummary>,
): AppServerThreadSummary {
  return {
    id: "thread",
    title: "Thread",
    titleSource: "derived",
    summary: "Asked about branch drift dialog screenshots",
    projectKey: "PwrAgent",
    createdAt: 1_000,
    updatedAt: 1_000,
    linkedDirectories: [
      {
        id: "dir-1",
        label: "PwrAgent",
        path: "/repo/PwrAgent",
        kind: "local",
      },
    ],
    source: "codex",
    gitBranch: "feat/branch-drift",
    model: "gpt-5.5",
    ...overrides,
  };
}
