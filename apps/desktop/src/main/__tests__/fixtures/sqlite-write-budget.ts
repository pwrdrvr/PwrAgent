import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { SqliteWriteDelta } from "./sqlite-write-metrics";

const BUDGETS_PATH = path.join(import.meta.dirname, "sqlite-write-budgets.json");

type Budget = {
  commits: number;
  note: string;
  observedWalBytes: number;
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
      `No sqlite write budget recorded for "${params.scenario}". `
        + "Record it with UPDATE_SQLITE_WRITE_BUDGETS=1.",
    );
  }
  expect(
    {
      commits: measured.commits,
      rowsChanged: measured.rowsChanged,
      statements: measured.statements,
    },
    `sqlite write budget "${params.scenario}" changed; `
      + "re-record only when the write-volume change is intentional.",
  ).toEqual({
    commits: budget.commits,
    rowsChanged: budget.rowsChanged,
    statements: budget.statements,
  });
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
