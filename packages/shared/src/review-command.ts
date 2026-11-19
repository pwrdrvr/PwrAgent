import {
  EXPLICIT_REVIEW_PULL_REQUEST_URL,
  nativeReviewTarget,
  normalizePullRequestUrl,
  PULL_REQUEST_SET_MAX,
  pullRequestRepositoryKey,
  pullRequestReviewPromptUrl,
  pullRequestSetProblem,
  pullRequestSetReviewInstructions,
} from "./pull-request-review";
import type { AppServerBackendKind, AppServerReviewOutput, AppServerReviewTarget, BackendSummary, ReviewRunMode } from "@pwragent/shared";
import { normalizeReviewConfidenceScore } from "./review-output";

export type ParsedReviewCommand = {
  target: AppServerReviewTarget;
  displayText: string;
};

/**
 * A pull request a review command named as its target, as the operator wrote
 * it: a bare number, or one qualified by its repository or URL.
 */
export type NamedReviewPullRequest = {
  number: number;
  provider?: string;
  org?: string;
  repo?: string;
  url?: string;
};

/**
 * Abbreviate a commit for display. Long enough to stay unambiguous in any
 * repository this app is pointed at, short enough to read inline.
 *
 * One definition for the whole review feature: the workspace guard prints an
 * abbreviated sha in its refusal message and the review card prints one on its
 * provenance chip, and the two describing the same commit differently would be
 * a bug a reader could not diagnose.
 */
export function shortReviewSha(sha: string): string {
  return sha.trim().slice(0, 10);
}

export function formatReviewCommand(target: AppServerReviewTarget): string {
  if (target.type === "pullRequest") {
    return `/review --pr ${target.url}`;
  }
  if (target.type === "pullRequests") {
    return `/review --pr ${target.pullRequests.map((member) => member.url).join(" ")}`;
  }
  if (target.type === "branch") {
    return `/code-review ${target.branch}`;
  }
  if (target.type === "path") {
    return `/code-review ${target.path}`;
  }
  if (target.type === "uncommittedChanges") {
    return "/review";
  }
  if (target.type === "baseBranch") {
    return `/review ${target.branch}`;
  }
  if (target.type === "commit") {
    return `/review --commit ${[target.sha, target.title].filter(Boolean).join(" ")}`;
  }
  return `/review --custom ${target.instructions}`;
}

/**
 * Delimiters wrapping the managed-review artifact that PwrAgent prepends to the
 * next prompt after a review finishes. The agent needs the text in its context
 * window; the operator does not need to read it in the transcript, and ACP
 * agents echo every prompt back as a `user_message_chunk`. Both the writer
 * (`buildManagedReviewContextInput`) and the transcript filter
 * (`stripManagedReviewContextBlock`) key off these exact strings — change one
 * and the block starts rendering as a user message again.
 */
export const MANAGED_REVIEW_CONTEXT_OPEN_MARKER =
  "[PwrAgent review sub-agent results — context for this turn]";
export const MANAGED_REVIEW_CONTEXT_CLOSE_MARKER =
  "[End PwrAgent review sub-agent results]";

/**
 * Removes the wrapped review-context block from prompt text meant for display.
 * Returns the remaining operator-authored text, or an empty string when the
 * block was the whole message.
 *
 * Handles a block split across streamed chunks in either direction: a chunk
 * holding only the opening half drops its whole tail, and a chunk holding only
 * the closing half drops everything up to and including the close marker.
 * Without the second case the artifact's tail renders as a user message.
 */
export function stripManagedReviewContextBlock(value: string): string {
  const start = value.indexOf(MANAGED_REVIEW_CONTEXT_OPEN_MARKER);
  const closeAt = value.indexOf(
    MANAGED_REVIEW_CONTEXT_CLOSE_MARKER,
    start === -1 ? 0 : start,
  );
  if (start === -1) {
    return closeAt === -1
      ? value
      : value.slice(closeAt + MANAGED_REVIEW_CONTEXT_CLOSE_MARKER.length).trim();
  }
  // An unterminated block means the whole tail is review context — a truncated
  // or still-streaming echo. Dropping it beats rendering half an artifact.
  const end =
    closeAt === -1
      ? value.length
      : closeAt + MANAGED_REVIEW_CONTEXT_CLOSE_MARKER.length;
  return `${value.slice(0, start)}${value.slice(end)}`.trim();
}

