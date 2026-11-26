import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  listTestFiles,
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

  it("scopes const numbers and objects lexically and masks outer constants on shadowing", () => {
    const source = [
      'import fc from "fast-check";',
      'import { openInMemoryStateDb } from "./sqlite-test-utils";',
      "void openInMemoryStateDb;",
      "const RUNS = 5;",
      'it("earlier high runs is not hidden by a later local const", () => {',
      "  const runs = 500;",
      "  fc.assert(fc.property(fc.integer(), () => true), { numRuns: runs });",
      "});",
      'it("compliant local options object is not clobbered by a later unrelated options", () => {',
      "  const options = { numRuns: 5 };",
      "  fc.assert(fc.property(fc.integer(), () => true), options);",
      "});",
      'it("later unrelated local declarations", () => {',
      "  const runs = 5;",
      "  const options = { cwd: '/tmp' };",
      "  void runs; void options;",
      "});",
      'it("parameter shadows outer static const as dynamic", (RUNS) => {',
      "  fc.assert(fc.property(fc.integer(), () => true), { numRuns: RUNS });",
      "});",
      'it("inner dynamic const shadows outer static const as dynamic", () => {',
      "  const RUNS = Number(process.env.RUNS ?? 10);",
      "  fc.assert(fc.property(fc.integer(), () => true), { numRuns: RUNS });",
      "});",
    ].join("\n");

    const result = analyzePropertyBudgetSource("scoped.property.test.ts", source);
    expect(result.violations.map((v) => [v.rule, v.numRunsKind, v.numRuns])).toEqual([
      [RULE_HEAVY_FIXTURE, "static", 500],
      [RULE_HIGH_NUM_RUNS_COMMENT, "static", 500],
      [RULE_HEAVY_FIXTURE, "dynamic", null],
      [RULE_HEAVY_FIXTURE, "dynamic", null],
    ]);
  });

  it("unwraps TypeScript assertions and parenthesized expressions when evaluating numRuns", () => {
    const failing = [
      'import fc from "fast-check";',
      "fc.assert(fc.property(fc.integer(), () => true), { numRuns: 500 } as const);",
      "fc.assert(fc.property(fc.integer(), () => true), { numRuns: (250) } satisfies { numRuns: number });",
    ].join("\n");
    const failingResult = analyzePropertyBudgetSource("ts-unwrap-fail.property.test.ts", failing);
    expect(failingResult.violations.map((v) => [v.rule, v.numRuns])).toEqual([
      [RULE_HIGH_NUM_RUNS_COMMENT, 500],
      [RULE_HIGH_NUM_RUNS_COMMENT, 250],
    ]);

    const passing = [
      'import fc from "fast-check";',
      'import { openInMemoryStateDb } from "./sqlite-test-utils";',
      "void openInMemoryStateDb;",
      "const OPTS = ({ numRuns: (2 + 3) as number } as const) satisfies { numRuns: number };",
      "fc.assert(fc.property(fc.integer(), () => true), OPTS);",
      "fc.assert(fc.property(fc.integer(), () => true), { ...OPTS } as const);",
    ].join("\n");
    const passingResult = analyzePropertyBudgetSource("ts-unwrap-pass.property.test.ts", passing);
    expect(passingResult.heavyFixtures).toEqual(["state-db"]);
    expect(passingResult.violations).toEqual([]);
  });

  it("does not misclassify non-child_process .exec calls or mocked dugite/StateDb modules as heavy", () => {
    const source = [
      'import fc from "fast-check";',
      'import { GitProcess } from "dugite";',
      'import { StateDb } from "../state/state-db";',
      'import { openInMemoryStateDb } from "./sqlite-test-utils";',
      'import { vi } from "vitest";',
      'vi.mock("dugite", () => ({ GitProcess: { exec: vi.fn() } }));',
      'vi.mock("../state/state-db", () => ({ StateDb: Object.assign(vi.fn(), { open: vi.fn() }) }));',
      'vi.mock("./sqlite-test-utils", () => ({ openInMemoryStateDb: vi.fn() }));',
      'const mockRunner = { exec: (cmd: string) => cmd };',
      'const match = /^git\\s+/.exec("git status");',
      'mockRunner.exec("git status");',
      'GitProcess.exec(["status"], "/tmp");',
      'StateDb.open(":memory:");',
      'new StateDb(":memory:");',
      'openInMemoryStateDb();',
      "fc.assert(fc.property(fc.integer(), () => Boolean(match)));",
    ].join("\n");

    const result = analyzePropertyBudgetSource("mocked-and-regex.property.test.ts", source);
    expect(result.heavyFixtures).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("inspects fc.check and named check imports alongside fc.assert", () => {
    const source = [
      'import fc, { check } from "fast-check";',
      'import { openInMemoryStateDb } from "./sqlite-test-utils";',
      "void openInMemoryStateDb;",
      "fc.check(fc.property(fc.integer(), () => true));",
      "check(fc.property(fc.integer(), () => true), { numRuns: 200 });",
      "fc.check(fc.property(fc.integer(), () => true), { numRuns: 5 });",
    ].join("\n");

    const result = analyzePropertyBudgetSource("check-runner.property.test.ts", source);
    expect(result.violations.map((v) => [v.rule, v.numRunsKind, v.numRuns])).toEqual([
      [RULE_HEAVY_FIXTURE, "default", 100],
      [RULE_HEAVY_FIXTURE, "static", 200],
      [RULE_HIGH_NUM_RUNS_COMMENT, "static", 200],
    ]);
  });

  it("accepts an explanatory comment above numRuns > 100 when a directive comment intervenes without a blank line", () => {
    const source = [
      'import fc from "fast-check";',
      "fc.assert(fc.property(fc.integer(), () => true), {",
      "  // Bug #3347 required 200 runs to hit the four-step hold race.",
      "  // oxlint-disable-next-line some-rule",
      "  numRuns: 200,",
      "});",
    ].join("\n");

    const result = analyzePropertyBudgetSource("directive-between.property.test.ts", source);
    expect(result.violations).toEqual([]);
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

  // The repository scan itself runs as `pnpm lint:property-budget` in the
  // Lint job. It parses every fast-check test file, about 950 of them, and
  // can exceed the default 5 s unit test timeout on slower CI runners.
  it("keeps the checked-in baseline well formed", () => {
    const baseline = JSON.parse(readFileSync(resolve(REPO_ROOT, BASELINE_REL_PATH), "utf8"));
    expect(validateBaselineObject(baseline)).toEqual([]);
  });

  it("scans a tree's test files into violations keyed by POSIX path, whatever their line endings", () => {
    const root = mkdtempSync(join(tmpdir(), "pwragent-property-budget-scan-"));
    try {
      const testsDir = join(root, "apps", "desktop", "src", "__tests__");
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(join(testsDir, "heavy.property.test.ts"), [
        HEAVY_FIXTURE_SNIPPETS.stateDb,
        'import fc from "fast-check";',
        "",
        "fc.assert(fc.property(fc.integer(), () => true), { numRuns: 6 });",
        "",
      ].join("\r\n"));
      writeFileSync(join(testsDir, "pure.test.ts"), 'import { it } from "vitest";\n');

      // Ignored directories and non-test source files must not be scanned.
      const ignoredNodeModules = join(root, "apps", "desktop", "node_modules", "pkg");
      const ignoredLocal = join(root, "apps", "desktop", ".local");
      mkdirSync(ignoredNodeModules, { recursive: true });
      mkdirSync(ignoredLocal, { recursive: true });
      const violationSnippet = 'import fc from "fast-check";\nfc.assert(fc.property(fc.integer(), () => true), { numRuns: 500 });\n';
      writeFileSync(join(ignoredNodeModules, "ignored.test.ts"), violationSnippet);
      writeFileSync(join(ignoredLocal, "ignored.test.ts"), violationSnippet);
      writeFileSync(join(testsDir, "not-a-test.ts"), violationSnippet);

      const { scannedFiles, violationsByFile } = scanRepository(root);
      expect(scannedFiles).toBe(2);
      expect([...violationsByFile.keys()]).toEqual(["apps/desktop/src/__tests__/heavy.property.test.ts"]);
      expect(violationsByFile.get("apps/desktop/src/__tests__/heavy.property.test.ts")
        .map((violation) => [violation.rule, violation.line, violation.numRuns]))
        .toEqual([[RULE_HEAVY_FIXTURE, 4, 6]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists repository test files by POSIX path, as baseline keys name them", () => {
    const files = listTestFiles(REPO_ROOT);
    expect(files).toContain("scripts/lint-property-budget.test.mjs");
    expect(files.filter((file) => file.includes("\\"))).toEqual([]);
  });
});
