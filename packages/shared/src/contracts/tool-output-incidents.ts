import type {
  AppServerBackendKind,
  ThreadToolAccounting,
  ThreadToolAnalysisCoverage,
  ThreadToolInvocationAlert,
  ThreadToolInvocationRecord,
} from "./normalized-app-server";
import type { FederationTarget } from "./federation";

type ThreadToolInvocationSeverity = ThreadToolInvocationAlert["severity"];

/**
 * Characters per output token. A coarse estimate, but the same one the
 * accounting analyzer and the incident explorer must agree on: a meter drawn
 * against a different ratio than the detector that flagged the case would
 * disagree with its own reason string.
 */
export const TOOL_OUTPUT_TOKEN_CHAR_RATIO = 4;

/**
 * The observed model-visible output cap, in characters (~10k tokens). This is
 * the denominator that makes a per-case meter mean something absolute: a call
 * at 100% is one the harness will truncate, and every character under it
 * replays on every later inference item in the turn.
 */
export const TOOL_OUTPUT_CAP_CHARS = 40_000;

/** Output at or above this is large enough to be worth flagging on its own. */
export const TOOL_OUTPUT_WARNING_CHARS = 4_000;

/** Fraction of the observed output cap this invocation consumed. Uncapped. */
export function toolOutputCapShare(outputChars: number): number {
  return outputChars / TOOL_OUTPUT_CAP_CHARS;
}

/**
 * Whether an invocation counts as a case.
 *
 * `noisy` is written at record time — live by the detectors while a turn runs,
 * or by the history analyzer on demand. Neither has touched a thread whose
 * turns predate the feature, so every one of its rows reads `noisy = 0` and a
 * surface that filters on the flag alone shows an empty screen next to a
 * populated turn strip. The size test is re-derivable from a row we already
 * have, so derive it rather than trusting when the row was written.
 *
 * The flag still matters and is ORed in, because polling is a pattern across
 * invocations: no single row carries enough to reconstruct it.
 */
export function isFlaggedToolInvocation(
  invocation: Pick<ThreadToolInvocationRecord, "noisy" | "outputChars">,
): boolean {
  return invocation.noisy || invocation.outputChars >= TOOL_OUTPUT_WARNING_CHARS;
}

/**
 * Per-thread state for the consolidated tool-output incident notice.
 *
 * One incident per thread, not one per turn. The alert stream is per-turn, so
 * a busy thread minted a fresh durable notice every time it tripped a
 * threshold — forty-one cards behind a pager, each needing its own dismissal.
 * This is the state that lets a thread's incidents collapse into a single
 * card that updates in place, and that survives a restart so an unread
 * incident is still there when the operator comes back to the thread.
 */
export type ThreadToolIncidentNoticeState = {
  /** When this thread first tripped a threshold. The cost baseline. */
  firstWarningAt?: number;
  /** Operator dismissed the card at this severity. */
  dismissedSeverity?: ThreadToolInvocationSeverity;
  dismissedAt?: number;
  /**
   * Operator asked not to be warned again at this severity. A strictly higher
   * severity still breaks through — muting "the output is getting large" must
   * not also mute "the output hit the cap and was truncated".
   */
  mutedSeverity?: ThreadToolInvocationSeverity;
  mutedAt?: number;
};

export type ThreadToolIncidentSeverityRank = 0 | 1;

/** Ordered so a comparison reads as "is this worse than what was silenced". */
export function rankToolIncidentSeverity(
  severity: ThreadToolInvocationSeverity,
): ThreadToolIncidentSeverityRank {
  return severity === "critical" ? 1 : 0;
}

/**
 * Whether an incident at `severity` should surface, given what the operator
 * already dismissed or muted for this thread.
 */
export function resolveToolIncidentVisibility(params: {
  severity: ThreadToolInvocationSeverity;
  state?: ThreadToolIncidentNoticeState;
}): "show" | "suppress" {
  const incoming = rankToolIncidentSeverity(params.severity);
  const muted = params.state?.mutedSeverity;
  if (muted !== undefined && incoming <= rankToolIncidentSeverity(muted)) {
    return "suppress";
  }
  const dismissed = params.state?.dismissedSeverity;
  if (dismissed !== undefined && incoming <= rankToolIncidentSeverity(dismissed)) {
    return "suppress";
  }
  return "show";
}

