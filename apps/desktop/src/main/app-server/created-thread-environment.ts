import type {
  CodexEnvironmentStartupFailure,
  CodexThreadEnvironmentRuntime,
  CreatedThreadEnvironmentReport,
} from "@pwragent/shared";

const SETUP_OUTPUT_TAIL_LENGTH = 2000;

/**
 * Describe the environment an agent-created thread started with, so the
 * calling agent learns what ran and whether it worked. A failed setup must
 * reach the caller here: the thread exists either way.
 */
export function describeCreatedThreadEnvironment(params: {
  source: CreatedThreadEnvironmentReport["source"];
  requested?: string;
  runtime?: CodexThreadEnvironmentRuntime;
  failure?: CodexEnvironmentStartupFailure;
  /** False when the thread reuses a workspace where setup already ran. */
  setupRan: boolean;
  /** Why a thread that would have inherited an environment has none. */
  noneReason?: string;
}): CreatedThreadEnvironmentReport {
  const requested = params.requested ? { requested: params.requested } : {};
  const runtime = params.runtime;
  if (params.source === "none" || !runtime?.environmentId) {
    if (params.source === "requested") {
      return {
        source: "requested",
        ...requested,
        setup: "not_applied",
        message: `The thread started without environment "${params.requested}". The owning instance may run an older PwrAgent that matches environments only by id.`,
      };
    }
    return {
      source: "none",
      ...requested,
      message: params.noneReason
        ? `Started with no environment: ${params.noneReason}`
        : "Started with no environment.",
    };
  }

  const label = `${runtime.environmentName ?? runtime.environmentId} (${runtime.environmentId})`;
  const identity = {
    source: params.source,
    ...requested,
    environmentId: runtime.environmentId,
    ...(runtime.environmentName ? { environmentName: runtime.environmentName } : {}),
  };
  const outcome = {
    ...(runtime.setupExitCode !== undefined ? { setupExitCode: runtime.setupExitCode } : {}),
    ...(runtime.setupDurationMs !== undefined ? { setupDurationMs: runtime.setupDurationMs } : {}),
  };
  if (params.failure || runtime.setupStatus === "failed") {
    const tail = runtime.setupOutput?.trim()
      ? runtime.setupOutput.slice(-SETUP_OUTPUT_TAIL_LENGTH)
      : undefined;
    const exit = runtime.setupExitCode !== undefined ? ` (exit ${runtime.setupExitCode})` : "";
    const reason = params.failure?.message ? `: ${params.failure.message}` : "";
    return {
      ...identity,
      setup: "failed",
      ...outcome,
      ...(tail ? { setupOutputTail: tail } : {}),
      message: `Environment ${label} setup failed${exit}${reason}. The thread was created${tail ? "; see setupOutputTail" : ""}.`,
    };
  }
  if (!params.setupRan) {
    return {
      ...identity,
      setup: "reused",
      message: `Started with environment ${label}. Setup did not run again: the child reuses the parent's setup.`,
    };
  }
  if (runtime.setupStatus === "completed") {
    return {
      ...identity,
      setup: "completed",
      ...outcome,
      message: `Started with environment ${label}. Setup completed in the child's workspace.`,
    };
  }
  return {
    ...identity,
    setup: "skipped",
    message: runtime.executionTarget === "remote"
      ? `Started with environment ${label}. It runs on a remote target, so setup did not run here.`
      : `Started with environment ${label}. It has no setup script.`,
  };
}
