import fs from "node:fs";
import type BetterSqlite3 from "better-sqlite3";

export type SqliteWriteDelta = {
  commits: number;
  rowsChanged: number;
  statements: number;
  walBytes: number;
};

type Snapshot = SqliteWriteDelta;

const WRITE_STATEMENT = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;

/**
 * Minimal release-line adaptation of PR #1410's database instrumentation.
 * It attaches after migrations and measures only callbacks in this test file;
 * the broader dev/E2E reporting and process-wide aggregation are deliberately
 * left on main.
 */
export function attachSqliteWriteMeter(params: {
  db: BetterSqlite3.Database;
  dbPath: string;
}): {
  measure<T>(run: () => T | Promise<T>): Promise<{
    result: T;
    writes: SqliteWriteDelta;
  }>;
} {
  const totals: Snapshot = {
    commits: 0,
    rowsChanged: 0,
    statements: 0,
    walBytes: 0,
  };
  const walPath = `${params.dbPath}-wal`;
  let walSize = readWalSize(walPath);
  const sampleWal = (): void => {
    const size = readWalSize(walPath);
    if (size > walSize) {
      totals.walBytes += size - walSize;
    }
    walSize = size;
  };
  const recordCommit = (): void => {
    totals.commits += 1;
    sampleWal();
  };
  const db = params.db;
  const originalPrepare = db.prepare.bind(db);
  const originalTransaction = db.transaction.bind(db);

  db.prepare = ((source: string) => {
    const statement = originalPrepare(source);
    if (!WRITE_STATEMENT.test(source)) {
      return statement;
    }
    const originalRun = statement.run.bind(statement);
    statement.run = ((...args: unknown[]) => {
      const result = originalRun(...(args as never[]));
      totals.statements += 1;
      totals.rowsChanged += result.changes;
      if (!db.inTransaction) {
        recordCommit();
      }
      return result;
    }) as typeof statement.run;
    return statement;
  }) as typeof db.prepare;

  const countTransaction = <T extends (...args: unknown[]) => unknown>(
    transactionFn: T,
  ): T =>
    ((...args: unknown[]) => {
      const nested = db.inTransaction;
      const result = transactionFn(...args);
      if (!nested) {
        recordCommit();
      }
      return result;
    }) as T;

  db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const wrapped = originalTransaction(fn) as unknown as Record<string, unknown>;
    const counted = countTransaction(
      wrapped as unknown as (...args: unknown[]) => unknown,
    ) as unknown as Record<string, unknown>;
    for (const variant of ["default", "deferred", "immediate", "exclusive"]) {
      const original = wrapped[variant];
      if (typeof original === "function") {
        Object.defineProperty(counted, variant, {
          configurable: true,
          value: countTransaction(original as (...args: unknown[]) => unknown),
          writable: true,
        });
      }
    }
    return counted;
  }) as unknown as typeof db.transaction;

  return {
    async measure<T>(run: () => T | Promise<T>) {
      const before = { ...totals };
      const result = await run();
      return {
        result,
        writes: {
          commits: totals.commits - before.commits,
          rowsChanged: totals.rowsChanged - before.rowsChanged,
          statements: totals.statements - before.statements,
          walBytes: totals.walBytes - before.walBytes,
        },
      };
    },
  };
}

function readWalSize(walPath: string): number {
  try {
    return fs.statSync(walPath).size;
  } catch {
    return 0;
  }
}
