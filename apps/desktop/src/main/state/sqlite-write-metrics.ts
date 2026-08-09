import fs from "node:fs";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";

/**
 * Opt-in accounting for how much a process makes sqlite write.
 *
 * This exists because PR #1406 shipped a bug nothing could see: tool
 * accounting ran one implicit transaction per streamed 8 KiB command-output
 * chunk, costing 3,693 commits and 58 MB of WAL growth for a single `find /`.
 * The suite passed either way, because every test over that path uses a mocked
 * overlay store — no sqlite is involved, so no assertion could have noticed.
 *
 * What does exercise the real write path is the app: the E2E harness boots
 * Electron against a real `state.db` under a temp `PWRAGENT_HOME`. So the
 * instrumentation lives here, on the database, rather than in a vitest helper
 * — it then covers the E2E app process, dev runs, and the tests that do use a
 * real store, all from one place.
 *
 * The signal that matters is **commits**, not statements. Each implicit
 * transaction flushes its dirty pages, and a row update drags every index it
 * moved along with it, so commits are what write volume is proportional to.
 * Counting statements instead would rank a batched migration as expensive and
 * a per-event write loop as cheap — exactly backwards.
 */

export type SqliteTableWriteMetrics = {
  commits: number;
  rowsChanged: number;
  statements: number;
  table: string;
};

export type SqliteWriteMetricsSnapshot = {
  commits: number;
  label: string;
  rowsChanged: number;
  statements: number;
  tables: SqliteTableWriteMetrics[];
  walBytes: number;
};

/**
 * **Dev-only.** `rejectDevOnlyEnvVarsInProduction()` in `index.ts` clears this
 * on packaged builds before any consumer reads it, so a shipped app never
 * wraps its database in instrumentation.
 */
export const SQLITE_WRITE_METRICS_ENV = "PWRAGENT_DEV_SQLITE_WRITE_METRICS";

/** Run-scoped JSONL sink that `report-sqlite-writes.mjs` ranks. */
export const SQLITE_WRITE_METRICS_FILE_ENV =
  "PWRAGENT_DEV_SQLITE_WRITE_METRICS_FILE";

