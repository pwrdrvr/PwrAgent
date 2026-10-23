import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeReviewOutput,
  isClaudeOutcomeReport,
  matchClaudeFindingOutcomes,
  parseClaudeFindingsReport,
} from "../claude/claude-review-findings";
import { normalizeReviewOutputRecord } from "../../shared/review-command";

const cwd = path.resolve("/fixture/repo");

const reported = {
  level: "high",
  findings: [
    {
      file: "src/state.ts",
      line: 7511,
      summary: "An access-default change stamps every launchpad row.",
      short_summary: "Access change stamps every launchpad",
      failure_scenario: "Changing Claude's access stamps empty rows, which then show as Directories rows.",
      category: "correctness",
      verdict: "CONFIRMED",
    },
    {
      file: "src/migrate.ts",
      summary: "The migration parses every payload without a guard.",
      failure_scenario: "One corrupt row fails startup.",
    },
  ],
};

describe("Claude ReportFindings mapping", () => {
  it("parses the tool input and drops findings without a file or a claim", () => {
    const report = parseClaudeFindingsReport({
      ...reported,
      findings: [...reported.findings, { file: "", summary: "no file" }, { file: "x.ts" }, "not a finding"],
    });
    expect(report).toEqual({
      level: "high",
      findings: [
        {
          file: "src/state.ts", line: 7511,
          summary: "An access-default change stamps every launchpad row.",
          shortSummary: "Access change stamps every launchpad",
          failureScenario: "Changing Claude's access stamps empty rows, which then show as Directories rows.",
          category: "correctness", verdict: "CONFIRMED",
        },
        {
          file: "src/migrate.ts",
          summary: "The migration parses every payload without a guard.",
          failureScenario: "One corrupt row fails startup.",
        },
      ],
    });
    expect(isClaudeOutcomeReport(report!)).toBe(false);
  });

  it("is not a report without a findings list", () => {
    expect(parseClaudeFindingsReport(undefined)).toBeUndefined();
    expect(parseClaudeFindingsReport({ level: "high" })).toBeUndefined();
    expect(parseClaudeFindingsReport([reported])).toBeUndefined();
    expect(parseClaudeFindingsReport({ findings: [] })).toEqual({ findings: [] });
  });

  it("keeps a numeric-string line and discards an unusable one", () => {
    const report = parseClaudeFindingsReport({ findings: [
      { file: "a.ts", line: "12", summary: "A", failure_scenario: "x" },
      { file: "b.ts", line: 0, summary: "B", failure_scenario: "x" },
      { file: "c.ts", line: 2.5, summary: "C", failure_scenario: "x" },
    ] });
    expect(report?.findings.map((finding) => finding.line)).toEqual([12, undefined, undefined]);
  });

  it("maps findings into review output every review surface accepts, in reported order", () => {
    const output = claudeReviewOutput(parseClaudeFindingsReport(reported)!, cwd);
    expect(output).toEqual({
      overall_correctness: "patch is incorrect",
      overall_explanation: "",
      findings: [
        {
          title: "Access change stamps every launchpad",
          body: [
            "An access-default change stamps every launchpad row.",
            "Failure scenario: Changing Claude's access stamps empty rows, which then show as Directories rows.",
            "Category: correctness · Verdict: CONFIRMED",
          ].join("\n\n"),
          confidence_score: 0,
          code_location: { absolute_file_path: path.join(cwd, "src/state.ts"), line_range: { start: 7511, end: 7511 } },
        },
        {
          // Without a short summary the claim is the title, not repeated in the body.
          title: "The migration parses every payload without a guard.",
          body: "Failure scenario: One corrupt row fails startup.",
          confidence_score: 0,
          code_location: { absolute_file_path: path.join(cwd, "src/migrate.ts"), line_range: { start: 1, end: 1 } },
        },
      ],
    });
    // The transcript, live events, and tracking all normalize through this.
    expect(normalizeReviewOutputRecord(output)).toEqual(output);
  });

  it("maps a report captured from Claude Code 2.1.296 with CLAUDE_CODE_REPORT_FINDINGS=1", () => {
    // `/code-review low` on a two-line fixture repository, through the Agent SDK.
    const captured = {
      level: "low",
      findings: [{
        file: "math.js",
        line: 2,
        summary: "`if (b = 0)` assigns 0 to b instead of comparing, so the guard never fires and b becomes 0.",
        short_summary: "Assignment instead of comparison in zero guard",
        failure_scenario: "div(6, 2): b is set to 0, the condition is falsy, and the function returns 6/0 = Infinity instead of 3. Every call returns ±Infinity or NaN.",
        category: "correctness",
      }],
    };
    const output = claudeReviewOutput(parseClaudeFindingsReport(captured)!, cwd);
    expect(output.findings).toEqual([expect.objectContaining({
      title: "Assignment instead of comparison in zero guard",
      code_location: { absolute_file_path: path.join(cwd, "math.js"), line_range: { start: 2, end: 2 } },
    })]);
    expect(output.findings[0].body).toContain("Failure scenario: div(6, 2)");
    expect(output.findings[0].body).toContain("Category: correctness");
  });

  it("reports a clean review as correct", () => {
    expect(claudeReviewOutput({ findings: [] }, cwd)).toEqual({
      findings: [], overall_correctness: "patch is correct", overall_explanation: "",
    });
  });

  it("keeps an absolute file path", () => {
    const file = path.resolve("/elsewhere/file.ts");
    const output = claudeReviewOutput({ findings: [{ file, summary: "S", failureScenario: "F" }] }, cwd);
    expect(output.findings[0].code_location.absolute_file_path).toBe(file);
  });
});

