import { expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { ThreadSearchStore } from "../storage/thread-search-store";
import { ThreadSearchService } from "../thread-search/thread-search-service";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

function summary(id: string, archived = false): AppServerThreadSummary {
  return {
    id, source: "codex", title: "Asterism " + id, titleSource: "explicit",
    linkedDirectories: [{ id, label: "Orchard", path: "/contrived/" + id, kind: "local" }],
    archivedAt: archived ? 1000 : undefined,
  };
}

it("reuses proven current rows across overlapping searches of fresh provider objects", async () => {
  const db = openInMemoryStateDb();
  try {
    const prepare = db.raw.prepare.bind(db.raw);
    let projectionReads = 0;
    let versionReads = 0;
    const observe = vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("thread_search_documents") && sql.includes("thread_search_fts_rows")
        && statement.reader) {
        const get = statement.get.bind(statement);
        const all = statement.all.bind(statement);
        statement.get = (...args: unknown[]) => {
          projectionReads++;
          return get(...args);
        };
        statement.all = (...args: unknown[]) => {
          projectionReads++;
          return all(...args);
        };
      } else if (sql.includes("pragma_data_version")) {
        const get = statement.get.bind(statement);
        statement.get = (...args: unknown[]) => {
          versionReads++;
          return get(...args);
        };
      }
      return statement;
    });
    const store = new ThreadSearchStore(db);
    const all = Array.from({ length: 65 }, (_, i) => summary("active-" + i));
    const archived = summary("archived", true);
    const service = new ThreadSearchService(store, async (request) => structuredClone(request.archived ? [archived] : all));
    const search = (includeArchived: boolean) => service.search({
      query: "Asterism", filters: { includeArchived }, contentMode: "metadata", limit: 100,
    });
    await search(true);
    projectionReads = 0;
    versionReads = 0;
    observe.mockClear();
    const stringify = JSON.stringify;
    let projectionSerializations = 0;
    const observeJson = vi.spyOn(JSON, "stringify").mockImplementation(((...args: Parameters<typeof JSON.stringify>) => {
      const value = args[0] as unknown;
      if (Array.isArray(value) ? value.some((item: unknown) => item && typeof item === "object" && "label" in item)
        : value && typeof value === "object" && "source" in value && "serviceTier" in value) {
        projectionSerializations++;
      }
      return stringify(...args);
    }) as typeof JSON.stringify);
    const [withArchives, active] = await Promise.all([search(true), search(false)]).finally(() => observeJson.mockRestore());
    expect(active.results.map((r) => r.threadId).sort()).toEqual(all.map((row) => row.id).sort());
    expect(withArchives.results.map((r) => r.threadId).sort()).toEqual([...all, archived].map((row) => row.id).sort());
    expect(projectionReads).toBe(0);
    expect(projectionSerializations).toBe(0);
    expect(versionReads).toBeLessThanOrEqual(8);
    expect(observe.mock.calls.length).toBeLessThanOrEqual(6);
  } finally { db.close(); }
});

it("reconciles the visible FTS corpus after external changes even when the mapped rowid still belongs to the thread", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("search-warm-peer-");
  const db = StateDb.open(temp.dbPath);
  const peer = StateDb.open(temp.dbPath);
  try {
    const store = new ThreadSearchStore(db);
    const visible = summary("visible");
    const archive = summary("archive", true);
    const omitted = summary("omitted");
    let inventory = [visible, omitted];
    const service = new ThreadSearchService(store, async (request) => structuredClone(request.archived ? [archive] : inventory));
    const search = (query: string, includeArchived = true) => service.search({
      query, filters: { includeArchived }, contentMode: "metadata", limit: 100,
    });
    await search("Asterism");
    inventory = [visible];
    const rowid = peer.raw.prepare("SELECT fts_rowid FROM thread_search_fts_rows WHERE identity_key = ?")
      .pluck().get("codex:visible");
    peer.raw.transaction(() => {
      // The mapping and document still match, but the visible thread's terms do not.
      peer.raw.prepare("UPDATE thread_search_fts SET title = ? WHERE rowid = ?").run("Iridescent", rowid);
      peer.raw.prepare("DELETE FROM thread_search_fts WHERE identity_key = ?").run("codex:archive");
    })();

    const { result: withArchives, writes } = await measureSqliteWrites(() => search("Asterism"));
    expect(withArchives.results.map((r) => r.threadId).sort()).toEqual([archive.id, visible.id].sort());
    expect((await search("Asterism", false)).results.map((r) => r.threadId)).toEqual([visible.id]);
    expect((await search("Iridescent")).results).toEqual([]);
    expect(store.search({ query: "omitted", includeArchived: true, limit: 10 }).map((r) => r.threadId)).toEqual([omitted.id]);
    expect(writes.commits).toBe(1);
    expectSqliteWriteBudget({ scenario: "thread-search-repair-slice", writes,
      note: "One commit repairs a stale FTS payload and a missing FTS row in one slice. At 10 repairs/day, 41,200 bytes × 10 gives 0.412 MB/day; 0 MB/day when no damage is present." });
  } finally { peer.close(); db.close(); removeTempStateDbDir(temp.tempDir); vi.unstubAllEnvs(); }
});

