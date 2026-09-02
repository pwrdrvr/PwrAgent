import {
  findPreferredReviewWorkspaceCwd,
  type AppServerBackendKind,
  type BackendSummary,
  type NavigationThreadSummary,
  type ReviewRunMode,
} from "@pwragent/shared";
import { formatBackendLabel } from "./backend-label";

export type ReviewRunModeDecision = {
  controlDisabled: boolean;
  explicitRunModeSupported: boolean;
  helpText?: string;
  runMode: ReviewRunMode;
  subagentDisabled: boolean;
};

function normalizeWorkspacePath(value?: string): string | undefined {
  const normalized = value?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || undefined;
}

function findProjectWorkspaceCwd(
  thread: NavigationThreadSummary,
): string | undefined {
  const projectKey = normalizeWorkspacePath(thread.projectKey);
  if (!projectKey) return undefined;

  return thread.linkedDirectories
    .flatMap((directory) => {
      const workspaceCwd = normalizeWorkspacePath(
        directory.worktreePath ?? directory.path,
      );
      const matchLength = [directory.worktreePath, directory.path]
        .map(normalizeWorkspacePath)
        .filter((candidate): candidate is string => Boolean(candidate))
        .filter((candidate) => (
          projectKey === candidate
          || projectKey.startsWith(`${candidate}/`)
        ))
        .reduce((longest, candidate) => Math.max(longest, candidate.length), 0);
      return workspaceCwd && matchLength > 0
        ? [{ matchLength, workspaceCwd }]
        : [];
    })
    .sort((left, right) => right.matchLength - left.matchLength)[0]
    ?.workspaceCwd;
}

function usesSecondaryWorkspace(
  thread: NavigationThreadSummary,
  workspaceCwd?: string,
): boolean {
  if (thread.source !== "codex") return false;
  const selected = normalizeWorkspacePath(workspaceCwd);
  const fallbackPrimary = thread.linkedDirectories[0];
  const primary = normalizeWorkspacePath(
    findPreferredReviewWorkspaceCwd(thread)
    ?? findProjectWorkspaceCwd(thread)
    ?? fallbackPrimary?.worktreePath
    ?? fallbackPrimary?.path
    ?? thread.projectKey,
  );
  return Boolean(selected && primary && selected !== primary);
}

function backendLabel(
  backend: AppServerBackendKind,
  summary?: BackendSummary,
): string {
  return formatBackendLabel(backend, summary ? [summary] : undefined);
}

export function resolveReviewRunMode(params: {
  ownerSummary?: BackendSummary;
  requestedRunMode?: ReviewRunMode;
  reviewerBackend?: AppServerBackendKind;
  reviewerSummary?: BackendSummary;
  thread: NavigationThreadSummary;
  workspaceCwd?: string;
}): ReviewRunModeDecision {
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
      `A review subagent is required because the selected reviewer uses ${reviewerLabel}, a different provider from this thread.`;
  } else if (usesSecondaryWorkspace(params.thread, params.workspaceCwd)) {
    forcedReason =
      "A review subagent is required because the selected project is not this thread's primary workspace.";
  } else if (params.thread.source.startsWith("acp:")) {
    forcedReason =
      `A review subagent is required because ${reviewerLabel} runs reviews in a managed subagent.`;
  }

  const unavailableReason = params.reviewerSummary && !subagentSupported
    ? `${reviewerLabel} cannot run this review in a subagent.`
    : undefined;
  const unsupportedOwnerReason = explicitRunModeSupported || forcedReason
    ? undefined
    : "This thread's owner does not support choosing a review location. Reviews use the owner's configured default.";
  const helpText = [
    forcedReason,
    unavailableReason,
    unsupportedOwnerReason,
  ].filter(Boolean).join(" ")
    || undefined;
  const runMode = forcedReason
    ? "managed-child"
    : explicitRunModeSupported
      ? params.requestedRunMode ?? "inline"
      : "inline";

  return {
    controlDisabled: Boolean(forcedReason) || !explicitRunModeSupported,
    explicitRunModeSupported,
    helpText,
    runMode,
    subagentDisabled: !subagentSupported,
  };
}
