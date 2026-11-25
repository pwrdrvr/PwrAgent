import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  BASELINE_REL_PATH,
  BASELINE_SCHEMA_VERSION,
  HEAVY_FIXTURE_MAX_NUM_RUNS,
  HIGH_NUM_RUNS_COMMENT_THRESHOLD,
  RULE_HEAVY_FIXTURE,
  RULE_HIGH_NUM_RUNS_COMMENT,
  analyzePropertyBudgetSource,
  evaluatePropertyBudgetBaseline,
  scanRepository,
  shrinkPropertyBudgetBaseline,
  validateBaselineObject,
} from "./lint-property-budget.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const HEAVY_FIXTURE_SNIPPETS = {
  gitExec: [
    'import { execFileSync } from "node:child_process";',
    'const run = () => execFileSync("git", ["status"]);',
  ].join("\n"),
  isolatedGit: 'import { runIsolatedGit } from "./helpers/isolated-git";',
  dugite: 'import { GitProcess } from "dugite";',
  stateDb: 'import { openInMemoryStateDb } from "./sqlite-test-utils";',
  stateDbClass: 'import { StateDb } from "../state/state-db";',
  betterSqlite: 'import Database from "better-sqlite3";',
  messagingHarness: 'import { messagingInboundHarness } from "./fixtures/messaging-inbound-harness";',
  childProcess: 'import { spawn } from "node:child_process";',
  testingLibrary: 'import { render } from "@testing-library/react";',
  testingLibraryHook: 'import { renderHook } from "@testing-library/react";',
  phaseProbes: 'import { render } from "../../../test/phase-probes";',
};