describe("Claude ReportFindings outcomes", () => {
  const original = claudeReviewOutput(parseClaudeFindingsReport(reported)!, cwd).findings;

  it("pairs a re-report with the original findings by location and title", () => {
    const report = parseClaudeFindingsReport({ findings: [
      // Reordered: the pairing must not rely on position.
      { ...reported.findings[1], outcome: "skipped" },
      { ...reported.findings[0], outcome: "fixed" },
    ] })!;
    expect(isClaudeOutcomeReport(report)).toBe(true);
    expect(matchClaudeFindingOutcomes(original, report, cwd)).toEqual([
      { index: 0, outcome: "fixed" },
      { index: 1, outcome: "skipped" },
    ]);
  });

  it("falls back to the location when the title was reworded", () => {
    const report = parseClaudeFindingsReport({ findings: [
      { ...reported.findings[0], short_summary: "Reworded", outcome: "no_change_needed" },
    ] })!;
    expect(matchClaudeFindingOutcomes(original, report, cwd)).toEqual([{ index: 0, outcome: "no_change_needed" }]);
  });

  it("falls back to the position only when both lists are the same length", () => {
    const moved = (outcome: string) => [
      { file: "src/other.ts", line: 3, summary: "Moved", failure_scenario: "x", outcome },
      { ...reported.findings[1], outcome: "fixed" },
    ];
    expect(matchClaudeFindingOutcomes(original, parseClaudeFindingsReport({ findings: moved("fixed") })!, cwd))
      .toEqual([{ index: 0, outcome: "fixed" }, { index: 1, outcome: "fixed" }]);
    const longer = parseClaudeFindingsReport({ findings: [
      ...moved("fixed"), { file: "src/third.ts", summary: "Third", failure_scenario: "x", outcome: "fixed" },
    ] })!;
    expect(matchClaudeFindingOutcomes(original, longer, cwd)).toEqual([{ index: 1, outcome: "fixed" }]);
  });

  it("pairs each original finding at most once and ignores findings without an outcome", () => {
    const report = parseClaudeFindingsReport({ findings: [
      { ...reported.findings[0], outcome: "fixed" },
      { ...reported.findings[0], outcome: "skipped" },
      { ...reported.findings[1] },
    ] })!;
    expect(matchClaudeFindingOutcomes(original, report, cwd)).toEqual([{ index: 0, outcome: "fixed" }]);
  });

  it("drops an unknown outcome", () => {
    const report = parseClaudeFindingsReport({ findings: [{ ...reported.findings[0], outcome: "deferred" }] })!;
    expect(isClaudeOutcomeReport(report)).toBe(false);
  });
});