export type SetThreadToolIncidentNoticeRequest = {
  backend?: AppServerBackendKind;
  federationTarget?: FederationTarget;
  threadId: string;
  /** Records a dismissal at this severity. */
  dismissedSeverity?: ThreadToolInvocationSeverity;
  /** Records a mute at this severity. Higher severities still surface. */
  mutedSeverity?: ThreadToolInvocationSeverity;
  /** First observed warning, recorded once so the cost baseline is stable. */
  firstWarningAt?: number;
  /** Clears dismissal and mute — the un-mute path. */
  reset?: boolean;
};

export type SetThreadToolIncidentNoticeResponse = {
  backend: AppServerBackendKind;
  threadId: string;
  state: ThreadToolIncidentNoticeState;
};

export type OpenToolOutputIncidentExplorerWindowRequest = {
  backend: AppServerBackendKind;
  /**
   * The instance that owns the thread. A federation viewer's incidents are
   * the peer's incidents: without this the explorer reads the thread id
   * against the local registry, which does not have it.
   */
  federationTarget?: FederationTarget;
  projectLabel?: string;
  threadId: string;
  title: string;
};

export type OpenToolOutputIncidentExplorerWindowResponse = {
  opened: true;
};

export type AnalyzeThreadToolHistoryRequest = {
  backend: AppServerBackendKind;
  federationTarget?: FederationTarget;
  threadId: string;
};

export type AnalyzeThreadToolHistoryResponse = {
  accounting: ThreadToolAccounting;
  coverage: ThreadToolAnalysisCoverage;
};

export function buildThreadToolIncidentPrompt(params: {
  invocation: ThreadToolInvocationRecord;
  reason: string;
}): string {
  const invocation = params.invocation;
  const identity = invocation.normalizedCommand ?? invocation.toolName;
  const timestamp = new Date(invocation.observedAt).toLocaleString();
  const exitState = invocation.exitCode !== undefined
    ? `${invocation.status} (exit ${invocation.exitCode})`
    : invocation.status;
  const outputState = invocation.outputState
    ?? (invocation.outputTruncated ? "truncated" : "available");
  const evidence = [
    `Invocation: ${identity}`,
    `Observed: ${timestamp}`,
    `Status: ${exitState}`,
    `Output: ${invocation.outputChars.toLocaleString()} characters (~${invocation.estimatedOutputTokens.toLocaleString()} tokens)`,
    `Output state: ${outputState}`,
    `Why flagged: ${params.reason}`,
  ].join("\n");
  return [
    "Reduce the replay-amplifying tool use identified below.",
    evidence,
    guidanceForInvocation(invocation),
    "Report the exact command/tool identity, exit state, concise result, failures or warnings, and only a bounded tail or targeted fields needed for the next decision.",
  ].join("\n\n");
}

function guidanceForInvocation(invocation: ThreadToolInvocationRecord): string {
  if (invocation.category === "file-io") {
    return "For file reads, narrow the file set and request only the specific line ranges needed.";
  }
  if (invocation.category === "search") {
    return "For search, constrain paths and patterns, then cap the number and size of returned matches.";
  }
  if (
    invocation.category === "build-test"
    || invocation.category === "package-manager"
  ) {
    return "For tests, lint, or builds, redirect complete stdout/stderr to a local log and return only failures, warnings, a concise summary, and a bounded tail.";
  }
  if (invocation.category === "polling") {
    return "Stop polling in the main thread. Use PwrAgent's create_monitor_delegation tool with the durable command, cwd, log/status files, cadence, and terminal success/failure conditions.";
  }
  if (invocation.category === "mcp") {
    return "For MCP calls, request only targeted fields and use pagination or a bounded result limit.";
  }
  return "Redirect complete output to a local log and retrieve only targeted sections or a bounded tail when more detail is needed.";
}