const WRITE_STATEMENT = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
const TABLE_NAME =
  /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+["'`[]?(\w+)/i;

class SqliteWriteMetricsCollector {
  private commits = 0;
  private rowsChanged = 0;
  private statements = 0;
  private walBytes = 0;
  private readonly tables = new Map<string, SqliteTableWriteMetrics>();
  private readonly walSizes = new Map<string, number>();

  record(params: {
    changes: number;
    committed: boolean;
    table: string;
    walPath: string | undefined;
  }): void {
    this.statements += 1;
    this.rowsChanged += params.changes;
    const table = this.tables.get(params.table) ?? {
      commits: 0,
      rowsChanged: 0,
      statements: 0,
      table: params.table,
    };
    table.statements += 1;
    table.rowsChanged += params.changes;
    if (params.committed) {
      this.commits += 1;
      table.commits += 1;
      this.sampleWal(params.walPath);
    }
    this.tables.set(params.table, table);
  }

  recordExplicitCommit(walPath: string | undefined): void {
    this.commits += 1;
    this.sampleWal(walPath);
  }

  snapshot(label: string): SqliteWriteMetricsSnapshot {
    return {
      commits: this.commits,
      label,
      rowsChanged: this.rowsChanged,
      statements: this.statements,
      tables: [...this.tables.values()].sort(
        (left, right) => right.commits - left.commits,
      ),
      walBytes: this.walBytes,
    };
  }

  /** Seed a database's WAL baseline so pre-existing frames are not counted. */
  observe(walPath: string | undefined): void {
    if (walPath && !this.walSizes.has(walPath)) {
      this.walSizes.set(walPath, readWalSize(walPath));
    }
  }

  reset(): void {
    this.commits = 0;
    this.rowsChanged = 0;
    this.statements = 0;
    this.walBytes = 0;
    this.tables.clear();
    for (const walPath of [...this.walSizes.keys()]) {
      this.walSizes.set(walPath, readWalSize(walPath));
    }
  }

  private sampleWal(walPath: string | undefined): void {
    if (!walPath) {
      return;
    }
    const size = readWalSize(walPath);
    // A checkpoint only ever shrinks the file, so counting growth alone
    // survives one without double-counting the frames it folded into the db.
    const previous = this.walSizes.get(walPath) ?? 0;
    if (size > previous) {
      this.walBytes += size - previous;
    }
    this.walSizes.set(walPath, size);
  }
}

function readWalSize(walPath: string): number {
  try {
    return fs.statSync(walPath).size;
  } catch {
    return 0;
  }
}

/**
 * One collector per process, shared by every attached database. A process
 * opens several (the profile db, a federation fixture's, a test's temp dirs),
 * and the question being asked is always "how much did this run write", not
 * "which file did it land in".
 */
let collector: SqliteWriteMetricsCollector | undefined;

/**
 * Wrap a database so every write statement is counted. Called from
 * `StateDb.open` only when metrics are enabled; a normal run patches nothing.
 */
export function attachSqliteWriteMetrics(params: {
  db: BetterSqlite3.Database;
  dbPath: string;
}): void {
  collector ??= new SqliteWriteMetricsCollector();
  const active = collector;
  registerProcessExitFlush();
  const walPath =
    params.dbPath === ":memory:" || params.dbPath === ""
      ? undefined
      : `${params.dbPath}-wal`;
  active.observe(walPath);
  const db = params.db;
  const originalPrepare = db.prepare.bind(db);
  const originalTransaction = db.transaction.bind(db);

  db.prepare = ((source: string) => {
    const statement = originalPrepare(source);
    if (!WRITE_STATEMENT.test(source)) {
      return statement;
    }
    const table = TABLE_NAME.exec(source)?.[1] ?? "unknown";
    const originalRun = statement.run.bind(statement);
    statement.run = ((...args: unknown[]) => {
      const result = originalRun(...(args as never[]));
      active.record({
        changes: result.changes,
        // Inside an explicit transaction the commit belongs to the
        // transaction, not this statement; `transaction()` counts that one.
        committed: !db.inTransaction,
        table,
        walPath,
      });
      return result;
    }) as typeof statement.run;
    return statement;
  }) as typeof db.prepare;

  // `transaction()` hands back a callable that also carries .default /
  // .deferred / .immediate / .exclusive variants. They are NOT enumerable, so
  // copying them with Object.assign silently loses them and every
  // `tx.immediate(...)` caller dies with "is not a function" — which is how
  // `pr-auto-dispatch.test.ts` caught the first version of this. Wrap each
  // variant explicitly instead.
  const countTransaction = <T extends (...args: unknown[]) => unknown>(
    transactionFn: T,
  ): T =>
    ((...args: unknown[]) => {
      const nested = db.inTransaction;
      const result = transactionFn(...args);
      if (!nested) {
        active.recordExplicitCommit(walPath);
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
}

export type SqliteWriteDelta = {
  commits: number;
  rowsChanged: number;
  statements: number;
  tables: SqliteTableWriteMetrics[];
  walBytes: number;
};

/**
 * Measure only what `run` does.
 *
 * This is the seam that separates a scenario's cost from the cost of getting
 * ready to run it. Opening a database, applying migrations, and seeding rows
 * all happen outside the callback and are excluded by construction — no
 * classifying of writes after the fact, no guessing which INSERT was "setup".
 * A budget written against this therefore tracks the feature, and stays put
 * when a test's fixtures grow.
 */
export async function measureSqliteWrites<T>(
  run: () => T | Promise<T>,
): Promise<{ result: T; writes: SqliteWriteDelta }> {
  const before = collector?.snapshot("");
  const result = await run();
  const after = collector?.snapshot("");
  return { result, writes: diffSnapshots(before, after) };
}

function diffSnapshots(
  before: SqliteWriteMetricsSnapshot | undefined,
  after: SqliteWriteMetricsSnapshot | undefined,
): SqliteWriteDelta {
  if (!after) {
    return { commits: 0, rowsChanged: 0, statements: 0, tables: [], walBytes: 0 };
  }
  const baseline = new Map(
    (before?.tables ?? []).map((table) => [table.table, table]),
  );
  const tables: SqliteTableWriteMetrics[] = [];
  for (const table of after.tables) {
    const start = baseline.get(table.table);
    const delta = {
      commits: table.commits - (start?.commits ?? 0),
      rowsChanged: table.rowsChanged - (start?.rowsChanged ?? 0),
      statements: table.statements - (start?.statements ?? 0),
      table: table.table,
    };
    if (delta.statements > 0) {
      tables.push(delta);
    }
  }
  return {
    commits: after.commits - (before?.commits ?? 0),
    rowsChanged: after.rowsChanged - (before?.rowsChanged ?? 0),
    statements: after.statements - (before?.statements ?? 0),
    tables: tables.sort((left, right) => right.commits - left.commits),
    walBytes: after.walBytes - (before?.walBytes ?? 0),
  };
}

export function isSqliteWriteMetricsEnabled(): boolean {
  return Boolean(process.env[SQLITE_WRITE_METRICS_ENV]);
}

export function readSqliteWriteMetrics(
  label = "current",
): SqliteWriteMetricsSnapshot | undefined {
  return collector?.snapshot(label);
}

export function resetSqliteWriteMetrics(): void {
  collector?.reset();
}

/**
 * Append the current totals as one JSON line. The vitest setup and the E2E
 * harness both point `PWRAGENT_DEV_SQLITE_WRITE_METRICS_FILE` at a run-scoped
 * file so `report-sqlite-writes.mjs` can rank whatever produced it.
 */
let flushedStatements = 0;
let exitFlushRegistered = false;

export function flushSqliteWriteMetrics(label: string): void {
  const target = process.env[SQLITE_WRITE_METRICS_FILE_ENV];
  const snapshot = collector?.snapshot(label);
  if (!target || !snapshot || snapshot.statements === 0) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify(snapshot)}\n`);
    flushedStatements = snapshot.statements;
  } catch {
    // Instrumentation must never fail a run it is only observing.
  }
}

/**
 * The app never calls `flushSqliteWriteMetrics` itself — it has no idea when a
 * "run" ends — so a process that opened an instrumented database writes its
 * totals out as it exits. This is what makes an E2E run report at all: the
 * Electron main process is the thing doing the writing, and Playwright's
 * teardown only sees the file it leaves behind.
 *
 * `appendFileSync` is safe in an `exit` handler; async work there would not
 * run. A process killed with SIGKILL reports nothing, which is the honest
 * outcome — nothing can be flushed from a process that is already gone.
 */
function registerProcessExitFlush(): void {
  if (exitFlushRegistered) {
    return;
  }
  exitFlushRegistered = true;
  process.once("exit", () => {
    const snapshot = collector?.snapshot("");
    // Skip when an explicit flush (the vitest setup) already reported these
    // statements, so a worker's exit cannot double-count its own test file.
    if (!snapshot || snapshot.statements <= flushedStatements) {
      return;
    }
    flushSqliteWriteMetrics(resolveProcessLabel());
  });
}

function resolveProcessLabel(): string {
  const fixture = process.env.PWRAGENT_REPLAY_FIXTURE_PATH;
  if (fixture) {
    // One spec drives one replay fixture, so its directory names the run
    // better than a pid does.
    return `fixture:${path.basename(path.dirname(fixture))}`;
  }
  return `pid:${process.pid}`;
}
