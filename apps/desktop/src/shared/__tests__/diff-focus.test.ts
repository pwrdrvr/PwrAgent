import { describe, expect, it } from "vitest";
import {
  buildDiffView,
  getFocusedDiffEligibility,
  parseUnifiedDiff,
  summarizeHunksForFocus
} from "../diff-focus";

describe("diff-focus", () => {
  it("parses single-hunk diffs and keeps zoom controls off for simple patches", () => {
    const parsed = parseUnifiedDiff(
      [
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1,3 +1,3 @@",
        " const alpha = 1;",
        "-const beta = 2;",
        "+const beta = 3;",
        " export { alpha, beta };"
      ].join("\n")
    );

    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.stats.smallHunkCount).toBe(1);
    expect(getFocusedDiffEligibility(parsed)).toMatchObject({
      eligible: false,
      reason: "too_few_hunks"
    });
    expect(buildDiffView(parsed, { mode: "full" }).hasHiddenContent).toBe(false);
  });

  it("marks noisy multi-hunk diffs as focus-eligible and summarizes them", () => {
    const parsed = parseUnifiedDiff(
      [
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1,7 +1,7 @@",
        " import { alpha } from './alpha';",
        "-import { beta } from './beta';",
        "+import { beta } from './beta/index';",
        " const keep = 1;",
        " const keep2 = 2;",
        " const keep3 = 3;",
        " const keep4 = 4;",
        "@@ -18,7 +18,7 @@",
        " function one() {",
        "   return keep;",
        "-  // old comment",
        "+  // refreshed comment",
        " }",
        " ",
        " export function two() {",
        "@@ -34,7 +34,7 @@",
        " export function three() {",
        "   return 'three';",
        "-  const label = 'before';",
        "+  const label = 'after';",
        "   return label;",
        " }",
        " ",
        " export function four() {",
        "@@ -50,7 +50,7 @@",
        " export function five() {",
        "   return 'five';",
        "-  // lint",
        "+  // linted",
        " }",
        " ",
        " export const six = 6;"
      ].join("\n")
    );

    expect(parsed.hunks).toHaveLength(4);
    expect(getFocusedDiffEligibility(parsed)).toMatchObject({
      eligible: true,
      reason: "eligible"
    });
    expect(buildDiffView(parsed, { mode: "condensed" }).hiddenContextLineCount).toBeGreaterThan(0);
    const summaries = summarizeHunksForFocus(parsed);
    expect(summaries).toHaveLength(4);
    expect(summaries.slice(0, 2)).toMatchObject([
      expect.objectContaining({
        index: 0,
        changedLineCount: 2
      }),
      expect.objectContaining({
        index: 1,
        changedLineCount: 2
      })
    ]);
  });

  it("keeps adjacent hunks distinct and strips patch headers from content rows", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/src/example.ts b/src/example.ts",
        "index 123..456 100644",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1,2 +1,2 @@",
        "-const alpha = 1;",
        "+const alpha = 2;",
        "@@ -4,2 +4,2 @@",
        "-const beta = 3;",
        "+const beta = 4;"
      ].join("\n")
    );

    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[0]?.rows).toEqual([
      {
        kind: "removed",
        hunkIndex: 0,
        oldNumber: 1,
        text: "const alpha = 1;"
      },
      {
        kind: "added",
        hunkIndex: 0,
        newNumber: 1,
        text: "const alpha = 2;"
      }
    ]);
    expect(parsed.hunks[1]?.rows).toEqual([
      {
        kind: "removed",
        hunkIndex: 1,
        oldNumber: 4,
        text: "const beta = 3;"
      },
      {
        kind: "added",
        hunkIndex: 1,
        newNumber: 4,
        text: "const beta = 4;"
      }
    ]);
  });

  it("returns a safe empty model for blank diffs", () => {
    const parsed = parseUnifiedDiff("");

    expect(parsed).toEqual({
      hunks: [],
      stats: {
        hunkCount: 0,
        changedLineCount: 0,
        contextLineCount: 0,
        smallHunkCount: 0
      }
    });
    expect(getFocusedDiffEligibility(parsed)).toMatchObject({
      eligible: false,
      reason: "too_few_hunks"
    });
    expect(buildDiffView(parsed, { mode: "full" })).toMatchObject({
      rows: [],
      hasHiddenContent: false
    });
  });
});