it.each([
  { slice: "unchanged", replaceTitle: false },
  { slice: "changed", replaceTitle: true },
])("rechecks an initially $slice slice if a peer commits after the preflight snapshot", async ({ replaceTitle }) => {
  const temp = createTempStateDb("search-preflight-peer-");
  const db = StateDb.open(temp.dbPath);
  const peer = StateDb.open(temp.dbPath);
  try {
    const first = summary("first");
    const listedFirst = replaceTitle ? { ...first, title: "Asterism revised" } : first;
    const second = summary("second");
    const removePeerRow = peer.raw.prepare("DELETE FROM thread_search_fts WHERE identity_key = ?");
    const afterVersionRead = interceptProjectionVersion(db);
    const removeFtsRow = vi.fn(() => removePeerRow.run("codex:second"));
    const store = new ThreadSearchStore(db);
    store.upsertThreads([first, second]);
    afterVersionRead(removeFtsRow);
    const service = new ThreadSearchService(store, async () => [listedFirst, second]);
    const result = await service.search({ query: "Asterism", contentMode: "metadata" });
    expect(removeFtsRow).toHaveBeenCalledOnce();
    expect(result.results.map((row) => [row.threadId, row.title]).sort()).toEqual([
      ["first", listedFirst.title], ["second", second.title],
    ]);
  } finally { peer.close(); db.close(); removeTempStateDbDir(temp.tempDir); }
});

it.each([
  { scenario: "unrelated write before recheck", duringReconcile: false, indexesProjection: false, holdsWriter: true },
  { scenario: "peer indexes the projection before recheck", duringReconcile: false, indexesProjection: true, holdsWriter: true },
  { scenario: "unrelated write invalidates the write snapshot", duringReconcile: true, indexesProjection: false, holdsWriter: false },
  { scenario: "peer indexes the projection and keeps the writer lock", duringReconcile: true, indexesProjection: true, holdsWriter: true },
])("returns current search rows when $scenario", async ({ duringReconcile, indexesProjection, holdsWriter }) => {
  const temp = createTempStateDb("search-preflight-lock-");
  const db = StateDb.open(temp.dbPath);
  const peer = StateDb.open(temp.dbPath);
  try {
    db.raw.pragma("busy_timeout = 0");
    const afterVersionRead = interceptProjectionVersion(db);
    const thread = summary("unchanged");
    const listed = indexesProjection || duringReconcile ? { ...thread, title: "Asterism revised" } : thread;
    const store = new ThreadSearchStore(db);
    store.upsertThreads([thread]);
    const commitPeerChange = vi.fn(() => {
      if (indexesProjection) {
        new ThreadSearchStore(peer).upsertThread(listed);
      } else {
        peer.raw.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("contrived-search-peer", "updated");
      }
      if (holdsWriter) peer.raw.exec("BEGIN IMMEDIATE");
    });
    if (duringReconcile) {
      // Skip the preflight version and commit after reconciliation has pinned
      // its own WAL snapshot, before the first write attempts to upgrade it.
      afterVersionRead(() => afterVersionRead(commitPeerChange));
    } else {
      afterVersionRead(commitPeerChange);
    }

    const service = new ThreadSearchService(store, async () => [listed]);
    const result = await service.search({ query: "Asterism", contentMode: "metadata" });
    expect(commitPeerChange).toHaveBeenCalledOnce();
    expect(peer.raw.inTransaction).toBe(holdsWriter);
    expect(result.results.map((row) => [row.threadId, row.title])).toEqual([[listed.id, listed.title]]);
  } finally {
    if (peer.raw.inTransaction) peer.raw.exec("ROLLBACK");
    peer.close();
    db.close();
    removeTempStateDbDir(temp.tempDir);
  }
});

it.each([
  { secondCommit: "changes the indexed projection", changesProjection: true },
  { secondCommit: "only writes unrelated metadata", changesProjection: false },
])("rechecks a no-write reconciliation when the second peer commit $secondCommit", async ({ changesProjection }) => {
  const temp = createTempStateDb("search-reconcile-drift-");
  const db = StateDb.open(temp.dbPath);
  const peer = StateDb.open(temp.dbPath);
  try {
    db.raw.pragma("busy_timeout = 0");
    const afterVersionRead = interceptProjectionVersion(db);
    const thread = summary("concurrent");
    const listed = { ...thread, title: "Asterism revised" };
    const store = new ThreadSearchStore(db);
    const peerStore = new ThreadSearchStore(peer);
    store.upsertThreads([thread]);

    const commitDuringReconciliation = vi.fn(() => {
      if (changesProjection) {
        peerStore.upsertThread({ ...listed, title: "Iridescent" });
      } else {
        peer.raw.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("contrived-search-peer", "updated");
        peer.raw.exec("BEGIN IMMEDIATE");
      }
    });
    afterVersionRead(() => {
      // Preflight sees the original row. Reconciliation pins the snapshot
      // containing the requested row before the second peer commit.
      peerStore.upsertThread(listed);
      afterVersionRead(commitDuringReconciliation);
    });

    const service = new ThreadSearchService(store, async () => [listed]);
    const result = await service.search({ query: "Asterism", contentMode: "metadata" });
    expect(commitDuringReconciliation).toHaveBeenCalledOnce();
    expect(peer.raw.inTransaction).toBe(!changesProjection);
    expect(result.results.map((row) => [row.threadId, row.title])).toEqual([[listed.id, listed.title]]);
    expect(store.search({ query: "Iridescent", limit: 5 })).toEqual([]);
  } finally {
    if (peer.raw.inTransaction) peer.raw.exec("ROLLBACK");
    peer.close();
    db.close();
    removeTempStateDbDir(temp.tempDir);
  }
});

function interceptProjectionVersion(db: StateDb) {
  const prepare = db.raw.prepare.bind(db.raw);
  let next: (() => void) | undefined;
  vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.includes("pragma_data_version")) {
      const get = statement.get.bind(statement);
      statement.get = (...args: unknown[]) => {
        const result = get(...args);
        const notify = next;
        next = undefined;
        notify?.();
        return result;
      };
    }
    return statement;
  });
  return (callback: () => void) => { next = callback; };
}
