import { afterEach, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { ThreadSearchStore } from "../storage/thread-search-store";
import { ThreadSearchService } from "../thread-search/thread-search-service";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const listed: AppServerThreadSummary = {
  id: "listed", source: "codex", title: "Sunflower", titleSource: "explicit", linkedDirectories: [],
};
const peer: AppServerThreadSummary = {
  ...listed, id: "peer", source: "claude", title: "Juniper", summary: "Committed by the peer",
};

afterEach(() => vi.unstubAllEnvs());

it.each(["stale title", "missing rowid", "reused rowid"] as const)(
  "matches the listed metadata after a peer commits a %s",
  async (damage) => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { dbPath, tempDir } = createTempStateDb("search-integrity-");
    const reader = StateDb.open(dbPath);
    const writer = StateDb.open(dbPath);
    try {
      expect(reader.raw.pragma("journal_mode", { simple: true })).toBe("wal");
      const store = new ThreadSearchStore(reader);
      store.upsertThread(listed, 100);
      const writerStore = new ThreadSearchStore(writer);
      const document = reader.raw.prepare("SELECT * FROM thread_search_documents WHERE identity_key = ?");
      const mapping = reader.raw.prepare("SELECT fts_rowid FROM thread_search_fts_rows WHERE identity_key = ?").pluck();
      const row = reader.raw.prepare("SELECT rowid, * FROM thread_search_fts WHERE rowid = ?");
      const listedKey = "codex:listed";
      const peerKey = "claude:peer";
      const listedDocument = document.get(listedKey);
      const listedRowid = mapping.get(listedKey);
      const listedFtsRow = row.get(listedRowid) as Record<string, unknown>;

      writer.raw.transaction(() => {
        writerStore.upsertThread(peer, 200);
        if (damage === "stale title") {
          writer.raw.prepare("UPDATE thread_search_fts SET title = ? WHERE rowid = ?").run("Nightshade", listedRowid);
        } else {
          writer.raw.prepare("DELETE FROM thread_search_fts WHERE rowid = ?").run(listedRowid);
          if (damage === "reused rowid") {
            // Move the peer's FTS row into the vacated slot as a legacy writer could.
            writer.raw.prepare("UPDATE thread_search_fts SET rowid = ? WHERE rowid = ?").run(listedRowid, mapping.get(peerKey));
          }
        }
      })();
      expect(document.get(listedKey)).toEqual(listedDocument);
      expect(mapping.get(listedKey)).toBe(listedRowid);
      const peerDocument = document.get(peerKey);
      const peerRowid = mapping.get(peerKey);
      const peerFtsRowid = damage === "reused rowid" ? listedRowid : peerRowid;
      const peerFtsRow = row.get(peerFtsRowid);
      // Leave the peer out of this listing so its legacy row is not reindexed.
      const inventory = damage === "reused rowid" ? [listed] : [listed, peer];
      const service = new ThreadSearchService(store, async () => inventory);
      const search = async (term: string) => (await service.search({ query: `"${term}"`, contentMode: "metadata" }))
        .results.map(({ threadId, title }) => ({ id: threadId, title }));

      const { writes } = await measureSqliteWrites(async () => {
        expect(await search(listed.title)).toEqual([{ id: listed.id, title: listed.title }]);
      });
      const unchanged = await measureSqliteWrites(async () => {
        for (const term of [listed.title, "Nightshade", peer.title]) {
          expect(await search(term)).toEqual(inventory.filter(({ title }) => title === term).map(({ id, title }) => ({ id, title })));
        }
      });
      expect(document.get(listedKey)).toEqual(listedDocument);
      expect(document.get(peerKey)).toEqual(peerDocument);
      expect(mapping.get(peerKey)).toBe(peerRowid);
      expect(row.get(peerFtsRowid)).toEqual(peerFtsRow);
      expect(store.search({ query: `"${peer.title}"`, limit: 10 }).map(({ threadId }) => threadId)).toEqual([peer.id]);
      expect(row.get(mapping.get(listedKey))).toEqual({ ...listedFtsRow, rowid: mapping.get(listedKey) });
      expect(writes.commits).toBe(1);
      expect(unchanged.writes.commits).toBe(0);
      if (damage === "stale title") {
        expect(mapping.get(listedKey)).toBe(listedRowid);
        expectSqliteWriteBudget({
          scenario: "thread-search-repair-stale-fts-payload", writes,
          note: "One commit repairs a stale mapped FTS payload, measured at 16,480 WAL bytes. At 100 repairs/day, about 1.648 MB/day. Healthy searches and idle add zero bytes.",
        });
      }
    } finally {
      writer.close();
      reader.close();
      removeTempStateDbDir(tempDir);
    }
  },
);