export function normalizeReviewDisplayText(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }

  const pullRequestUrl = pullRequestReviewPromptUrl(normalized);
  if (pullRequestUrl) {
    return `Review ${pullRequestUrl}`;
  }

  if (/^current changes$/i.test(normalized)) {
    return "Review current changes";
  }

  const branchMatch = /^(?:review\s+)?changes\s+against\s+(.+)$/i.exec(normalized);
  if (branchMatch) {
    return `Review changes against ${stripWrappingQuotes(branchMatch[1])}`;
  }

  const commitMatch = /^(?:review\s+)?commit\s+(.+)$/i.exec(normalized);
  if (commitMatch) {
    return `Review commit ${stripWrappingQuotes(commitMatch[1])}`;
  }

  if (/^custom instructions$/i.test(normalized)) {
    return "Review custom instructions";
  }

  if (/^(review|code review)\b/i.test(normalized)) {
    return normalized;
  }

  return `Review ${normalized}`;
}

export function parseReviewCommand(input: string): ParsedReviewCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = /^\/review(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return undefined;
  }

  const argument = match[1]?.trim() ?? "";
  if (!argument) {
    return {
      target: { type: "uncommittedChanges" },
      displayText: "Review current changes",
    };
  }

  if (argument.startsWith("--pr ")) {
    const url = argument.slice(5).trim();
    return url ? { target: { type: "pullRequest", url }, displayText: `Review ${url}` } : undefined;
  }

  const customPrefix = "--custom";
  if (argument === customPrefix || argument.startsWith(`${customPrefix} `)) {
    const instructions = argument.slice(customPrefix.length).trim();
    if (!instructions) {
      return undefined;
    }
    return {
      target: { type: "custom", instructions },
      displayText: "Review custom instructions",
    };
  }

  const commitPrefix = "--commit";
  if (argument === commitPrefix || argument.startsWith(`${commitPrefix} `)) {
    const rest = argument.slice(commitPrefix.length).trim();
    const [sha, ...titleParts] = rest.split(/\s+/);
    if (!sha) {
      return undefined;
    }
    const title = titleParts.join(" ").trim();
    return {
      target: {
        type: "commit",
        sha,
        title: title || null,
      },
      displayText: `Review commit ${sha}`,
    };
  }

  return {
    target: { type: "baseBranch", branch: argument },
    displayText: `Review changes against ${argument}`,
  };
}

