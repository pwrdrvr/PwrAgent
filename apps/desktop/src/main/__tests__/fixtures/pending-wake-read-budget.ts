import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

const FILE = path.join(import.meta.dirname, "pending-wake-read-budgets.json");

/** Exact counts make an intended read-cost change a checked-in diff. */
export function expectPendingWakeReadBudget(scenario: string, measured: Record<string, number>): void {
  const budgets = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, Record<string, number>>;
  if (process.env.UPDATE_PENDING_WAKE_READ_BUDGETS === "1") {
    budgets[scenario] = measured;
    writeFileSync(FILE, "{\n" + Object.entries(budgets).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, counts]) => `  ${JSON.stringify(name)}: ${JSON.stringify(counts)}`).join(",\n") + "\n}\n");
    return;
  }
  expect(measured, `Pending wake read budget ${scenario} changed; record deliberate changes with UPDATE_PENDING_WAKE_READ_BUDGETS=1.`)
    .toEqual(budgets[scenario]);
}