describe("analyzePropertyBudgetSource", () => {
  it("enforces heavy-fixture numRuns <= 5 and high-numRuns adjacent comment rules across generated inputs", () => {
    const fixtureArb = fc.constantFrom("pure", ...Object.keys(HEAVY_FIXTURE_SNIPPETS));
    const numRunsSpecArb = fc.oneof(
      fc.constant({ kind: "default", value: 100 }),
      fc.integer({ min: 1, max: 250 }).map((value) => ({ kind: "static", value })),
      fc.constant({ kind: "dynamic", value: null }),
    );
    const commentStyleArb = fc.constantFrom("none", "inline", "above-prop", "above-opts", "directive-only");

    fc.assert(
      fc.property(fixtureArb, numRunsSpecArb, commentStyleArb, (fixtureKey, spec, commentStyle) => {
        const isHeavy = fixtureKey !== "pure";
        const header = isHeavy ? HEAVY_FIXTURE_SNIPPETS[fixtureKey] : "";
        let call;
        if (spec.kind === "default") {
          call = "fc.assert(fc.property(fc.integer(), () => true));";
        } else {
          const expr = spec.kind === "dynamic" ? "dynamicRuns" : String(spec.value);
          if (commentStyle === "inline") {
            call = `fc.assert(fc.property(fc.integer(), () => true), { numRuns: ${expr} }); // Bug #1234 needed extra runs`;
          } else if (commentStyle === "above-prop") {
            call = [
              "fc.assert(fc.property(fc.integer(), () => true), {",
              "  // Bug #1234 needed extra runs",
              `  numRuns: ${expr},`,
              "});",
            ].join("\n");
          } else if (commentStyle === "above-opts") {
            call = [
              "fc.assert(",
              "  fc.property(fc.integer(), () => true),",
              "  // Bug #1234 needed extra runs",
              `  { numRuns: ${expr} },`,
              ");",
            ].join("\n");
          } else if (commentStyle === "directive-only") {
            call = `fc.assert(fc.property(fc.integer(), () => true), { numRuns: ${expr} }); // oxlint-disable-line`;
          } else {
            call = `fc.assert(fc.property(fc.integer(), () => true), { numRuns: ${expr} });`;
          }
        }

        const source = [
          'import fc from "fast-check";',
          header,
          "const dynamicRuns = Number(process.env.RUNS ?? 10);",
          call,
        ].join("\n");

        const result = analyzePropertyBudgetSource("sample.property.test.ts", source);
        const expectedHeavyViolation =
          isHeavy
          && (spec.kind === "default"
            || spec.kind === "dynamic"
            || spec.value > HEAVY_FIXTURE_MAX_NUM_RUNS);
        const hasRealComment =
          commentStyle === "inline"
          || commentStyle === "above-prop"
          || commentStyle === "above-opts";
        const expectedHighCommentViolation =
          spec.kind === "static"
          && spec.value > HIGH_NUM_RUNS_COMMENT_THRESHOLD
          && !hasRealComment;

        expect(result.heavyFixtures.length > 0).toBe(isHeavy);
        expect(result.violations.some((v) => v.rule === RULE_HEAVY_FIXTURE)).toBe(expectedHeavyViolation);
        expect(result.violations.some((v) => v.rule === RULE_HIGH_NUM_RUNS_COMMENT)).toBe(expectedHighCommentViolation);
      }),
    );
  });

  it("ignores type-only StateDb imports, mocked child_process, and non-render @testing-library helpers", () => {
    const source = [
      'import fc from "fast-check";',
      'import type { StateDb } from "../state/state-db";',
      'import { execFileSync } from "node:child_process";',
      'import { fireEvent, screen, within } from "@testing-library/react";',
      'import { vi } from "vitest";',
      'vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));',
      'const fakeSnippet = "import { StateDb } from \'../state/state-db\'; execFileSync(\'git\', [\'status\']);";',
      "type Holder = { db: StateDb };",
      "fc.assert(fc.property(fc.integer(), () => Boolean(execFileSync && fireEvent && screen && within && fakeSnippet)));",
    ].join("\n");

    const result = analyzePropertyBudgetSource("pure.property.test.tsx", source);
    expect(result.heavyFixtures).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("evaluates const bindings, conditional platform bounds, and namespace @testing-library.render", () => {
    const passing = [
      'import * as fc from "fast-check";',
      'import * as rtl from "@testing-library/react";',
      'const RUNS = process.platform === "win32" ? 2 : 5;',
      "const view = () => rtl.render(null);",
      "fc.assert(fc.property(fc.integer(), () => Boolean(view)), { numRuns: RUNS });",
    ].join("\n");
    const passingResult = analyzePropertyBudgetSource("bounded.property.test.tsx", passing);
    expect(passingResult.heavyFixtures).toEqual(["testing-library"]);
    expect(passingResult.violations).toEqual([]);

    const failing = [
      'import { assert, property, integer } from "fast-check";',
      'import * as rtl from "@testing-library/react";',
      'const RUNS = process.platform === "win32" ? 4 : 8;',
      "const view = () => rtl.render(null);",
      "assert(property(integer(), () => Boolean(view)), { numRuns: RUNS });",
    ].join("\n");
    const failingResult = analyzePropertyBudgetSource("over.property.test.tsx", failing);
    expect(failingResult.heavyFixtures).toEqual(["testing-library"]);
    expect(failingResult.violations).toHaveLength(1);
    expect(failingResult.violations[0]).toMatchObject({
      rule: RULE_HEAVY_FIXTURE,
      numRunsKind: "static",
      numRuns: 8,
    });
  });

  it("rejects comments separated by a blank line or buried inside the property callback for numRuns > 100", () => {
    const separated = [
      'import fc from "fast-check";',
      "fc.assert(",
      "  fc.property(fc.integer(), () => {",
      "    // Comment inside callback, not adjacent to numRuns.",
      "    return true;",
      "  }),",
      "  // Separated by a blank line.",
      "",
      "  { numRuns: 200 },",
      ");",
    ].join("\n");
    const result = analyzePropertyBudgetSource("separated.property.test.ts", separated);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      rule: RULE_HIGH_NUM_RUNS_COMMENT,
      numRuns: 200,
    });
  });

  it("accepts a comment on a const declaration referenced by numRuns > 100", () => {
    const withConstComment = [
      'import fc from "fast-check";',
      "// Bug #3347 required 150 runs to hit the four-step hold race.",
      "const RUNS = 150;",
      "fc.assert(fc.property(fc.integer(), () => true), { numRuns: RUNS });",
    ].join("\n");
    const result = analyzePropertyBudgetSource("const-comment.property.test.ts", withConstComment);
    expect(result.violations).toEqual([]);
  });

  it("catches fc.configureGlobal bypassing heavy or high-numRuns limits", () => {
    const source = [
      'import fc from "fast-check";',
      'import { openInMemoryStateDb } from "./sqlite-test-utils";',
      "void openInMemoryStateDb;",
      "fc.configureGlobal({ numRuns: 250 });",
    ].join("\n");
    const result = analyzePropertyBudgetSource("global-config.property.test.ts", source);
    expect(result.violations.map((v) => v.rule)).toEqual([
      RULE_HEAVY_FIXTURE,
      RULE_HIGH_NUM_RUNS_COMMENT,
    ]);
  });
});

