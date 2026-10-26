import path from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type {
  AppServerReviewFinding,
  AppServerReviewFindingOutcome,
  AppServerReviewOutput,
} from "@pwragent/shared";
import { normalizeReviewCategory } from "../../shared/review-output";

/**
 * Claude Code's typed code-review report. The CLI asks for it only when the
 * host declares it can render one (`CLAUDE_CODE_REPORT_FINDINGS`); otherwise
 * `/code-review` forks a subagent and returns its findings as plain text.
 */
export const CLAUDE_REPORT_FINDINGS_TOOL = "ReportFindings";

const OUTCOMES = new Set<AppServerReviewFindingOutcome["outcome"]>(["fixed", "skipped", "no_change_needed"]);

export type ClaudeReportedFinding = {
  file: string;
  line?: number;
  summary: string;
  shortSummary?: string;
  failureScenario: string;
  category?: string;
  verdict?: string;
  outcome?: AppServerReviewFindingOutcome["outcome"];
};

export type ClaudeFindingsReport = {
  level?: string;
  findings: ClaudeReportedFinding[];
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The tool input, or undefined when it is not a findings report at all. */
export function parseClaudeFindingsReport(input: unknown): ClaudeFindingsReport | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.findings)) return undefined;
  const findings: ClaudeReportedFinding[] = [];
  for (const value of record.findings) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const finding = value as Record<string, unknown>;
    const file = text(finding.file);
    const summary = text(finding.summary);
    // A finding without a place or a claim cannot be shown or worked on.
    if (!file || !summary) continue;
    const line = typeof finding.line === "number" ? finding.line : Number(text(finding.line));
    const outcome = finding.outcome as ClaudeReportedFinding["outcome"];
    findings.push({
      file, summary,
      failureScenario: text(finding.failure_scenario) ?? "",
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      ...(text(finding.short_summary) ? { shortSummary: text(finding.short_summary) } : {}),
      ...(normalizeReviewCategory(finding.category) ? { category: normalizeReviewCategory(finding.category) } : {}),
      ...(text(finding.verdict) ? { verdict: text(finding.verdict) } : {}),
      ...(outcome && OUTCOMES.has(outcome) ? { outcome } : {}),
    });
  }
  return { ...(text(record.level) ? { level: text(record.level) } : {}), findings };
}

/** Titles the skipped-findings guidance lists before it summarizes the rest. */
const SKIPPED_TITLES_SHOWN = 10;

/**
 * What the agent is told when its report leaves findings `skipped`. Claude
 * Code's word reads like a settled outcome, but PwrAgent cannot know why a
 * finding was skipped, so it stays open on the operator's To-do list. The
 * agent must decline it with a reason or defer it to a to-do card.
 */
export function claudeSkippedFindingsGuidance(report: ClaudeFindingsReport): string | undefined {
  const skipped = report.findings.filter((finding) => finding.outcome === "skipped");
  if (skipped.length === 0) return undefined;
  const titles = skipped.slice(0, SKIPPED_TITLES_SHOWN).map((finding) =>
    `- ${finding.file}${finding.line ? `:${finding.line}` : ""} ${findingTitle(finding)}`);
  if (skipped.length > SKIPPED_TITLES_SHOWN) titles.push(`- and ${skipped.length - SKIPPED_TITLES_SHOWN} more`);
  return [
    `PwrAgent tracks this review on the operator's To-do list. \`skipped\` does not settle a finding: ${skipped.length === 1
      ? "this one stays" : `these ${skipped.length} stay`} open there until you settle ${skipped.length === 1 ? "it" : "each one"}.`,
    ...titles,
    "Use PwrAgent's update_review_item for each: status declined, with a note giving the reason, or status deferred,"
      + " with the todoId of an add_todo card (a start_thread action whose prompt stands alone) and a note on why it waits."
      + " list_reviews gives the review and finding ids.",
    "PwrAgent records `fixed` findings as addressed and `no_change_needed` findings as declined.",
  ].join("\n");
}

/**
 * Hands the skipped-findings guidance to the agent as context on the
 * `ReportFindings` result, the moment it reports, rather than leaving it to
 * find the findings still open later.
 */