it("repairs each indexed field and rolls back repairs with the rest of the slice", () => {
  // Title is covered by the two-connection regression above. Change one
  // field per row so each payload comparison must independently find damage.
  const fields = [
    "summary", "project_key", "directory_labels", "directory_paths", "git_branch",
    "git_origin_url", "model", "backend", "thread_id",
  ] as const;
  const db = openInMemoryStateDb();
  try {
    const store = new ThreadSearchStore(db);
    const threads = fields.map((field) => ({
      ...listed,
      id: `${field}:7f2f4bd1-8e7b-4d3b-92e5-0e9ef15c9c84`,
      summary: "Observations", projectKey: "Garden", gitBranch: "spring", gitOriginUrl: "https://example.com/garden.git",
      model: "fixture-model",
      linkedDirectories: [{ id: "garden", label: "Garden tools", path: "/garden", worktreePath: "/orchard", kind: "local" as const }],
    }));
    store.upsertThreads(threads);
    const readFts = db.raw.prepare("SELECT rowid, * FROM thread_search_fts ORDER BY rowid");
    const readDocuments = db.raw.prepare("SELECT * FROM thread_search_documents ORDER BY identity_key");
    const expectedFts = readFts.all();
    const expectedDocuments = readDocuments.all();
    for (const [i, field] of fields.entries()) {
      db.raw.prepare(`UPDATE thread_search_fts SET ${field} = ? WHERE rowid = (
        SELECT fts_rowid FROM thread_search_fts_rows WHERE identity_key = ?
      )`).run("Nightshade", `codex:${threads[i].id}`);
    }
    expect(store.search({ query: '"Nightshade"', limit: 20 })).toHaveLength(fields.length);
    const damaged = readFts.all();

    expect(() => store.upsertThreads([...threads, { ...listed, title: null as never }])).toThrow();
    expect(readFts.all()).toEqual(damaged);
    expect(readDocuments.all()).toEqual(expectedDocuments);

    store.upsertThreads(threads);
    expect(readFts.all()).toEqual(expectedFts);
    expect(readDocuments.all()).toEqual(expectedDocuments);
    expect(store.search({ query: '"Nightshade"', limit: 20 })).toEqual([]);
  } finally {
    db.close();
  }
});

it("preserves a peer's committed rename between repair preflight and the write transaction", async () => {
  const { dbPath, tempDir } = createTempStateDb("search-integrity-rename-");
  const reader = StateDb.open(dbPath);
  const writer = StateDb.open(dbPath);
  try {
    const writerStore = new ThreadSearchStore(writer);
    writerStore.upsertThread(listed, 100);
    writer.raw.prepare("UPDATE thread_search_fts SET title = ? WHERE identity_key = ?").run("Nightshade", "codex:listed");
    const renamed = { ...listed, title: "Marigold", summary: "Committed rename" };
    let committed = false;
    const spy = afterProjectionCheck(reader, () => {
      if (committed) return;
      expect(reader.raw.inTransaction).toBe(false);
      writerStore.upsertThread(renamed, 200);
      committed = true;
    });
    const service = new ThreadSearchService(new ThreadSearchStore(reader), async () => [listed]);
    const response = await service.search({ query: '"Marigold"', contentMode: "metadata" });
    spy.mockRestore();
    expect(committed).toBe(true);
    expect(response.results).toMatchObject([{ threadId: renamed.id, title: renamed.title, summary: renamed.summary }]);
    expect(reader.raw.prepare("SELECT title, summary, indexed_at FROM thread_search_documents").get()).toEqual({
      title: renamed.title, summary: renamed.summary, indexed_at: 200,
    });
  } finally {
    writer.close();
    reader.close();
    removeTempStateDbDir(tempDir);
  }
});

it.each(["metadata search", "single upsert"] as const)(
  "repairs FTS during %s even when a peer attempts a write after the in-transaction recheck",
  async (entryPoint) => {
    const { dbPath, tempDir } = createTempStateDb("search-integrity-writer-lock-");
    const reader = StateDb.open(dbPath);
    const writer = StateDb.open(dbPath);
    try {
      const writerStore = new ThreadSearchStore(writer);
      writerStore.upsertThreads([listed, peer]);
      writer.raw.prepare("UPDATE thread_search_fts SET title = ? WHERE identity_key = ?").run("Nightshade", "codex:listed");
      // Try once at the recheck boundary, while the reader's transaction is open.
      writer.raw.pragma("busy_timeout = 0");
      const touchPeer = writer.raw.prepare("UPDATE thread_search_documents SET indexed_at = ? WHERE identity_key = ?");
      let attempted = false;
      let blocked = false;
      const spy = afterProjectionCheck(reader, () => {
        if (attempted || !reader.raw.inTransaction) return;
        attempted = true;
        try {
          touchPeer.run(300, "claude:peer");
        } catch (error) {
          expect(error).toMatchObject({ code: "SQLITE_BUSY" });
          blocked = true;
        }
      });

      const store = new ThreadSearchStore(reader);
      if (entryPoint === "metadata search") {
        const service = new ThreadSearchService(store, async () => [listed]);
        const response = await service.search({ query: '"Sunflower"', contentMode: "metadata" });
        expect(response.results.map(({ threadId }) => threadId)).toEqual([listed.id]);
      } else {
        store.upsertThread(listed);
      }
      spy.mockRestore();
      expect(attempted).toBe(true);
      expect(blocked).toBe(true);
      expect(store.search({ query: '"Sunflower"', limit: 10 }).map(({ threadId }) => threadId)).toEqual([listed.id]);
      expect(store.search({ query: '"Nightshade"', limit: 10 })).toEqual([]);
      expect(touchPeer.run(300, "claude:peer").changes).toBe(1);
    } finally {
      writer.close();
      reader.close();
      removeTempStateDbDir(tempDir);
    }
  },
);

function afterProjectionCheck(db: StateDb, callback: () => void) {
  const prepare = db.raw.prepare.bind(db.raw);
  return vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.includes("AS fts_current")) {
      const get = statement.get.bind(statement);
      statement.get = (...args: unknown[]) => {
        const result = get(...args);
        callback();
        return result;
      };
    }
    return statement;
  });
}
