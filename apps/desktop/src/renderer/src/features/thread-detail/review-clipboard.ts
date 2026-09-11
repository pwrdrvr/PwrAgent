import type {
  AppServerReviewContext,
  AppServerReviewFinding,
  AppServerReviewOutput,
  AppServerThreadReviewEntry,
} from "@pwragent/shared";
import { formatPathRelativeToDirectories } from "@pwragent/shared";
import { shortReviewSha } from "../../../../shared/review-command";
import { formatBackendLabel } from "../../lib/backend-label";

/**
 * Everything the review card knows, in the shape the card has already resolved
 * it to. The card reads a structured `output` when the reviewer produced one
 * and parses plain review text when it did not; taking the resolved body and
 * findings rather than the raw entry keeps the clipboard from re-deriving that
 * — and from quietly disagreeing with what the reader is looking at.
 */
export type ReviewClipboardModel = {
  body: string;
  confidence?: number;
  context?: AppServerReviewContext;
  correctness?: AppServerReviewOutput["overall_correctness"];
  createdAt?: number;
  findings: readonly AppServerReviewFinding[];
  reviewer?: AppServerThreadReviewEntry["reviewer"];
  summary: string;
};

/**
 * Markdown that has to stay on one line: a heading, or a run of italics. The
 * reviewer authors finding titles, nothing validates them (`normalizeReviewOutputRecord`
 * casts `findings` through without inspecting them), and an embedded newline
 * ends the heading early — leaving the rest of the title as a stray paragraph
 * in whatever the operator pasted into.
 */
