import path from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type {
  AppServerReviewFinding,
  AppServerReviewFindingOutcome,
  AppServerReviewOutput,
} from "@pwragent/shared";
import { EXPLICIT_REVIEW_PULL_REQUEST_URL } from "../../shared/pull-request-review";
import type { NamedReviewPullRequest } from "../../shared/review-command";
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

const CODE_REVIEW_COMMAND = /^\/code-review(?:\s+([\s\S]*))?$/;
const CODE_REVIEW_LEVELS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
/** Flags that take the next argument as their value. */
const CODE_REVIEW_VALUE_FLAGS = new Set(["--max-findings"]);
const PULL_REQUEST_NUMBER = /^#?([1-9][0-9]*)$/;
const REPOSITORY_PULL_REQUEST = /^([\w.-]+)\/([\w.-]+)#([1-9][0-9]*)$/;
/** A pull request page's tab or anchor, after its number. */
const PULL_REQUEST_URL_SUFFIX = /(\/pull\/[0-9]+)[/?#].*$/;

/**
 * The pull requests a `/code-review` prompt targets, in the order named.
 * Claude's findings report carries no pull request, so the prompt is the only
 * record of which ones a review covered. They lead the arguments; the first
 * word that is not one ends them, so a path or a note after them (`97 focus on
 * retries`) neither hides them nor adds a number from the note. A prompt that
 * leads with a branch or a path names none.
 */
export function parseClaudeCodeReviewPullRequests(prompt: string | undefined): NamedReviewPullRequest[] {
  const args = CODE_REVIEW_COMMAND.exec(prompt?.trim() ?? "")?.[1]?.trim();
  if (!args) return [];
  const targets: NamedReviewPullRequest[] = [];
  const tokens = args.split(/\s+/);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      if (CODE_REVIEW_VALUE_FLAGS.has(token)) index += 1;
      continue;
    }
    if (CODE_REVIEW_LEVELS.has(token.toLowerCase())) continue;
    for (const part of token.split(",").filter(Boolean)) {
      const target = parseCodeReviewPullRequest(part);
      if (!target) return targets;
      const duplicate = targets.some((existing) => existing.number === target.number
        && existing.org?.toLowerCase() === target.org?.toLowerCase()
        && existing.repo?.toLowerCase() === target.repo?.toLowerCase());
      if (!duplicate) targets.push(target);
    }
  }
  return targets;
}

function parseCodeReviewPullRequest(token: string): NamedReviewPullRequest | undefined {
  const number = PULL_REQUEST_NUMBER.exec(token);
  if (number) return { number: Number(number[1]) };
  const qualified = REPOSITORY_PULL_REQUEST.exec(token);
  if (qualified) return { number: Number(qualified[3]), org: qualified[1], repo: qualified[2] };
  const url = EXPLICIT_REVIEW_PULL_REQUEST_URL.exec(token.replace(PULL_REQUEST_URL_SUFFIX, "$1"));
  if (url) {
    const [, provider, org, repo, value] = url;
    return { number: Number(value), provider, org, repo, url: `https://${provider}/${org}/${repo}/pull/${value}` };
  }
  return undefined;
}

/** Titles the skipped-findings guidance lists before it summarizes the rest. */
const SKIPPED_TITLES_SHOWN = 10;

/**
 * What the agent is told when its report has `skipped` findings. Claude Code
 * means "real but not applied" and treats it as settled, so PwrAgent records
 * each as declined. The report carries no reason, and a real finding worth
 * doing later belongs on a to-do card, so the agent is told how to defer it
 * or document the decline.
 */
export function claudeSkippedFindingsGuidance(report: ClaudeFindingsReport): string | undefined {
  const skipped = report.findings.filter((finding) => finding.outcome === "skipped");
  if (skipped.length === 0) return undefined;
  const titles = skipped.slice(0, SKIPPED_TITLES_SHOWN).map((finding) =>
    `- ${finding.file}${finding.line ? `:${finding.line}` : ""} ${findingTitle(finding)}`);
  if (skipped.length > SKIPPED_TITLES_SHOWN) titles.push(`- and ${skipped.length - SKIPPED_TITLES_SHOWN} more`);
  return [
    `PwrAgent tracks this review on the operator's To-do list. It recorded ${skipped.length === 1
      ? "this `skipped` finding" : `these ${skipped.length} \`skipped\` findings`} as declined, with no reason:`,
    ...titles,
    "If one is worth doing later, raise an add_todo card (a start_thread action whose prompt stands alone),"
      + " then call PwrAgent's update_review_item with status deferred, its todoId, and a note on why it waits."
      + " To record why one will not be fixed, call update_review_item with status declined and a note."
      + " list_reviews gives the review and finding ids.",
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
