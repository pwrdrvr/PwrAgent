import type {
  AppServerReviewContext,
  AppServerReviewFinding,
} from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  formatReviewFindingForClipboard,
  formatReviewForClipboard,
  type ReviewClipboardModel,
} from "../review-clipboard";

const WORKSPACE = "/Users/dev/.codex/worktrees/mti5p133/PwrAgent";

const CONTEXT: AppServerReviewContext = {
  workspacePath: WORKSPACE,
  projectLabel: "PwrAgent",
  repositoryPath: "/Users/dev/pwrdrvr/PwrAgent",
  gitBranch: "fix/macos-dock-icon-safe-area",
  baseBranch: "origin/main",
  headCommit: "489d16ff09abcdef0123456789abcdef01234567",
  baseCommit: "0f12ab34cd56ef7890abcdef1234567890abcdef",
  pullRequest: {
    provider: "github.com",
    org: "pwrdrvr",
    repo: "PwrAgent",
    number: 1918,
    url: "https://github.com/pwrdrvr/PwrAgent/pull/1918",
    title: "Ship the macOS dock icon",
    headRefName: "fix/macos-dock-icon-safe-area",
    baseRefName: "main",
  },
};

function finding(
  overrides: Partial<AppServerReviewFinding> = {},
): AppServerReviewFinding {
  return {
    title: "Pad the icon to Apple's template",
    body: "The mark sits 824-in-1024 rather than full bleed.",
    confidence_score: 0.9,
    priority: 1,
    code_location: {
      absolute_file_path: `${WORKSPACE}/apps/desktop/build/icon.png`,
      line_range: { start: 12, end: 18 },
    },
    ...overrides,
  };
}

