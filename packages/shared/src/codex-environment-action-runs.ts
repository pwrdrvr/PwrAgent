import {
  CODEX_ENVIRONMENT_ACTION_RUNS_MAX,
  type CodexEnvironmentActionRun,
  type CodexThreadEnvironmentRuntime,
} from "./contracts/normalized-app-server";

/**
 * Read the action-run list from a runtime, synthesising a single-element
 * array from the deprecated singular `actionId/actionStatus/actionOutput`
 * fields if a runtime persisted before the multi-instance refactor is
 * encountered. New writers always populate `actionRuns` directly; the
 * legacy fields will disappear from disk as runtimes are rewritten.
 */
export function readCodexEnvironmentActionRuns(
  runtime:
    | Pick<
        CodexThreadEnvironmentRuntime,
        | "actionRuns"
        | "actionId"
        | "actionName"
        | "actionCommand"
        | "actionStatus"
        | "actionPid"
        | "actionStartedAt"
        | "actionExitedAt"
        | "actionExitCode"
        | "actionExitSignal"
        | "actionDurationMs"
        | "actionOutput"
      >
    | undefined,
): CodexEnvironmentActionRun[] {
  if (!runtime) return [];
  if (Array.isArray(runtime.actionRuns)) return runtime.actionRuns;
  if (!runtime.actionId || !runtime.actionStatus) return [];
  // Synthesise from legacy fields. runId is deterministic so we don't
  // generate a new one on every read.
  const startedAt = runtime.actionStartedAt ?? 0;
  return [
    {
      runId: `legacy:${runtime.actionId}:${startedAt}`,
      actionId: runtime.actionId,
      actionName: runtime.actionName ?? runtime.actionId,
      command: runtime.actionCommand ?? "",
      status: runtime.actionStatus,
      pid: runtime.actionPid,
      startedAt,
      exitedAt: runtime.actionExitedAt,
      exitCode: runtime.actionExitCode,
      exitSignal: runtime.actionExitSignal,
      durationMs: runtime.actionDurationMs,
      output: runtime.actionOutput,
    },
  ];
}

/**
 * Apply a single update to the action-runs list, capped at the configured
 * maximum. When a new run is appended and the cap is exceeded, the oldest
 * non-running entry is evicted; "started" runs are never evicted so users
 * never silently lose track of a live action even if they queue many.
 */
export function applyCodexEnvironmentActionRunUpdate(
  current: CodexEnvironmentActionRun[],
  update:
    | { kind: "append"; run: CodexEnvironmentActionRun }
    | { kind: "patch"; runId: string; patch: Partial<CodexEnvironmentActionRun> },
): CodexEnvironmentActionRun[] {
  if (update.kind === "append") {
    const next = [...current, update.run];
    while (next.length > CODEX_ENVIRONMENT_ACTION_RUNS_MAX) {
      const evictIndex = next.findIndex((run) => run.status !== "started");
      if (evictIndex === -1) break;
      next.splice(evictIndex, 1);
    }
    return next;
  }
  const idx = current.findIndex((run) => run.runId === update.runId);
  if (idx === -1) return current;
  const next = [...current];
  next[idx] = { ...next[idx], ...update.patch };
  return next;
}
