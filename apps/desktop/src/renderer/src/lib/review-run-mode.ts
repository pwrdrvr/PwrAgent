import {
  findPrimaryReviewWorkspaceCwd,
  type AppServerBackendKind,
  type BackendSummary,
  type NavigationThreadSummary,
  type ReviewRunMode,
} from "@pwragent/shared";
import { formatBackendLabel } from "./backend-label";

export type ReviewRunModeDecision = {
  /** The thread is a Claude thread, so the mode menu offers Claude Code. */
  claudeCodeReviewOffered?: boolean;
  /** Claude Code is offered but this thread's owner cannot run it. */
  claudeCodeReviewDisabled?: boolean;
  controlDisabled: boolean;
  explicitRunModeSupported: boolean;
  helpText?: string;
  runMode: ReviewRunMode;
  subagentDisabled: boolean;
  nativeDisabled: boolean;
  submissionUnavailable: boolean;
};

function normalizeWorkspacePath(value?: string): string | undefined {
  const normalized = value?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || undefined;
}

function usesSecondaryWorkspace(
  thread: NavigationThreadSummary,
  workspaceCwd?: string,
): boolean {
  if (thread.source !== "codex") return false;
  const selected = normalizeWorkspacePath(workspaceCwd);
  const primary = normalizeWorkspacePath(findPrimaryReviewWorkspaceCwd(thread));
  return Boolean(selected && primary && selected !== primary);
}

function backendLabel(
  backend: AppServerBackendKind,
  summary?: BackendSummary,
): string {
  return formatBackendLabel(backend, summary ? [summary] : undefined);
}

/**
 * Whether a review runs as Claude Code's `/code-review` in the thread: on a
 * Claude thread whose owner can run it, when the operator chose that mode, or
 * chose no mode and no other reviewer. It is the Claude thread's default.
 */
export function prefersClaudeCodeReview(params: {
  ownerSummary?: BackendSummary;
  requestedRunMode?: ReviewRunMode;
  reviewerChosen?: boolean;
  thread?: Pick<NavigationThreadSummary, "source">;
}): boolean {
  return params.thread?.source === "claude"
    && params.ownerSummary?.capabilities.reviewClaudeCodeReview === true
    && (params.requestedRunMode === "claude-code-review"
      || (params.requestedRunMode === undefined && !params.reviewerChosen));
}

export const PULL_REQUEST_SET_RUN_MODE_REASON =
  "PwrAgent Sub Agent is required because a combined review covers several pull requests, and Codex's own reviewer takes one.";

export function resolveReviewRunMode(params: {
  ownerSummary?: BackendSummary;
  /** Several pull requests reviewed together, which only a managed reviewer or Claude Code takes. */
  pullRequestSet?: boolean;
  requestedRunMode?: ReviewRunMode;
  /** The operator picked a reviewer, which is not Claude Code reviewing its own thread. */
  reviewerChosen?: boolean;
  reviewerBackend?: AppServerBackendKind;
  reviewerSummary?: BackendSummary;
  thread: NavigationThreadSummary;
  workspaceCwd?: string;
}): ReviewRunModeDecision {
  const claudeCodeReviewOffered = params.thread.source === "claude";
  const claudeCodeReviewDisabled = claudeCodeReviewOffered
    && params.ownerSummary?.capabilities.reviewClaudeCodeReview !== true;
  const explicitRunModeSupportedByOwner =
    params.ownerSummary?.capabilities.reviewRunMode === true;
  if (prefersClaudeCodeReview(params)) {
    return {
      claudeCodeReviewOffered,
      claudeCodeReviewDisabled: false,
      controlDisabled: !explicitRunModeSupportedByOwner,
      explicitRunModeSupported: explicitRunModeSupportedByOwner,
      runMode: "claude-code-review",
      subagentDisabled: params.reviewerSummary?.capabilities.reviewRunner !== true,
      nativeDisabled: true,
      submissionUnavailable: !explicitRunModeSupportedByOwner,
    };
  }
  // A Claude Code request this owner cannot honor falls back to the usual rules.
  const requestedRunMode = params.requestedRunMode === "claude-code-review"
    ? undefined
    : params.requestedRunMode;
  const reviewerBackend = params.reviewerBackend ?? params.thread.source;
  const reviewerLabel = backendLabel(reviewerBackend, params.reviewerSummary);
  const explicitRunModeSupported =
    params.ownerSummary?.capabilities.reviewRunMode === true;
  const subagentSupported =
    params.reviewerSummary?.capabilities.reviewRunner === true;
  const differentProvider = reviewerBackend !== params.thread.source;

  let forcedReason: string | undefined;
  if (differentProvider) {
    forcedReason =
      `PwrAgent Sub Agent is required because the selected reviewer uses ${reviewerLabel}, a different provider from this thread.`;
  } else if (usesSecondaryWorkspace(params.thread, params.workspaceCwd)) {
    forcedReason =
      "PwrAgent Sub Agent is required because the selected project is not this thread's primary workspace.";
  } else if (params.thread.source.startsWith("acp:")) {
    forcedReason =
      `PwrAgent Sub Agent is required because ${reviewerLabel} runs reviews in a managed subagent.`;
  } else if (params.pullRequestSet) {
    forcedReason = PULL_REQUEST_SET_RUN_MODE_REASON;
  }

  const nativeDisabled = params.ownerSummary?.capabilities.reviewCodexSubAgent !== true;
  const runMode: ReviewRunMode = forcedReason
    ? "pwragent-sub-agent"
    : requestedRunMode ?? "codex-sub-agent";
  const submissionUnavailable = !explicitRunModeSupported
    ? requestedRunMode !== undefined || Boolean(params.pullRequestSet)
    : runMode === "pwragent-sub-agent"
      ? !subagentSupported
      : nativeDisabled;
  const helpText = [
    forcedReason,
    !explicitRunModeSupported
      ? "This thread's owner does not support choosing a review mode. Update that PwrAgent instance to choose a mode."
      : undefined,
    submissionUnavailable ? "The selected review mode is unavailable on this provider." : undefined,
  ].filter(Boolean).join(" ") || undefined;
  return {
    claudeCodeReviewOffered,
    claudeCodeReviewDisabled,
    // A Claude thread can still switch back to Claude Code.
    controlDisabled: (Boolean(forcedReason) && !claudeCodeReviewOffered) || !explicitRunModeSupported,
    explicitRunModeSupported,
    helpText,
    runMode,
    subagentDisabled: !subagentSupported,
    nativeDisabled,
    submissionUnavailable,
  };
}
