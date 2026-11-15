import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

let tempDir: string;
let budgetPath: string;
let budgetFile: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "sqlite-write-budget-"));
  budgetPath = path.join(tempDir, "budgets.json");
  budgetFile = path.relative(path.join(import.meta.dirname, "fixtures"), budgetPath);
  vi.stubEnv("UPDATE_SQLITE_WRITE_BUDGETS", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tempDir, { recursive: true, force: true });
});

const budgetArb = fc.record({
  commits: fc.nat({ max: 1000 }),
  note: fc.string(),
  observedWalBytes: fc.nat({ max: 1_000_000 }),
  rowsChanged: fc.nat({ max: 1000 }),
  statements: fc.nat({ max: 1000 }),
});

type Budget = typeof budgetArb extends fc.Arbitrary<infer Value> ? Value : never;

function record(scenario: string, budget: Budget): void {
  expectSqliteWriteBudget({
    budgetFile,
    scenario,
    note: budget.note,
    writes: {
      commits: budget.commits,
      rowsChanged: budget.rowsChanged,
      statements: budget.statements,
      tables: [],
      walBytes: budget.observedWalBytes,
    },
  });
}

describe("sqlite write budget recording", () => {
  // The original file's lines are the oracle: removing the changed scenario
  // from both versions must leave identical bytes in identical order.
  it.each(["update", "add"] as const)("%s changes only its scenario line", (operation) => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.tuple(fc.string(), budgetArb), {
        minLength: 1, maxLength: 8, selector: ([key]) => key,
      }),
      budgetArb,
      fc.nat(),
      fc.constantFrom("\n", "\r\n"),
      fc.boolean(),
      (entries, measured, choice, newline, trailingNewline) => {
        const index = choice % entries.length;
        const scenario = operation === "update" ? entries[index][0] : "new:" + entries[index][0];
        fc.pre(operation === "update" || !entries.some(([key]) => key === scenario));
        const originalLines = [
          "{",
          ...entries.map(([key, budget], entryIndex) =>
            `  ${JSON.stringify(key)}: ${JSON.stringify(budget)}${entryIndex < entries.length - 1 ? "," : ""}`),
          "}",
          ...(trailingNewline ? [""] : []),
        ];
        writeFileSync(budgetPath, originalLines.join(newline));

        record(scenario, measured);

        const actual = readFileSync(budgetPath, "utf8");
        const updatedLines = actual.split(newline);
        const changedIndex = updatedLines.findIndex((line) => line.startsWith(`  ${JSON.stringify(scenario)}:`));
        expect(changedIndex).toBeGreaterThan(0);
        if (operation === "update") expect(changedIndex).toBe(index + 1);
        expect(updatedLines.filter((_, lineIndex) => lineIndex !== changedIndex).join(newline))
          .toBe(originalLines.filter((_, lineIndex) => operation === "add" || lineIndex !== index + 1).join(newline));
        expect(JSON.parse(actual)).toEqual(Object.fromEntries([
          ...entries,
          [scenario, measured],
        ]));
      },
    ));
  });

  it.each(["z-last", "a-first", "middle"])("updates %s in place using the committed compact style", (scenario) => {
    const original = "{\n"
      + '  "z-last": {"commits": 0, "note": "old", "observedWalBytes": 0, "rowsChanged": 0, "statements": 0},\n'
      + '  "a-first": {"commits": 0, "note": "old", "observedWalBytes": 0, "rowsChanged": 0, "statements": 0},\n'
      + '  "middle": {"commits": 0, "note": "old", "observedWalBytes": 0, "rowsChanged": 0, "statements": 0}\n'
      + "}\n";
    writeFileSync(budgetPath, original);
    record(scenario, { commits: 1, note: "new", observedWalBytes: 4096, rowsChanged: 2, statements: 3 });
    expect(readFileSync(budgetPath, "utf8")).toBe(original.replace(
      `"${scenario}": {"commits": 0, "note": "old", "observedWalBytes": 0, "rowsChanged": 0, "statements": 0}`,
      `"${scenario}": {"commits": 1, "note": "new", "observedWalBytes": 4096, "rowsChanged": 2, "statements": 3}`,
    ));
  });

  it("preserves unrelated legacy multiline entries when inserting a scenario", () => {
    const original = '{\n  "legacy": {\n    "note": "braces } { and \\\"quotes\\\"",\n    "commits": 7\n  }\n}\n';
    writeFileSync(budgetPath, original);
    record("new", { commits: 0, note: "idle", observedWalBytes: 0, rowsChanged: 0, statements: 0 });
    expect(readFileSync(budgetPath, "utf8")).toBe(original.replace(
      "{\n",
      '{\n  "new": {"commits": 0, "note": "idle", "observedWalBytes": 0, "rowsChanged": 0, "statements": 0},\n',
    ));
  });

  it("updates an escaped key in a legacy multiline entry without touching its neighbors", () => {
    const target = '"\\u0061": {\n    "note": "braces } { and \\\"quotes\\\"",\n    "commits": 7\n  }';
    const original = '{\n  "z": {"commits": 0},\n  ' + target + ',\n  "b": {"commits": 0}\n}\n';
    writeFileSync(budgetPath, original);
    const measured = { commits: 1, note: 'new } { "quote" \\ slash\nline', observedWalBytes: 4096, rowsChanged: 2, statements: 3 };
    record("a", measured);
    const actual = readFileSync(budgetPath, "utf8");
    const replacement = actual.split("\n")[2].trim().replace(/,$/, "");
    expect(actual).toBe(original.replace(target, replacement));
    expect(JSON.parse(actual).a).toEqual(measured);
  });

  it("keeps a single empty-name scenario compact without adding a final newline", () => {
    const original = '{\n  "": {"commits":0,"note":"","observedWalBytes":0,"rowsChanged":0,"statements":0}\n}';
    writeFileSync(budgetPath, original);
    record("", { commits: 0, note: "", observedWalBytes: 0, rowsChanged: 0, statements: 0 });
    expect(readFileSync(budgetPath, "utf8")).toBe(
      '{\n  "": {"commits": 0, "note": "", "observedWalBytes": 0, "rowsChanged": 0, "statements": 0}\n}',
    );
  });

  it.each([undefined, "{}\n"])("creates a compact first scenario in a missing or empty file (%s)", (original) => {
    if (original !== undefined) writeFileSync(budgetPath, original);
    record("first", { commits: 0, note: "idle", observedWalBytes: 0, rowsChanged: 0, statements: 0 });
    expect(readFileSync(budgetPath, "utf8")).toBe(
      '{\n  "first": {"commits": 0, "note": "idle", "observedWalBytes": 0, "rowsChanged": 0, "statements": 0}\n}\n',
    );
  });
});
