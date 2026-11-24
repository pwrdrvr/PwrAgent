import Database from "better-sqlite3";
import { statSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

it("reopens a WAL profile when a peer commits after schema reads and before the PR provider write", () => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-schema-snapshot-");
  const peer = StateDb.open(dbPath);
  let reopened: StateDb | undefined;
  const originalExec = Database.prototype.exec;
  try {
    expect(peer.raw.pragma("journal_mode", { simple: true })).toBe("wal");
    peer.raw.exec(`INSERT INTO pr_status_cache (pr_key, provider, org, repo, number, fetched_at, payload)
      VALUES ('Example/Project#4', '', 'Example', 'Project', 4, 1, '{}')`);
    const commit = peer.raw.prepare("INSERT INTO meta (key, value) VALUES ('peer-commit', 'observed')");
    let firstWrite = true;
    const sqliteFailures: string[] = [];
    const exec = vi.spyOn(Database.prototype, "exec").mockImplementation(function (
      this: Database.Database,
      sql,
    ) {
      if (firstWrite && this.name === dbPath && /^\s*UPDATE pr_status_cache\b/.test(sql)) {
        firstWrite = false;
        expect(this.inTransaction).toBe(true);
        commit.run();
        // The schema reads already pinned the opener's snapshot before the
        // other connection committed. The real UPDATE must hit that snapshot.
        expect(this.prepare("SELECT value FROM meta WHERE key = 'peer-commit'").get()).toBeUndefined();
        try {
          return originalExec.call(this, sql);
        } catch (error) {
          if (error instanceof Database.SqliteError) sqliteFailures.push(error.code);
          throw error;
        }
      }
      return originalExec.call(this, sql);
    });
    let escapedSqliteError: string | undefined;
    try {
      reopened = StateDb.open(dbPath);
    } catch (error) {
      if (!(error instanceof Database.SqliteError)) throw error;
      escapedSqliteError = error.code;
    } finally {
      exec.mockRestore();
    }

    expect(sqliteFailures).toEqual(["SQLITE_BUSY_SNAPSHOT"]);
    expect(escapedSqliteError).toBeUndefined();
    expect(reopened?.getMeta("peer-commit")).toBe("observed");
    expect(reopened?.raw.prepare("SELECT pr_key, provider FROM pr_status_cache").get())
      .toEqual({ pr_key: "github.com/example/project#4", provider: "github.com" });
  } finally {
    reopened?.close();
    peer.close();
    removeTempStateDbDir(tempDir);
  }
});

// The same current user_version can belong to profiles with different schema
// or data left by an earlier build. Each shape must converge to the expected
// cache keys and values, then allow a reopen while another host owns the writer.
it.each([
  { shape: "missing columns", repairedRows: 1 },
  { shape: "legacy values", repairedRows: 2 },
  { shape: "current caches", repairedRows: 0 },
])(
  "converges a current-version WAL profile with $shape and reopens it without writes",
  ({ shape, repairedRows }) => {
    const { dbPath, tempDir } = createTempStateDb("pwragent-schema-convergence-");
    const peer = StateDb.open(dbPath);
    let reopened: StateDb | undefined;
    try {
      const current = shape === "current caches";
      const expectedRows = [{ pr_key: "github.com/example/project#4", provider: "github.com" }];
      peer.raw.prepare(`INSERT INTO pr_status_cache (pr_key, provider, org, repo, number, fetched_at, payload)
        VALUES (?, ?, 'Example', 'Project', 4, 1, '{}')`)
        .run(current ? "github.com/example/project#4" : "Example/Project#4", current ? "github.com" : "");
      peer.raw.prepare(`INSERT INTO pr_lookup_cache (lookup_key, provider, branch, directory_paths, fetched_at, payload)
        VALUES ('lookup', ?, 'main', '[]', 1, '{}')`).run(current ? "github.com" : "");
      if (shape === "missing columns") {
        peer.raw.exec("ALTER TABLE pr_status_cache DROP COLUMN provider; ALTER TABLE pr_lookup_cache DROP COLUMN provider");
      } else {
        peer.raw.exec(`INSERT INTO pr_status_cache (pr_key, provider, org, repo, number, fetched_at, payload)
          VALUES ('gitlab.com/example/project#5', 'gitlab.com', 'Example', 'Project', 5, 1, '{}')`);
        expectedRows.push({ pr_key: "gitlab.com/example/project#5", provider: "gitlab.com" });
      }

      expect(peer.raw.pragma("user_version", { simple: true })).toBe(CURRENT_STATE_DB_USER_VERSION);
      peer.raw.pragma("wal_checkpoint(TRUNCATE)");
      reopened = StateDb.open(dbPath);
      expect(reopened.raw.prepare("SELECT pr_key, provider FROM pr_status_cache ORDER BY number").all())
        .toEqual(expectedRows);
      expect(reopened.raw.prepare("SELECT lookup_key, provider FROM pr_lookup_cache").get())
        .toEqual({ lookup_key: "lookup", provider: "github.com" });
      expect(reopened.raw.prepare("SELECT total_changes()").pluck().get()).toBe(repairedRows);
      reopened.close();
      reopened = undefined;

      peer.raw.pragma("wal_checkpoint(TRUNCATE)");
      peer.raw.exec("BEGIN IMMEDIATE");
      const originalPragma = Database.prototype.pragma;
      const pragma = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
        this: Database.Database,
        source,
        options,
      ) {
        // The writer is intentionally held by this thread. Fail immediately
        // if a converged open ever asks SQLite for that writer's lock.
        return originalPragma.call(this, source === "busy_timeout = 5000" ? "busy_timeout = 0" : source, options);
      });
      try {
        reopened = StateDb.open(dbPath);
      } finally {
        pragma.mockRestore();
        peer.raw.exec("ROLLBACK");
      }
      expect(reopened.raw.prepare("SELECT total_changes()").pluck().get()).toBe(0);
      expect(statSync(`${dbPath}-wal`).size).toBe(0);
    } finally {
      reopened?.close();
      peer.close();
      removeTempStateDbDir(tempDir);
    }
  },
);
