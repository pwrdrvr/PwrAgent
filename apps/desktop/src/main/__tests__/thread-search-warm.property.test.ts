import { statSync } from "node:fs";
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
    const touchMetadata = peer.raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    const commitPeerChange = vi.fn(() => {
      if (indexesProjection) {
        new ThreadSearchStore(peer).upsertThread(listed);
      } else {
        touchMetadata.run("contrived-search-peer", "updated");
      }
      if (holdsWriter) peer.raw.exec("BEGIN IMMEDIATE");
    });
    if (duringReconcile) {
      // Invalidate the first attempt, then commit again inside its retry.
      afterVersionRead(() => {
        touchMetadata.run("contrived-search-peer", "attempt");
        afterVersionRead(commitPeerChange);
      });
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

it("repairs an FTS row lost during a no-change verification", async () => {
  const temp = createTempStateDb("search-fallback-drift-");
  const db = StateDb.open(temp.dbPath);
  const peer = StateDb.open(temp.dbPath);
  try {
    const { afterVersionRead, afterProjectionRead } = interceptProjectionReads(db);
    const listed = summary("visible");
    const store = new ThreadSearchStore(db);
    store.upsertThread(listed);
    const removeFtsRow = vi.fn(() => {
      peer.raw.prepare("DELETE FROM thread_search_fts WHERE identity_key = ?").run("codex:visible");
    });
    afterVersionRead(() => {
      peer.raw.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("contrived-search-peer", "updated");
      afterProjectionRead(removeFtsRow);
    });

    const service = new ThreadSearchService(store, async () => [listed]);
    const result = await service.search({ query: "Asterism", contentMode: "metadata" });
    expect(removeFtsRow).toHaveBeenCalledOnce();
    expect(result.results.map((row) => row.threadId)).toEqual([listed.id]);
  } finally { peer.close(); db.close(); removeTempStateDbDir(temp.tempDir); }
});

it("returns the peer's repair after repeated snapshot invalidation while the peer holds the writer lock", async () => {
  const temp = createTempStateDb("search-fallback-lock-");
  const db = StateDb.open(temp.dbPath);
  const peer = StateDb.open(temp.dbPath);
  try {
    db.raw.pragma("busy_timeout = 0");
    const { afterProjectionRead } = interceptProjectionReads(db);
    const thread = summary("concurrent");
    const listed = { ...thread, title: "Asterism revised" };
    const store = new ThreadSearchStore(db);
    const peerStore = new ThreadSearchStore(peer);
    store.upsertThread(thread);
    const touchMetadata = peer.raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    afterProjectionRead(() => {
      touchMetadata.run("contrived-search-peer", "first");
      afterProjectionRead(() => {
        touchMetadata.run("contrived-search-peer", "second");
        afterProjectionRead(() => {
          peerStore.upsertThread(listed);
          peer.raw.exec("BEGIN IMMEDIATE");
        });
      });
    });

    const service = new ThreadSearchService(store, async () => [listed]);
    const result = await service.search({ query: "Asterism", contentMode: "metadata" });
    expect(peer.raw.inTransaction).toBe(true);
    expect(result.results.map((row) => [row.threadId, row.title])).toEqual([[listed.id, listed.title]]);
  } finally {
    if (peer.raw.inTransaction) peer.raw.exec("ROLLBACK");
    peer.close();
    db.close();
    removeTempStateDbDir(temp.tempDir);
  }
});

it.each([
  { scenario: "unrelated peer writes", damage: "none" },
  { scenario: "an FTS row missing before snapshot verification", damage: "beforeSnapshot" },
  { scenario: "an FTS row removed after snapshot verification", damage: "beforeMatch" },
])("searches a verified snapshot with $scenario", async ({ damage }) => {
  if (damage === "beforeSnapshot") vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("search-fallback-budget-");
  const db = StateDb.open(temp.dbPath);
  const peer = StateDb.open(temp.dbPath);
  const originalSearch = ThreadSearchStore.prototype.search;
  const search = vi.spyOn(ThreadSearchStore.prototype, "search");
  try {
    const afterVersionRead = interceptProjectionVersion(db);
    const listed = summary("current");
    const store = new ThreadSearchStore(db);
    store.upsertThread(listed);
    const touchMetadata = peer.raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    let peerWrites = 0;
    const commitPeerChange = vi.fn(() => {
      touchMetadata.run("contrived-search-peer", String(++peerWrites));
      if (peerWrites < 4) afterVersionRead(commitPeerChange);
    });
    afterVersionRead(commitPeerChange);
    const deleteFtsRow = peer.raw.prepare("DELETE FROM thread_search_fts WHERE identity_key = ?");
    if (damage === "beforeSnapshot") {
      const read = store.searchInVerifiedSnapshot.bind(store);
      vi.spyOn(store, "searchInVerifiedSnapshot").mockImplementation(async (...args) => {
        deleteFtsRow.run("codex:current");
        const { result, writes } = await measureSqliteWrites(() => read(...args));
        expect(writes.commits).toBe(1);
        expectSqliteWriteBudget({ scenario: "thread-search-verified-snapshot-repair", writes,
          note: "One commit repairs one missing FTS projection on the snapshot fallback. At 10 repairs/day, 41,200 bytes × 10 gives 0.412 MB/day; 0 MB/day for unrelated peer writes alone." });
        return result;
      });
    }
    if (damage === "beforeMatch") {
      search.mockImplementation(function (this: ThreadSearchStore, request) {
        deleteFtsRow.run("codex:current");
        return originalSearch.call(this, request);
      });
    }

    const service = new ThreadSearchService(store, async () => [listed]);
    const result = await service.search({ query: "Asterism", contentMode: "metadata" });
    expect(result.results.map((row) => row.threadId)).toEqual([listed.id]);
    expect(commitPeerChange).toHaveBeenCalledTimes(4);
    expect(search).toHaveBeenCalledOnce();
  } finally { search.mockRestore(); peer.close(); db.close(); removeTempStateDbDir(temp.tempDir); vi.unstubAllEnvs(); }
});

it.each([
  { change: "new", peerRepairs: false },
  { change: "renamed", peerRepairs: false },
  { change: "renamed", peerRepairs: true },
])("reconciles a $change projection under repeated peer commits (peer repairs: $peerRepairs)", async ({ change, peerRepairs }) => {
  const temp = createTempStateDb("search-stale-writer-");
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, undefined);
  const peer = StateDb.open(temp.dbPath);
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = StateDb.open(temp.dbPath);
  try {
    db.raw.pragma("busy_timeout = 75");
    const afterVersionRead = interceptProjectionVersion(db);
    const previous = Array.from({ length: 64 }, (_, index) => summary("row-" + index));
    const target = { ...previous[63], title: "Quasar request" };
    const listed = [...previous.slice(0, 63), target];
    const store = new ThreadSearchStore(db);
    const peerStore = new ThreadSearchStore(peer);
    store.upsertThreads(change === "new" ? previous.slice(0, 63) : previous);

    const touchMetadata = peer.raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    const walPath = temp.dbPath + "-wal";
    let peerCommits = 0;
    let walBeforeRecovery = 0;
    const advancePeer = () => {
      peerCommits++;
      if (peerCommits < 4) {
        touchMetadata.run("contrived-search-peer", String(peerCommits));
        afterVersionRead(advancePeer);
      } else {
        if (peerRepairs) {
          peerStore.upsertThread(target);
          peer.raw.exec("BEGIN IMMEDIATE");
        } else {
          touchMetadata.run("contrived-search-peer", String(peerCommits));
        }
        // Sample after the last peer commit to isolate the recovery's WAL.
        walBeforeRecovery = statSync(walPath).size;
      }
    };
    afterVersionRead(advancePeer);

    const service = new ThreadSearchService(store, async () => listed);
    const { result, writes } = await measureSqliteWrites(() => service.search({ query: "Quasar", contentMode: "metadata" }));
    const expected = listed.filter((row) => row.title.includes("Quasar")).map((row) => [row.id, row.title]);
    expect(result.results.map((row) => [row.threadId, row.title])).toEqual(expected);
    expect(peerCommits).toBe(4);
    expect(peer.raw.inTransaction).toBe(peerRepairs);
    expect(db.raw.pragma("busy_timeout", { simple: true })).toBe(75);
    expect(writes.commits).toBe(peerRepairs ? 0 : 1);
    if (change === "renamed" && !peerRepairs) {
      expectSqliteWriteBudget({
        scenario: "thread-search-contended-projection-repair",
        writes: { ...writes, walBytes: statSync(walPath).size - walBeforeRecovery },
        note: "One commit applies a confirmed rename after repeated unrelated WAL commits. At 10 recoveries/day, 41,200 bytes × 10 gives 0.412 MB/day; 0 MB/day when the peer already repaired it.",
      });
    }
  } finally {
    if (peer.raw.inTransaction) peer.raw.exec("ROLLBACK");
    peer.close();
    db.close();
    removeTempStateDbDir(temp.tempDir);
    vi.unstubAllEnvs();
  }
});

