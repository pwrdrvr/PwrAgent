import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { SqliteWriteDelta } from "../../state/sqlite-write-metrics";

/**
 * Checked-in write budgets, asserted per scenario.
 *
 * A budget records what one feature costs sqlite, measured around the feature
 * itself — `measureSqliteWrites` excludes database setup and fixture seeding
 * by construction, so these numbers move when the *feature's* write pattern
 * moves and stay put when a test grows more setup.
 *
 * **Only the deterministic counters are asserted.** Commits, write statements,
 * and rows changed are a pure function of the code path: same operations, same
 * numbers, on any machine under any load. WAL bytes are not — page fill and
 * checkpoint timing move them run to run — so bytes are recorded for humans to
 * read and never assert. Commits are the useful proxy for volume anyway, since
 * each one flushes its dirty pages plus every index the row moved.
 *
 * A scenario that commits but records zero bytes is rejected: that is not a
 * measurement, it is a database with no WAL file. See `openInMemoryStateDb`.
 *
 * To change a budget deliberately, run with `UPDATE_SQLITE_WRITE_BUDGETS=1`
 * and commit the diff. A reviewer then sees the write cost change as a line in
 * the PR instead of never seeing it at all.
 */
const BUDGETS_PATH = path.join(import.meta.dirname, "sqlite-write-budgets.json");

type Budget = {
  commits: number;
  observedWalBytes: number;
  note: string;
  rowsChanged: number;
  statements: number;
};

type BudgetFile = Record<string, Budget>;

export function expectSqliteWriteBudget(params: {
  note: string;
  scenario: string;
  budgetFile?: string;
  writes: Omit<SqliteWriteDelta, "tables"> & Partial<Pick<SqliteWriteDelta, "tables">>;
}): void {
  const budgetPath = params.budgetFile ? path.join(import.meta.dirname, params.budgetFile) : BUDGETS_PATH;
  const { budgets, source } = readBudgets(budgetPath);
  const measured: Budget = {
    commits: params.writes.commits,
    note: params.note,
    observedWalBytes: params.writes.walBytes,
    rowsChanged: params.writes.rowsChanged,
    statements: params.writes.statements,
  };

  if (process.env.UPDATE_SQLITE_WRITE_BUDGETS) {
    writeFileSync(
      budgetPath,
      recordBudget(source, budgets, params.scenario, measured),
    );
    return;
  }

  const budget = budgets[params.scenario];
  if (!budget) {
    throw new Error(
      `No sqlite write budget recorded for "${params.scenario}".\n`
        + `Measured ${describe(measured)}.\n`
        + "Record it with UPDATE_SQLITE_WRITE_BUDGETS=1 and commit the result.",
    );
  }

  // Bytes are never asserted, but losing them entirely is deterministic and
  // is not a measurement — it means the scenario moved to a database with no
  // WAL file. `attachSqliteWriteMetrics` resolves no WAL path for `:memory:`,
  // so a suite converted to `openInMemoryStateDb` keeps every counter below
  // and silently re-records this scenario's MB/day as zero.
  if (
    budget.observedWalBytes > 0
    && measured.observedWalBytes === 0
    && measured.commits > 0
  ) {
    throw new Error(
      `sqlite write budget "${params.scenario}" recorded no WAL growth `
        + `after ${measured.commits} commits, but its budget records `
        + `${budget.observedWalBytes} bytes.\n`
        + "An in-memory database has no WAL file. Open this scenario's\n"
        + "database from a real path so the MB/day figure stays measurable.",
    );
  }

  // Deviation in either direction fails. An increase is the regression this
  // exists to catch; a decrease means the budget is stale and would stop
  // catching anything, so it has to be lowered on purpose.
  expect(
    {
      commits: measured.commits,
      rowsChanged: measured.rowsChanged,
      statements: measured.statements,
    },
    `sqlite write budget "${params.scenario}" changed.\n`
      + `  budget:   ${describe(budget)}\n`
      + `  measured: ${describe(measured)}\n`
      + "If this is intended, re-record with UPDATE_SQLITE_WRITE_BUDGETS=1 and\n"
      + "explain the change in the commit message. If it is not, you have added\n"
      + "sqlite writes to a path that is measured for a reason.",
  ).toEqual({
    commits: budget.commits,
    rowsChanged: budget.rowsChanged,
    statements: budget.statements,
  });
}

function describe(budget: Budget): string {
  return (
    `${budget.commits} commits, ${budget.statements} statements, `
    + `${budget.rowsChanged} rows (~${(budget.observedWalBytes / 1024).toFixed(0)} KB WAL)`
  );
}

function readBudgets(budgetPath = BUDGETS_PATH): { budgets: BudgetFile; source: string } {
  try {
    const source = readFileSync(budgetPath, "utf8");
    return { budgets: JSON.parse(source) as BudgetFile, source };
  } catch {
    return { budgets: {}, source: "{}\n" };
  }
}

function recordBudget(source: string, budgets: BudgetFile, scenario: string, measured: Budget): string {
  const fields = Object.entries(measured)
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(", ");
  const entry = `${JSON.stringify(scenario)}: {${fields}}`;
  let depth = 0;
  let key: string | undefined;
  let start = 0;
  // Tokenize strings together so braces and escaped quotes in notes cannot
  // terminate a budget. Only replace the selected top-level key and object;
  // its indentation, comma and every surrounding byte stay where they were.
  for (const token of source.matchAll(/"(?:[^"\\]|\\.)*"|[{}]/g)) {
    if (token[0] === "{") {
      depth++;
    } else if (token[0] === "}") {
      depth--;
      if (depth === 1 && key === scenario) {
        return source.slice(0, start) + entry + source.slice(token.index + 1);
      }
    } else if (depth === 1) {
      key = JSON.parse(token[0]) as string;
      start = token.index;
    }
  }

  // Prepend new scenarios so the former last entry needs no comma change.
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const opening = source.indexOf("{") + 1;
  const suffix = source.slice(opening);
  return source.slice(0, opening) + newline + "  " + entry
    + (Object.keys(budgets).length ? "," : "")
    + (suffix.startsWith(newline) ? "" : newline) + suffix;
}