describe("property budget baseline ratchet", () => {
  it("passes iff every (file, rule) count is at or below baseline, and shrink is strictly monotonic", () => {
    const fileNames = ["a.test.ts", "b.test.ts", "c.test.ts"];
    const countsArb = fc.record({
      [RULE_HEAVY_FIXTURE]: fc.integer({ min: 0, max: 6 }),
      [RULE_HIGH_NUM_RUNS_COMMENT]: fc.integer({ min: 0, max: 4 }),
    });
    const pairArb = fc.tuple(
      fc.tuple(...fileNames.map(() => countsArb)),
      fc.tuple(...fileNames.map(() => countsArb)),
    );

    fc.assert(
      fc.property(pairArb, ([baselineTuple, actualTuple]) => {
        const baselineFiles = {};
        const violationsByFile = new Map();
        let expectedOk = true;

        fileNames.forEach((file, index) => {
          const base = baselineTuple[index];
          const actual = actualTuple[index];
          const baseEntry = {};
          if (base[RULE_HEAVY_FIXTURE] > 0) baseEntry[RULE_HEAVY_FIXTURE] = base[RULE_HEAVY_FIXTURE];
          if (base[RULE_HIGH_NUM_RUNS_COMMENT] > 0) baseEntry[RULE_HIGH_NUM_RUNS_COMMENT] = base[RULE_HIGH_NUM_RUNS_COMMENT];
          if (Object.keys(baseEntry).length > 0) baselineFiles[file] = baseEntry;

          const violations = [];
          for (let i = 0; i < actual[RULE_HEAVY_FIXTURE]; i += 1) {
            violations.push({ rule: RULE_HEAVY_FIXTURE, line: i + 1, numRunsKind: "default", numRuns: 100, heavyFixtures: ["state-db"] });
          }
          for (let i = 0; i < actual[RULE_HIGH_NUM_RUNS_COMMENT]; i += 1) {
            violations.push({ rule: RULE_HIGH_NUM_RUNS_COMMENT, line: i + 20, numRunsKind: "static", numRuns: 200, heavyFixtures: [] });
          }
          if (violations.length > 0) violationsByFile.set(file, violations);

          if (
            actual[RULE_HEAVY_FIXTURE] > base[RULE_HEAVY_FIXTURE]
            || actual[RULE_HIGH_NUM_RUNS_COMMENT] > base[RULE_HIGH_NUM_RUNS_COMMENT]
          ) {
            expectedOk = false;
          }
        });

        const baseline = {
          schemaVersion: BASELINE_SCHEMA_VERSION,
          rules: {
            heavyFixtureMaxNumRuns: HEAVY_FIXTURE_MAX_NUM_RUNS,
            highNumRunsCommentThreshold: HIGH_NUM_RUNS_COMMENT_THRESHOLD,
          },
          files: baselineFiles,
        };

        const evalResult = evaluatePropertyBudgetBaseline(violationsByFile, baseline);
        expect(evalResult.ok).toBe(expectedOk);

        const shrinkResult = shrinkPropertyBudgetBaseline(baseline, violationsByFile);
        expect(shrinkResult.ok).toBe(expectedOk);
        if (shrinkResult.ok) {
          expect(validateBaselineObject(shrinkResult.nextBaseline)).toEqual([]);
          // Monotonicity: no new files, and every rule count <= previous baseline.
          for (const [file, counts] of Object.entries(shrinkResult.nextBaseline.files)) {
            expect(baseline.files[file]).toBeDefined();
            for (const [rule, count] of Object.entries(counts)) {
              expect(count).toBeLessThanOrEqual(baseline.files[file][rule]);
            }
          }
          // Re-evaluating against the shrunk baseline passes with 0 shrinkable entries.
          const after = evaluatePropertyBudgetBaseline(violationsByFile, shrinkResult.nextBaseline);
          expect(after.ok).toBe(true);
          expect(after.shrinkable).toEqual([]);
        }
      }),
    );
  });

  it("matches the checked-in repository baseline with zero regressions", () => {
    const baseline = JSON.parse(readFileSync(resolve(REPO_ROOT, BASELINE_REL_PATH), "utf8"));
    expect(validateBaselineObject(baseline)).toEqual([]);

    const { violationsByFile } = scanRepository(REPO_ROOT);
    const evaluation = evaluatePropertyBudgetBaseline(violationsByFile, baseline);
    expect(evaluation.ok).toBe(true);
    expect(evaluation.regressions).toEqual([]);
  });
});