it("cancels snapshot verification between slices before running MATCH", async () => {
  const temp = createTempStateDb("search-fallback-cancel-");
  const db = StateDb.open(temp.dbPath);
  const search = vi.spyOn(ThreadSearchStore.prototype, "search");
  try {
    const store = new ThreadSearchStore(db);
    const controller = new AbortController();
    const inventory = Array.from({ length: 65 }, (_, index) => summary("row-" + index));
    store.upsertThreads(inventory);
    vi.spyOn(store, "upsertThreads").mockReturnValue(true);
    const read = store.searchInVerifiedSnapshot.bind(store);
    vi.spyOn(store, "searchInVerifiedSnapshot").mockImplementation((...args) => {
      setImmediate(() => controller.abort());
      return read(...args);
    });
    const service = new ThreadSearchService(store, async () => inventory);
    await expect(service.search({ query: "Asterism", contentMode: "metadata" }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(search).not.toHaveBeenCalled();
  } finally { search.mockRestore(); db.close(); removeTempStateDbDir(temp.tempDir); }
});

function interceptProjectionVersion(db: StateDb) {
  return interceptProjectionReads(db).afterVersionRead;
}

function interceptProjectionReads(db: StateDb) {
  const prepare = db.raw.prepare.bind(db.raw);
  const pending: Partial<Record<"version" | "projection", () => void>> = {};
  vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    const kind = sql.includes("pragma_data_version") ? "version"
      : sql.includes("SELECT 1 FROM thread_search_documents d") ? "projection" : undefined;
    if (kind) {
      const get = statement.get.bind(statement);
      statement.get = (...args: unknown[]) => {
        const result = get(...args);
        if (kind === "version" && !db.raw.inTransaction) return result;
        const notify = pending[kind];
        delete pending[kind];
        notify?.();
        return result;
      };
    }
    return statement;
  });
  return {
    afterVersionRead: (callback: () => void) => { pending.version = callback; },
    afterProjectionRead: (callback: () => void) => { pending.projection = callback; },
  };
}
