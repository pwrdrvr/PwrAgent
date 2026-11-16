import type { QuietRestartTarget } from "../app-server/backend-registry-types";

/**
 * "Quiet & Continue After Restart" from the quit dialog. The initial durable
 * checkpoint must succeed before anything stops. Later cleanup is bounded:
 * whatever is still running when this resolves is interrupted by the normal shutdown, and the next launch sends
 * each stopped thread its continuation (see `restart-continuation-gate.ts`).
 *
 * 1. Shut restart dispatch and admission, so new work is explicitly refused.
 * 2. Save one continuation per running thread, and every message waiting
 *    in a queue, before anything is stopped, so a crash from here on still
 *    continues them.
 * 3. Steer each running turn that it is about to stop, and SIGTERM every
 *    environment action (SIGKILL after a short grace).
 * 4. Give the turns a short window to finish on their own.
 * 5. Save again, covering accepted work that was still starting and any
 *    operator edits to the checkpointed queue.
 */
export type QuietRestartDependencies = {
  registry: {
    beginQuietRestart(): QuietRestartTarget[];
    cancelQuietRestart(): void;
    saveRestartContinuations(targets: readonly QuietRestartTarget[], stoppedAt?: number, requireCheckpoint?: boolean): number;
    steerTurnsForQuietRestart(targets: readonly QuietRestartTarget[]): Promise<number>;
    waitForQuietRestartTurns(
      targets: readonly QuietRestartTarget[],
      timeoutMs: number,
    ): Promise<"ended" | "deadline">;
  };
  /** SIGTERM every environment action; SIGKILL after `graceMs`. */
  terminateActions: (graceMs: number) => Promise<number>;
  log: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => number;
  /** How long turns get to stop on their own after the steer. */
  turnGraceMs?: number;
  /** How long environment actions get between SIGTERM and SIGKILL. */
  actionGraceMs?: number;
};

export type QuietRestartSummary = {
  runningTurns: number;
  continuations: number;
  steered: number;
  actionsTerminated: number;
  turns: "ended" | "deadline" | "failed";
  durationMs: number;
};

export const QUIET_RESTART_TURN_GRACE_MS = 15_000;
export const QUIET_RESTART_ACTION_GRACE_MS = 3_000;

export async function runQuietRestart(
  dependencies: QuietRestartDependencies,
): Promise<QuietRestartSummary> {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const summary: QuietRestartSummary = {
    runningTurns: 0,
    continuations: 0,
    steered: 0,
    actionsTerminated: 0,
    turns: "failed",
    durationMs: 0,
  };
  const step = async <T>(name: string, run: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      dependencies.log.warn?.("quiet restart step failed", {
        step: name,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };

  let targets: QuietRestartTarget[];
  try {
    targets = dependencies.registry.beginQuietRestart();
    summary.runningTurns = targets.length;
    summary.continuations = dependencies.registry.saveRestartContinuations(targets, startedAt, true);
  } catch (error) {
    dependencies.registry.cancelQuietRestart();
    throw error;
  }
  const [steered, actionsTerminated] = await Promise.all([
    step("steer", () => dependencies.registry.steerTurnsForQuietRestart(targets)),
    step("terminate-actions", () => dependencies.terminateActions(
      dependencies.actionGraceMs ?? QUIET_RESTART_ACTION_GRACE_MS,
    )),
  ]);
  summary.steered = steered ?? 0;
  summary.actionsTerminated = actionsTerminated ?? 0;
  summary.turns = await step("wait", () => dependencies.registry.waitForQuietRestartTurns(
    targets,
    dependencies.turnGraceMs ?? QUIET_RESTART_TURN_GRACE_MS,
  )) ?? "failed";
  await step("save-final", () => dependencies.registry.saveRestartContinuations(targets, startedAt));
  summary.durationMs = now() - startedAt;
  dependencies.log.info?.("quiet restart ready to quit", { ...summary });
  return summary;
}
