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
  helpText?: string;
  runMode: ReviewRunMode;
  separateThreadDisabled: boolean;
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
  const fallbackPrimary =
    thread.linkedDirectories.find((directory) => directory.kind === "worktree")
    ?? thread.linkedDirectories.find((directory) => directory.kind === "local")
    ?? thread.linkedDirectories[0];
  const primary = normalizeWorkspacePath(
    findPreferredReviewWorkspaceCwd(thread)
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
  requestedRunMode?: ReviewRunMode;
  reviewerBackend?: AppServerBackendKind;
  reviewerSummary?: BackendSummary;
  thread: NavigationThreadSummary;
  workspaceCwd?: string;
}): ReviewRunModeDecision {
  const reviewerBackend = params.reviewerBackend ?? params.thread.source;
  const reviewerLabel = backendLabel(reviewerBackend, params.reviewerSummary);
  // A missing summary is still loading, not proof that the owner cannot run a
  // child. Once a summary is present, require the explicit capability probe so
  // older federation owners and unsupported providers stay gated.
  const managedChildSupported = params.reviewerSummary
    ? params.reviewerSummary.capabilities.reviewRunner === true
    : reviewerBackend === "codex";
  const differentProvider = reviewerBackend !== params.thread.source;

  let forcedReason: string | undefined;
  if (differentProvider) {
    forcedReason =
      `Separate thread is required because the selected reviewer uses ${reviewerLabel}, a different provider from this thread.`;
  } else if (usesSecondaryWorkspace(params.thread, params.workspaceCwd)) {
    forcedReason =
      "Separate thread is required because the selected project is not this thread's primary workspace.";
  } else if (params.thread.source.startsWith("acp:")) {
    forcedReason =
      `Separate thread is required because ${reviewerLabel} runs reviews as managed child threads.`;
  }

  const unavailableReason = managedChildSupported
    ? undefined
    : `${reviewerLabel} cannot run a managed review in a separate thread.`;
  const helpText = [forcedReason, unavailableReason].filter(Boolean).join(" ")
    || undefined;
  const runMode = forcedReason
    ? "managed-child"
    : params.requestedRunMode ?? "inline";

  return {
    controlDisabled: Boolean(forcedReason),
    helpText,
    runMode,
    separateThreadDisabled: !managedChildSupported,
  };
}
