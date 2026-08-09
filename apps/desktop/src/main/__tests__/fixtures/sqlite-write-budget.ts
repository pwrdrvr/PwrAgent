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
  writes: SqliteWriteDelta;
}): void {
  const budgets = readBudgets();
  const measured: Budget = {
    commits: params.writes.commits,
    note: params.note,
    observedWalBytes: params.writes.walBytes,
    rowsChanged: params.writes.rowsChanged,
    statements: params.writes.statements,
  };

  if (process.env.UPDATE_SQLITE_WRITE_BUDGETS) {
    budgets[params.scenario] = measured;
    writeFileSync(
      BUDGETS_PATH,
      `${JSON.stringify(sortKeys(budgets), null, 2)}\n`,
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

function readBudgets(): BudgetFile {
  try {
    return JSON.parse(readFileSync(BUDGETS_PATH, "utf8")) as BudgetFile;
  } catch {
    return {};
  }
}

function sortKeys(budgets: BudgetFile): BudgetFile {
  return Object.fromEntries(
    Object.entries(budgets).sort(([left], [right]) => left.localeCompare(right)),
  );
}