function model(
  overrides: Partial<ReviewClipboardModel> = {},
): ReviewClipboardModel {
  return {
    body: "The dock icon is padded to the wrong template.",
    confidence: 0.87,
    context: CONTEXT,
    correctness: "patch is incorrect",
    createdAt: Date.parse("2026-09-11T20:39:00.000Z"),
    findings: [finding()],
    reviewer: { backend: "codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
    summary: "Review changes against origin/main",
    ...overrides,
  };
}

describe("formatReviewForClipboard", () => {
  it("carries the whole review and what it was taken against", () => {
    expect(formatReviewForClipboard(model())).toBe(
      [
        "# Review changes against origin/main",
        "",
        "**Verdict:** Patch needs work (87% reviewer confidence) · 1 finding",
        "",
        "## What was reviewed",
        "",
        "- **Project:** PwrAgent",
        `- **Workspace:** ${WORKSPACE}`,
        "- **Repository:** /Users/dev/pwrdrvr/PwrAgent",
        "- **Branch:** fix/macos-dock-icon-safe-area",
        "- **Base:** origin/main",
        "- **Tip commit:** 489d16ff09abcdef0123456789abcdef01234567",
        "- **Base commit:** 0f12ab34cd56ef7890abcdef1234567890abcdef",
        "- **Pull request:** pwrdrvr/PwrAgent#1918 — Ship the macOS dock icon"
          + " — https://github.com/pwrdrvr/PwrAgent/pull/1918",
        "- **Reviewer:** OpenAI · gpt-5.6-sol · high",
        "- **Reviewed at:** 2026-09-11T20:39:00.000Z",
        "",
        "## Summary",
        "",
        "The dock icon is padded to the wrong template.",
        "",
        "## Findings",
        "",
        "### 1. [P1] Pad the icon to Apple's template",
        "",
        "`apps/desktop/build/icon.png:12-18`",
        "",
        "The mark sits 824-in-1024 rather than full bleed.",
        "",
      ].join("\n"),
    );
  });

  it("keeps a checked branch that carried no pull request distinct from an unchecked one", () => {
    const checked = formatReviewForClipboard(
      model({ context: { ...CONTEXT, pullRequest: null } }),
    );
    expect(checked).toContain("- **Pull request:** none at review time");

    const { pullRequest: _unused, ...unchecked } = CONTEXT;
    expect(formatReviewForClipboard(model({ context: unchecked }))).not.toContain(
      "Pull request",
    );
  });

  it("reports a structured reviewer that found nothing, and stays silent for one that reports no findings at all", () => {
    expect(formatReviewForClipboard(model({ findings: [] }))).toContain(
      "## Findings\n\nNo findings.",
    );
    // A plain-text review carries no verdict, so an empty findings list means
    // this reviewer does not enumerate findings — not that it found none.
    expect(
      formatReviewForClipboard(
        model({ correctness: undefined, confidence: undefined, findings: [] }),
      ),
    ).not.toContain("## Findings");
  });

  it("writes finding paths against the reviewed workspace and leaves outside paths absolute", () => {
    const copied = formatReviewForClipboard(
      model({
        findings: [
          finding({
            code_location: {
              absolute_file_path: "/Users/dev/pwrdrvr/PwrAgent/eslint.config.mjs",
              line_range: { start: 4, end: 4 },
            },
          }),
          finding({
            code_location: {
              absolute_file_path: "/etc/hosts",
              line_range: { start: 1, end: 1 },
            },
          }),
        ],
      }),
    );

    // The repository root is a known root too, so a worktree review can still
    // name a file by its repository-relative path.
    expect(copied).toContain("`eslint.config.mjs:4`");
    expect(copied).toContain("`/etc/hosts:1`");
    // A one-line finding reads as one line, not as a range onto itself.
    expect(copied).not.toContain(":4-4");
  });

  it("keeps a heading on one line when the reviewer wrapped its title", () => {
    // Nothing validates a structured finding's title, and the card hides the
    // problem: HTML collapses the newline, Markdown ends the heading at it.
    const copied = formatReviewForClipboard(
      model({
        summary: "Review changes\nagainst origin/main",
        findings: [finding({ title: "Pad the icon\n  to Apple's template" })],
      }),
    );

    expect(copied).toContain("# Review changes against origin/main");
    expect(copied).toContain("### 1. [P1] Pad the icon to Apple's template");
  });

  it("leaves out a timestamp it cannot render rather than throwing", () => {
    // This runs inside a render-phase memo, so a `RangeError` here would take
    // the transcript down rather than one copy button.
    for (const createdAt of [Number.NaN, 1.78e18, Number.POSITIVE_INFINITY]) {
      const copied = formatReviewForClipboard(model({ createdAt }));
      expect(copied).not.toContain("Reviewed at");
      expect(copied).toContain("# Review changes against origin/main");
    }
  });

  it("falls back to a usable title when the card had no summary of its own", () => {
    expect(formatReviewForClipboard(model({ summary: "  " }))).toMatch(
      /^# Code review\n/,
    );
  });
});

describe("formatReviewFindingForClipboard", () => {
  it("stamps one finding with the branch and commit it was found on", () => {
    expect(formatReviewFindingForClipboard(model(), finding())).toBe(
      [
        "### [P1] Pad the icon to Apple's template",
        "",
        "`apps/desktop/build/icon.png:12-18`",
        "",
        "The mark sits 824-in-1024 rather than full bleed.",
        "",
        "---",
        "",
        "_Review changes against origin/main · PwrAgent ·"
          + " fix/macos-dock-icon-safe-area @ 489d16ff09 · pwrdrvr/PwrAgent#1918_",
        "",
      ].join("\n"),
    );
  });

  it("omits a priority the reviewer never reported", () => {
    expect(
      formatReviewFindingForClipboard(
        model(),
        finding({ priority: undefined }),
      ),
    ).toContain("### Pad the icon to Apple's template");
  });

  it("still names the branch when the workspace had no resolvable commit", () => {
    const { headCommit: _unused, ...context } = CONTEXT;
    expect(
      formatReviewFindingForClipboard(model({ context }), finding()),
    ).toContain(
      "_Review changes against origin/main · PwrAgent ·"
        + " fix/macos-dock-icon-safe-area · pwrdrvr/PwrAgent#1918_",
    );
  });

  it("takes a footer the caller already built for the whole review", () => {
    const built = formatReviewFindingForClipboard(
      model(),
      finding(),
      "_already built_",
    );

    expect(built).toContain("_already built_");
    expect(built).not.toContain("PwrAgent");
  });

  it("copies a finding from a review that recorded no provenance at all", () => {
    expect(
      formatReviewFindingForClipboard(
        model({ context: undefined }),
        finding(),
      ),
    ).toBe(
      [
        "### [P1] Pad the icon to Apple's template",
        "",
        `\`${WORKSPACE}/apps/desktop/build/icon.png:12-18\``,
        "",
        "The mark sits 824-in-1024 rather than full bleed.",
        "",
        "---",
        "",
        "_Review changes against origin/main_",
        "",
      ].join("\n"),
    );
  });
});
