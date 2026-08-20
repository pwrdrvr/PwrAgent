import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";

let tempDir: string;

/**
 * Counts top-level sqlite commits the way the production write-accounting in
 * `sqlite-write-metrics.ts` does — a `db.transaction()` call already inside a
 * transaction runs as a savepoint and commits nothing of its own, while any
 * statement issued outside one commits implicitly.
 *
 * That accounting cannot be reused directly here: `StateDb.open` attaches it
 * *after* schema setup, so it can never see the writes that build a database.
 * Patching the prototype is the only seam that observes an open from outside.
 *
 * `exec` is counted as well as `transaction`, so a write moved out of the
 * creation wrapper is caught rather than going uncounted — that regression is
 * the whole reason this helper exists. Schema setup issues no bare
 * `prepare(...).run()` outside a transaction, so `prepare` is left alone.
 */
function countCommitsDuring(run: () => void): number {
  const originalTransaction = Database.prototype.transaction;
  const originalExec = Database.prototype.exec;
  let commits = 0;

  Database.prototype.transaction = function patched(
    this: Database.Database,
    fn: (...args: unknown[]) => unknown,
  ) {
    const inner = originalTransaction.call(this, fn) as unknown as Record<
      string,
      unknown
    >;
    const count = <T extends (...args: unknown[]) => unknown>(
      transactionFn: T,
    ): T =>
      ((...args: unknown[]) => {
        const nested = this.inTransaction;
        const result = transactionFn(...args);
        if (!nested) {
          commits += 1;
        }
        return result;
      }) as T;

    const counted = count(
      inner as unknown as (...args: unknown[]) => unknown,
    ) as unknown as Record<string, unknown>;
    // `.default` / `.deferred` / `.immediate` / `.exclusive` hang off the
    // returned callable and are NOT enumerable, so they have to be rewrapped
    // one at a time. `sqlite-write-metrics.ts` lost them once and every
    // `tx.immediate(...)` caller died with "is not a function".
    for (const variant of ["default", "deferred", "immediate", "exclusive"]) {
      const original = inner[variant];
      if (typeof original === "function") {
        Object.defineProperty(counted, variant, {
          configurable: true,
          value: count(original as (...args: unknown[]) => unknown),
          writable: true,
        });
      }
    }
    return counted as unknown as ReturnType<typeof originalTransaction>;
  } as typeof Database.prototype.transaction;

  Database.prototype.exec = function patchedExec(
    this: Database.Database,
    source: string,
  ) {
    const nested = this.inTransaction;
    const result = originalExec.call(this, source);
    if (!nested) {
      commits += 1;
    }
    return result;
  } as typeof Database.prototype.exec;

  try {
    run();
  } finally {
    Database.prototype.transaction = originalTransaction;
    Database.prototype.exec = originalExec;
  }
  return commits;
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-state-db-creation-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("StateDb.open — database creation", () => {
  it("builds a brand-new database in a single commit", () => {
    const dbPath = path.join(tempDir, "state.db");
    let stateDb: StateDb | undefined;

    const commits = countCommitsDuring(() => {
      stateDb = StateDb.open(dbPath);
    });

    try {
      // One commit, not one per schema version. A fresh file has no earlier
      // user_version to resume from, so per-version commits bought it nothing
      // and cost a WAL flush each — the cost that pushed Windows CI runners
      // past the 30s per-test budget on suites that open a db per test.
      expect(commits).toBe(1);
    } finally {
      stateDb?.close();
    }
  });

  it("still applies every migration while creating inside that transaction", () => {
    const stateDb = StateDb.open(path.join(tempDir, "state.db"));

    try {
      expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
        CURRENT_STATE_DB_USER_VERSION,
      );
      // Spot-check objects from across the ladder — v1 (`meta`), v50
      // (`acp_available_commands`), and a v51 column — because a savepoint
      // that silently swallowed part of it would still report the right
      // version.
      const names = new Set(
        (
          stateDb.raw
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as { name: string }[]
        ).map((row) => row.name),
      );
      expect(names).toContain("meta");
      expect(names).toContain("acp_available_commands");
      const invocationColumns = new Set(
        (
          stateDb.raw.pragma("table_info(thread_tool_invocations)") as {
            name: string;
          }[]
        ).map((column) => column.name),
      );
      expect(invocationColumns).toContain("suggested_prompt");
    } finally {
      stateDb.close();
    }
  });

  it("keeps one commit per version when upgrading an existing database", () => {
    const dbPath = path.join(tempDir, "state.db");
    const created = StateDb.open(dbPath);
    created.raw.pragma("user_version = 48");
    created.close();

    let reopened: StateDb | undefined;
    const commits = countCommitsDuring(() => {
      reopened = StateDb.open(dbPath);
    });

    try {
      // An upgrade keeps per-version granularity on purpose: a partial failure
      // has a previous user_version to resume from on the next launch.
      expect(commits).toBeGreaterThan(1);
      expect(reopened?.raw.pragma("user_version", { simple: true })).toBe(
        CURRENT_STATE_DB_USER_VERSION,
      );
    } finally {
      reopened?.close();
    }
  });
});
