import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["threads", "INSERT INTO threads(thread_id, payload) VALUES ('codex:fixture', '{}')"],
  ["backends", "INSERT INTO backends(scope, payload) VALUES ('fixture', '{}')"],
  ["directory_launchpads", "INSERT INTO directory_launchpads(directory_path, payload, created_at, updated_at) VALUES ('fixture', '{}', 1, 1)"],
  ["directory_overlay", "INSERT INTO directory_overlay(directory_key, payload) VALUES ('fixture', '{}')"],
  ["remote_directory_overlay", "INSERT INTO remote_directory_overlay(instance_id, directory_key, payload) VALUES ('peer', 'fixture', '{}')"],
  ["remote_thread_pins", "INSERT INTO remote_thread_pins(instance_id, backend, thread_id, added_at, payload) VALUES ('peer', 'codex', 'fixture', 1, '{}')"],
  ["directory_git_status", "INSERT INTO directory_git_status(directory_key, fetched_at, payload) VALUES ('fixture', 1, '{}')"],
  ["thread_git_working_state", "INSERT INTO thread_git_working_state(worktree_path, fetched_at, payload) VALUES ('fixture', 1, '{}')"],
  ["pr_status_cache", "INSERT INTO pr_status_cache(pr_key, org, repo, number, fetched_at, payload) VALUES ('fixture', 'fixture', 'fixture', 1, 1, '{}')"],
])("fences raw insert/update/delete on navigation input %s", (table, insert) => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  try {
    let previous = store.readNavigationSourceVersion();
    for (const sql of [insert, `UPDATE ${table} SET payload = '{"changed":true}'`, `DELETE FROM ${table}`]) {
      db.raw.exec(sql);
      const next = store.readNavigationSourceVersion();
      expect(next).not.toBe(previous);
      expect(store.readNavigationSourceVersion()).toBe(next);
      previous = next;
    }
  } finally { db.close(); }
});

it("ignores PR election and unrelated meta writes while fencing the unread baseline", async () => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  try {
    await store.setThreadPrAutoDispatchEnabled({ backend: "codex", threadId: "fixture", enabled: true });
    const version = store.readNavigationSourceVersion();
    await store.syncThreadPrAutoDispatchCandidatesBatch({ threads: [{ backend: "codex", threadId: "fixture", prKeys: ["pr"] }], now: 1 });
    db.setMeta("unrelated", "fixture");
    expect(store.readNavigationSourceVersion()).toBe(version);
    db.setMeta("navigation-unread-baseline-v2", "{}");
    const inserted = store.readNavigationSourceVersion();
    expect(inserted).not.toBe(version);
    db.setMeta("navigation-unread-baseline-v2", "{\"changed\":true}");
    const updated = store.readNavigationSourceVersion();
    expect(updated).not.toBe(inserted);
    db.raw.prepare("DELETE FROM meta WHERE key = ?").run("navigation-unread-baseline-v2");
    expect(store.readNavigationSourceVersion()).not.toBe(updated);
  } finally { db.close(); }
});

it("keeps external commits conservative and does not reuse transaction or rolled-back reads", () => {
  const temp = createTempStateDb("pwragent-navigation-version-");
  const db = StateDb.open(temp.dbPath);
  const other = new Database(temp.dbPath);
  const store = new SqliteOverlayStore(db);
  try {
    const initial = store.readNavigationSourceVersion();
    other.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("external", "fixture");
    const external = store.readNavigationSourceVersion();
    expect(external).not.toBe(initial);
    db.raw.exec("BEGIN");
    const transaction = store.readNavigationSourceVersion();
    expect(store.readNavigationSourceVersion()).not.toBe(transaction);
    db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:fixture", "{}");
    db.raw.exec("ROLLBACK");
    expect(store.readNavigationSourceVersion()).not.toBe(external);
    expect(store.readNavigationSourceVersion()).not.toBe(transaction);
  } finally { other.close(); db.close(); removeTempStateDbDir(temp.tempDir); }
});

it("does not certify a first stamp read inside a transaction", () => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  try {
    db.raw.exec("BEGIN");
    const first = store.readNavigationSourceVersion();
    expect(store.readNavigationSourceVersion()).not.toBe(first);
    db.raw.exec("ROLLBACK");
    const committed = store.readNavigationSourceVersion();
    expect(committed).not.toBe(first);
    db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:fixture", "{}");
    expect(store.readNavigationSourceVersion()).not.toBe(committed);
  } finally { db.close(); }
});

it("navigation stamp admission and unchanged reads add no SQLite commits", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("pwragent-navigation-version-writes-");
  const db = StateDb.open(temp.dbPath);
  const store = new SqliteOverlayStore(db);
  try {
    const measured = await measureSqliteWrites(() => {
      const first = store.readNavigationSourceVersion();
      for (let i = 0; i < 40; i++) expect(store.readNavigationSourceVersion()).toBe(first);
    });
    expect({ commits: measured.writes.commits, rows: measured.writes.rowsChanged, statements: measured.writes.statements })
      .toEqual({ commits: 0, rows: 0, statements: 0 });
  } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
});