/** Parse the explicit messaging `--pr` arguments using the bound thread's attachments. */
export function parseReviewPullRequestArguments(
  input: string,
  attached: readonly { url: string }[],
): Extract<AppServerReviewTarget, { type: "pullRequest" | "pullRequests" }> {
  const references = input.trim().split(/\s*,\s*|\s+/, PULL_REQUEST_SET_MAX + 1);
  if (references.some(reference => !reference)) {
    throw new Error("Use /review --pr followed by PR numbers or GitHub.com PR URLs, separated by spaces or commas.");
  }
  if (references.length > PULL_REQUEST_SET_MAX) {
    throw new Error(`A combined review takes at most ${PULL_REQUEST_SET_MAX} pull requests.`);
  }
  const attachedUrls = new Set(attached.map(pr => normalizePullRequestUrl(pr.url)));
  const urls = references.map(reference => {
    if (EXPLICIT_REVIEW_PULL_REQUEST_URL.test(normalizePullRequestUrl(reference))) return reference;
    const number = /^#?([1-9][0-9]*)$/.exec(reference)?.[1];
    if (!number) throw new Error("Use an attached GitHub.com PR URL or PR number.");
    const matches = [...attachedUrls].filter(url => EXPLICIT_REVIEW_PULL_REQUEST_URL.exec(url)?.[4] === number);
    if (matches.length !== 1) {
      throw new Error(`PR #${number} must identify one attached GitHub.com pull request. Use the full URL if the number is ambiguous.`);
    }
    return matches[0]!;
  });
  if (urls.length === 1) return { type: "pullRequest", url: urls[0]! };

  const problem = pullRequestSetProblem(urls);
  if (problem) throw new Error(problem);
  const normalized = urls.map(normalizePullRequestUrl);
  if (normalized.some(url => !attachedUrls.has(url))) {
    throw new Error("Select pull requests attached to this thread.");
  }
  return { type: "pullRequests", pullRequests: normalized.map(url => ({ url })) };
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^(['"])(.*)\1$/, "$2").trim();
}

/**
 * Reduce a Git ref to the branch name both sides of a comparison can agree on.
 *
 * The same branch reaches us written three ways: `refs/heads/main` from Git
 * plumbing, `origin/main` from a review target the operator picked, and bare
 * `main` from the GitHub API. Comparing the raw strings makes those three
 * different branches.
 */
export function normalizeFullRef(ref: string): string {
  const normalized = ref.trim();
  const localMatch = normalized.match(/^refs\/heads\/(.+)$/);
  if (localMatch?.[1]) {
    return localMatch[1];
  }
  const remoteMatch = normalized.match(/^refs\/remotes\/[^/]+\/(.+)$/);
  return remoteMatch?.[1] ?? normalized;
}

/**
 * Whether a review's base target names something other than the pull request's
 * own base — the stacked-branch case, where the operator skipped past the
 * branch below to compare against `origin/main` directly.
 *
 * A remote-qualified target still names the pull request's base, so `main`,
 * `origin/main`, and `refs/remotes/origin/main` all have to compare equal to
 * GitHub's bare `main`. Answering `false` when either side is unknown keeps a
 * missing value from reading as a deliberate override.
 */
export function reviewComparedPastPullRequestBase(
  baseBranch: string | undefined,
  pullRequestBase: string | undefined,
): boolean {
  const base = normalizeFullRef(baseBranch ?? "");
  const pullRequest = normalizeFullRef(pullRequestBase ?? "");
  if (!base || !pullRequest) {
    return false;
  }
  return base !== pullRequest && !base.endsWith(`/${pullRequest}`);
}

/**
 * Validate a candidate structured review output.
 *
 * Four surfaces normalize this shape — the Codex client, the messaging
 * controller, the renderer's session state, and the managed-review parser —
 * and a copy that falls behind does not fail loudly: it returns `undefined`
 * and the card silently loses its verdict, explanation, and every finding. The
 * validation therefore lives in one place that main and the renderer can both
 * import; callers keep only their own shape-digging.
 */
export function normalizeReviewOutputRecord(
  value: unknown,
): AppServerReviewOutput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const findings = Array.isArray(record.findings) ? record.findings : undefined;
  if (
    !findings
    || (record.overall_correctness !== "patch is correct"
      && record.overall_correctness !== "patch is incorrect")
    || typeof record.overall_explanation !== "string"
  ) {
    return undefined;
  }

  const confidenceScore = normalizeReviewConfidenceScore(
    record.overall_confidence_score,
  );
  return {
    findings: findings as AppServerReviewOutput["findings"],
    overall_correctness: record.overall_correctness,
    overall_explanation: record.overall_explanation,
    ...(confidenceScore === undefined
      ? {}
      : { overall_confidence_score: confidenceScore }),
  };
}

/** Wording is only a candidate; callers must also establish a native review turn. */
export function isCodexReviewPromptText(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  return Boolean(pullRequestReviewPromptUrl(normalized))
    || (/^review the (?:current )?code changes\b/i.test(normalized)
      && /provide prioritized(?:, actionable)? findings\.$/i.test(normalized));
}

/** Explicit persisted envelope for an ordinary turn/start used as an inline review. */
export function isPwrAgentInlineReviewPrompt(text: string): boolean {
  const normalized = text.trim();
  return normalized.startsWith("<pwragent-inline-review-instructions>\n")
    && normalized.endsWith("\n</pwragent-inline-review-instructions>");
}

export function reviewTargetInstructions(target: AppServerReviewTarget): string {
  switch (target.type) {
    case "pullRequest":
      return reviewTargetInstructions(nativeReviewTarget(target));
    case "pullRequests":
      return pullRequestSetReviewInstructions(target);
    case "branch":
      return `Review the changes on branch '${target.branch}'.`;
    case "path":
      return `Review the file or folder '${target.path}'.`;
    case "baseBranch":
      return `Review the current checkout against base branch '${target.branch}'. Find the merge base and inspect the resulting diff.`;
    case "commit":
      return `Review commit ${target.sha}${target.title ? ` (${target.title})` : ""}.`;
    case "custom":
      return target.instructions.trim() || "Review the current code changes.";
    case "uncommittedChanges":
      return "Review all staged, unstaged, and untracked changes in the current checkout.";
  }
}

/**
 * The effort levels the review panel offers for Claude Code's `/code-review`.
 * `ultra` is left out: it launches a billed, multi-agent review in the cloud
 * whose findings do not come back to the thread. It can still be typed.
 */
export const CLAUDE_CODE_REVIEW_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeCodeReviewLevel = (typeof CLAUDE_CODE_REVIEW_LEVELS)[number];
export const DEFAULT_CLAUDE_CODE_REVIEW_LEVEL: ClaudeCodeReviewLevel = "high";

/** Claude Code is the default reviewer on a compatible Claude thread. */
export function prefersClaudeCodeReview(params: {
  ownerSummary?: BackendSummary;
  requestedRunMode?: ReviewRunMode;
  reviewerChosen?: boolean;
  thread?: { source: AppServerBackendKind };
}): boolean {
  return params.thread?.source === "claude"
    && params.ownerSummary?.capabilities.reviewClaudeCodeReview === true
    && (params.requestedRunMode === "claude-code-review"
      || (params.requestedRunMode === undefined && !params.reviewerChosen));
}

export function isClaudeCodeReviewLevel(value: unknown): value is ClaudeCodeReviewLevel {
  return typeof value === "string"
    && (CLAUDE_CODE_REVIEW_LEVELS as readonly string[]).includes(value);
}

/** Whether Claude Code's `/code-review` has a form for this target. */
export function claudeCodeReviewTakesTarget(target: AppServerReviewTarget): boolean {
  return target.type === "uncommittedChanges"
    || target.type === "pullRequest"
    || target.type === "pullRequests"
    || target.type === "branch"
    || target.type === "path";
}

function claudeCodeReviewPullRequest(url: string, repository: string | undefined): string {
  const normalized = normalizePullRequestUrl(url);
  const match = /\/pull\/([1-9][0-9]*)$/.exec(normalized);
  if (!match || !pullRequestRepositoryKey({ url: normalized })) {
    throw new Error("Claude Code reviews GitHub pull requests by number or URL.");
  }
  // A bare number is the checkout's own repository's; any other is named in full.
  return repository && pullRequestRepositoryKey({ url: normalized }) === repository.trim().toLowerCase()
    ? match[1]!
    : normalized;
}

/**
 * The `/code-review` command that reviews a panel target in a Claude thread:
 * the effort level, then the target. Several pull requests are one
 * comma-separated argument, which Claude Code reviews as one combined report.
 * A pull request of `repository` (the checkout's `host/owner/repo`) is its
 * bare number; any other is its URL. Throws for a target `/code-review` has
 * no form for, and for an argument it would read as something else.
 */
export function claudeCodeReviewCommand(params: {
  target: AppServerReviewTarget;
  level?: string;
  repository?: string;
}): string {
  const { target } = params;
  if (params.level !== undefined && !isClaudeCodeReviewLevel(params.level)) {
    throw new Error(`Unknown Claude Code review effort: ${params.level}`);
  }
  let argument: string | undefined;
  switch (target.type) {
    case "uncommittedChanges":
      argument = undefined;
      break;
    case "pullRequest":
      argument = claudeCodeReviewPullRequest(target.url, params.repository);
      break;
    case "pullRequests":
      if (target.pullRequests.length === 0) {
        throw new Error("Choose at least one pull request to review.");
      }
      argument = target.pullRequests
        .map((member) => claudeCodeReviewPullRequest(member.url, params.repository))
        .join(",");
      break;
    case "branch": {
      const branch = target.branch.trim();
      // No whitespace, and no leading dash, which would read as a flag.
      if (!branch || /\s/.test(branch) || branch.startsWith("-")) {
        throw new Error("Enter a branch name without spaces.");
      }
      // `/code-review 12` and `/code-review #12` review pull request 12.
      if (/^#?[0-9]+$/.test(branch)) {
        throw new Error("This branch name reads as a pull request number.");
      }
      // A comma separates several targets.
      if (branch.includes(",")) {
        throw new Error("This branch name reads as several review targets.");
      }
      argument = branch;
      break;
    }
    case "path": {
      const path = target.path.trim();
      if (!path || /[\r\n"]/.test(path) || path.startsWith("-")) {
        throw new Error("Enter a path on one line, without quotes or a leading dash.");
      }
      // A comma separates several targets.
      if (path.includes(",")) {
        throw new Error("This path reads as several review targets.");
      }
      // "./" keeps a relative path from reading as a pull request or branch.
      const explicit = /^(?:\/|\.{1,2}\/|[a-zA-Z]:[\\/])/.test(path) ? path : `./${path}`;
      argument = /\s/.test(explicit) ? `"${explicit}"` : explicit;
      break;
    }
    default:
      throw new Error("Claude Code's /code-review has no form for this review target.");
  }
  return ["/code-review", params.level, argument].filter(Boolean).join(" ");
}