export function claudeReportFindingsHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PostToolUse: [{
      matcher: CLAUDE_REPORT_FINDINGS_TOOL,
      hooks: [async (input) => {
        if (input.hook_event_name !== "PostToolUse" || input.tool_name !== CLAUDE_REPORT_FINDINGS_TOOL) return {};
        const report = parseClaudeFindingsReport(input.tool_input);
        const guidance = report ? claudeSkippedFindingsGuidance(report) : undefined;
        return guidance ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: guidance } } : {};
      }],
    }],
  };
}

/** A re-report after fixes; the first report of a review carries no outcomes. */
export function isClaudeOutcomeReport(report: ClaudeFindingsReport): boolean {
  return report.findings.some((finding) => finding.outcome !== undefined);
}

function findingPath(file: string, cwd: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file);
}

function findingTitle(finding: ClaudeReportedFinding): string {
  return finding.shortSummary ?? finding.summary;
}

function findingBody(finding: ClaudeReportedFinding): string {
  return [
    // A short title leaves the full claim to the body.
    finding.shortSummary ? finding.summary : undefined,
    finding.failureScenario ? `Failure scenario: ${finding.failureScenario}` : undefined,
    finding.verdict ? `Verdict: ${finding.verdict}` : undefined,
  ].filter(Boolean).join("\n\n");
}

/**
 * The report in the shape every review surface already reads. Claude reports
 * no priority or confidence; its category takes the badge a priority would.
 * Findings arrive most-severe first and keep that order. A finding's
 * confidence is 0, as for a plain-text review: nothing reads it, and the
 * field is required.
 */
export function claudeReviewOutput(report: ClaudeFindingsReport, cwd: string): AppServerReviewOutput {
  const findings: AppServerReviewFinding[] = report.findings.map((finding) => ({
    title: findingTitle(finding),
    body: findingBody(finding),
    confidence_score: 0,
    ...(finding.category ? { category: finding.category } : {}),
    code_location: {
      absolute_file_path: findingPath(finding.file, cwd),
      // A finding without a line anchors to the file's first line.
      line_range: { start: finding.line ?? 1, end: finding.line ?? 1 },
    },
  }));
  return {
    findings,
    overall_correctness: findings.length === 0 ? "patch is correct" : "patch is incorrect",
    overall_explanation: "",
  };
}

/**
 * Pairs a re-report's outcomes with the original findings, by index. The CLI
 * asks for "the same findings" again, so the location and title match first,
 * then the location alone, then the position when both lists are the same
 * length. A finding is paired at most once; an unpaired outcome is dropped.
 *
 * Position alone is no evidence that two reports are one review: an unrelated
 * later review can have the same length. It pairs only when a location already
 * did, or when the caller knows the reports belong together (`trustPosition`).
 */
export function matchClaudeFindingOutcomes(
  original: AppServerReviewFinding[],
  report: ClaudeFindingsReport,
  cwd: string,
  options: { trustPosition?: boolean } = {},
): AppServerReviewFindingOutcome[] {
  const used = new Set<number>();
  const matches: AppServerReviewFindingOutcome[] = [];
  const pending: Array<{ finding: ClaudeReportedFinding; position: number }> = report.findings
    .map((finding, position) => ({ finding, position }))
    .filter(({ finding }) => finding.outcome !== undefined);
  const location = (finding: ClaudeReportedFinding, candidate: AppServerReviewFinding): boolean =>
    candidate.code_location.absolute_file_path === findingPath(finding.file, cwd)
    && candidate.code_location.line_range.start === (finding.line ?? 1);
  const passes: Array<(finding: ClaudeReportedFinding, candidate: AppServerReviewFinding, index: number, position: number) => boolean> = [
    (finding, candidate) => location(finding, candidate) && candidate.title === findingTitle(finding),
    (finding, candidate) => location(finding, candidate),
    (_finding, _candidate, index, position) => (options.trustPosition || matches.length > 0)
      && original.length === report.findings.length && index === position,
  ];
  for (const pass of passes) {
    for (const entry of [...pending]) {
      const index = original.findIndex((candidate, candidateIndex) =>
        !used.has(candidateIndex) && pass(entry.finding, candidate, candidateIndex, entry.position));
      if (index < 0) continue;
      used.add(index);
      matches.push({ index, outcome: entry.finding.outcome! });
      pending.splice(pending.indexOf(entry), 1);
    }
  }
  return matches.sort((left, right) => left.index - right.index);
}
