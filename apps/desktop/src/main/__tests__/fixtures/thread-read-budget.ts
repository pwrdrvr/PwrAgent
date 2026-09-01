import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

/**
 * Checked-in provider-read budgets for thread information, asserted per
 * scenario.
 *
 * A thread-list walk is the most expensive read PwrAgent makes: it pages the
 * provider, and for most caller reasons it then enriches every row with git and
 * directory work. Nothing counted these, so the cost of answering "what is this
 * thread called" grew a caller at a time and only ever surfaced as a UI symptom
 * — a quit dialog showing uuids, a sidebar row flickering — long after the read
 * that caused it.
 *
 * These budgets make each flow's read cost a reviewable number. A scenario
 * records provider `thread/list` calls and directory-enrichment passes, both
 * pure functions of the code path, so they are identical on every machine.
 *
 * To change a budget deliberately, run with `UPDATE_THREAD_READ_BUDGETS=1` and
 * commit the diff, so the reviewer sees the read cost change as a line in the
 * PR instead of never seeing it at all.
 */
const BUDGETS_PATH = path.join(import.meta.dirname, "thread-read-budgets.json");

export type ThreadReadCounts = {
  /** Directory/git enrichment passes over a listing. */
  directoryEnrichments: number;
  /** Provider `thread/list` round trips. */
  providerListCalls: number;
};

type Budget = ThreadReadCounts & { note: string };

type BudgetFile = Record<string, Budget>;

export function expectThreadReadBudget(params: {
  note: string;
  reads: ThreadReadCounts;
  scenario: string;
}): void {
  const budgets = readBudgets();
  const measured: Budget = {
    directoryEnrichments: params.reads.directoryEnrichments,
    note: params.note,
    providerListCalls: params.reads.providerListCalls,
  };

  if (process.env.UPDATE_THREAD_READ_BUDGETS) {
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
      `No thread read budget recorded for "${params.scenario}".\n`
        + `Measured ${describe(measured)}.\n`
        + "Record it with UPDATE_THREAD_READ_BUDGETS=1 and commit the result.",
    );
  }

  // Deviation in either direction fails. An increase is the regression this
  // exists to catch; a decrease means the budget is stale and would stop
  // catching anything, so it has to be lowered on purpose.
  expect(
    {
      directoryEnrichments: measured.directoryEnrichments,
      providerListCalls: measured.providerListCalls,
    },
    `thread read budget "${params.scenario}" changed.\n`
      + `  budget:   ${describe(budget)}\n`
      + `  measured: ${describe(measured)}\n`
      + "If this is intended, re-record with UPDATE_THREAD_READ_BUDGETS=1 and\n"
      + "explain the change in the commit message. If it is not, you have added\n"
      + "provider thread reads to a path that is measured for a reason.",
  ).toEqual({
    directoryEnrichments: budget.directoryEnrichments,
    providerListCalls: budget.providerListCalls,
  });
}

function describe(budget: Budget): string {
  return (
    `${budget.providerListCalls} provider thread/list calls, `
    + `${budget.directoryEnrichments} directory enrichments`
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