function collapseToOneLine(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

/**
 * A review's findings are quoted somewhere else — a pull request, an issue, a
 * prompt to another agent — and land there stripped of the card that said what
 * they were about. The header is what survives that trip: which branch, which
 * commits, which pull request, and which reviewer reached this verdict.
 *
 * Written as Markdown because every destination that matters renders it, and
 * the ones that do not still read as an ordinary plain-text outline.
 */
export function formatReviewForClipboard(model: ReviewClipboardModel): string {
  const sections: string[] = [
    `# ${collapseToOneLine(model.summary) || "Code review"}`,
  ];

  const verdict = formatVerdictLine(model);
  if (verdict) {
    sections.push(verdict);
  }

  const metadata = formatReviewMetadata(model);
  if (metadata.length > 0) {
    sections.push("## What was reviewed", metadata.join("\n"));
  }

  const body = model.body.trim();
  if (body) {
    sections.push("## Summary", body);
  }

  if (model.findings.length > 0) {
    sections.push("## Findings");
    model.findings.forEach((finding, index) => {
      sections.push(
        formatFindingSection(finding, model.context, `${index + 1}. `),
      );
    });
  } else if (model.correctness) {
    // Only a structured review can distinguish "no findings" from "this
    // reviewer does not report findings at all". The card draws the same line.
    sections.push("## Findings", "No findings.");
  }

  return `${sections.join("\n\n")}\n`;
}

/**
 * One finding, quotable on its own. The provenance footer is the whole point:
 * a finding pasted without the branch and commit it was found on is a claim
 * about a file that nobody can check later.
 */
export function formatReviewFindingForClipboard(
  model: ReviewClipboardModel,
  finding: AppServerReviewFinding,
  /**
   * The footer depends only on `model`, so a caller formatting every finding
   * of one review builds it once and hands the same string to each.
   */
  provenance = formatFindingProvenance(model),
): string {
  const sections = [formatFindingSection(finding, model.context, "")];
  if (provenance) {
    sections.push("---", provenance);
  }
  return `${sections.join("\n\n")}\n`;
}

function formatFindingSection(
  finding: AppServerReviewFinding,
  context: AppServerReviewContext | undefined,
  numbering: string,
): string {
  const priority =
    typeof finding.priority === "number" ? `[P${finding.priority}] ` : "";
  const parts = [
    `### ${numbering}${priority}${collapseToOneLine(finding.title)}`,
  ];
  const location = formatFindingLocation(finding, context);
  if (location) {
    parts.push(`\`${location}\``);
  }
  const body = finding.body.trim();
  if (body) {
    parts.push(body);
  }
  return parts.join("\n\n");
}

/**
 * Repository-relative when the path sits inside the reviewed workspace, and
 * absolute when it does not. The metadata block names the workspace, so a
 * relative path stays reconstructable — and it is the form that survives being
 * handed to a reader working in a different checkout of the same repository,
 * which is the normal case once worktrees are in play.
 */
function formatFindingLocation(
  finding: AppServerReviewFinding,
  context: AppServerReviewContext | undefined,
): string {
  const absolutePath = finding.code_location.absolute_file_path.trim();
  if (!absolutePath) {
    return "";
  }
  const roots = [context?.workspacePath, context?.repositoryPath].filter(
    (root): root is string => Boolean(root?.trim()),
  );
  const path = formatPathRelativeToDirectories(absolutePath, roots);
  const range = finding.code_location.line_range;
  return range.start === range.end
    ? `${path}:${range.start}`
    : `${path}:${range.start}-${range.end}`;
}

/**
 * One line rather than two, because a Markdown hard break is two trailing
 * spaces and those do not survive being pasted through a plain-text field.
 *
 * "reviewer confidence" is spelled out for the same reason the badge fuses the
 * percentage into the verdict: on its own the number reads as a score for the
 * code rather than the reviewer's confidence in its own judgement.
 */
function formatVerdictLine(model: ReviewClipboardModel): string {
  const findings =
    model.findings.length === 1
      ? "1 finding"
      : `${model.findings.length} findings`;
  if (!model.correctness) {
    return model.findings.length > 0 ? `**Findings:** ${findings}` : "";
  }
  const verdict =
    model.correctness === "patch is correct"
      ? "Patch correct"
      : "Patch needs work";
  const confidence =
    model.confidence === undefined
      ? ""
      : ` (${Math.round(model.confidence * 100)}% reviewer confidence)`;
  return `**Verdict:** ${verdict}${confidence} · ${findings}`;
}

function formatReviewMetadata(model: ReviewClipboardModel): string[] {
  const context = model.context;
  const rows: string[] = [];
  const push = (label: string, value: string | undefined): void => {
    if (value?.trim()) {
      rows.push(`- **${label}:** ${value.trim()}`);
    }
  };

  push("Project", context?.projectLabel);
  push("Workspace", context?.workspacePath);
  push("Repository", context?.repositoryPath);
  push("Branch", context?.gitBranch);
  push("Base", context?.baseBranch);
  push("Tip commit", context?.headCommit);
  push("Base commit", context?.baseCommit);
  const pullRequest = context?.pullRequest;
  if (pullRequest) {
    const title = pullRequest.title?.trim();
    push(
      "Pull request",
      [
        `${pullRequest.org}/${pullRequest.repo}#${pullRequest.number}`,
        title,
        pullRequest.url,
      ]
        .filter(Boolean)
        .join(" — "),
    );
  } else if (pullRequest === null) {
    // The branch was checked and carried none. Saying so is not the same as
    // leaving the row out, which is what an unchecked branch does.
    push("Pull request", "none at review time");
  }
  push("Reviewer", formatReviewerLabel(model.reviewer));
  // ISO rather than a locale format: a pasted timestamp is read by someone
  // else, in another time zone, possibly months later.
  push("Reviewed at", formatReviewedAt(model.createdAt));
  return rows;
}

/**
 * `Date.prototype.toISOString` throws a `RangeError` on a timestamp it cannot
 * represent — `NaN`, or anything past ±8.64e15 such as a nanosecond epoch from
 * a producer that did not normalize. This runs inside a render-phase `useMemo`,
 * so an unguarded throw would take the whole transcript down rather than one
 * copy button. An unprintable timestamp is an absent row.
 */
function formatReviewedAt(createdAt: number | undefined): string | undefined {
  if (createdAt === undefined || !Number.isFinite(createdAt)) {
    return undefined;
  }
  const reviewedAt = new Date(createdAt);
  return Number.isNaN(reviewedAt.getTime())
    ? undefined
    : reviewedAt.toISOString();
}

function formatReviewerLabel(
  reviewer: AppServerThreadReviewEntry["reviewer"],
): string | undefined {
  if (!reviewer) {
    return undefined;
  }
  return [
    formatBackendLabel(reviewer.backend),
    reviewer.model?.trim(),
    reviewer.reasoningEffort?.trim(),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function formatFindingProvenance(model: ReviewClipboardModel): string {
  const context = model.context;
  const parts = [
    collapseToOneLine(model.summary) || "Code review",
    context?.projectLabel?.trim(),
    formatReviewedState(context),
    context?.pullRequest
      ? `${context.pullRequest.org}/${context.pullRequest.repo}#${context.pullRequest.number}`
      : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `_${parts.join(" · ")}_` : "";
}

/** The branch and the commit on it, whichever of the two were recorded. */
function formatReviewedState(
  context: AppServerReviewContext | undefined,
): string | undefined {
  const branch = context?.gitBranch?.trim();
  const headCommit = context?.headCommit?.trim();
  if (branch && headCommit) {
    return `${branch} @ ${shortReviewSha(headCommit)}`;
  }
  if (branch) {
    return branch;
  }
  return headCommit ? shortReviewSha(headCommit) : undefined;
}
