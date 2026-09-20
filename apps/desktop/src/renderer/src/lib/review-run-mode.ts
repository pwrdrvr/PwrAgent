import {
  findPrimaryReviewWorkspaceCwd,
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
  inlineDisabled: boolean;
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
      `PwrAgent Sub Agent is required because the selected reviewer uses ${reviewerLabel}, a different provider from this thread.`;
  } else if (usesSecondaryWorkspace(params.thread, params.workspaceCwd)) {
    forcedReason =
      "PwrAgent Sub Agent is required because the selected project is not this thread's primary workspace.";
  } else if (params.thread.source.startsWith("acp:")) {
    forcedReason =
      `PwrAgent Sub Agent is required because ${reviewerLabel} runs reviews in a managed subagent.`;
  }

  const inlineDisabled = params.ownerSummary?.capabilities.reviewCodexInline !== true;
  const nativeDisabled = params.ownerSummary?.capabilities.reviewCodexSubAgent !== true;
  const runMode: ReviewRunMode = forcedReason
    ? "pwragent-sub-agent"
    : params.requestedRunMode ?? "codex-sub-agent";
  const submissionUnavailable = !explicitRunModeSupported
    ? params.requestedRunMode !== undefined
    : runMode === "pwragent-sub-agent"
      ? !subagentSupported
      : runMode === "codex-inline" ? inlineDisabled : nativeDisabled;
  const helpText = [
    forcedReason,
    !explicitRunModeSupported
      ? "This thread's owner does not support choosing a review mode. Update that PwrAgent instance to choose a mode."
      : undefined,
    submissionUnavailable ? "The selected review mode is unavailable on this provider." : undefined,
  ].filter(Boolean).join(" ") || undefined;
  return {
    controlDisabled: Boolean(forcedReason) || !explicitRunModeSupported,
    explicitRunModeSupported,
    helpText,
    runMode,
    subagentDisabled: !subagentSupported,
    inlineDisabled,
    nativeDisabled,
    submissionUnavailable,
  };
}
