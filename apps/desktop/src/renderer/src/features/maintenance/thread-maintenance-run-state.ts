import type { ThreadMaintenanceRun } from "@pwragent/shared";

/**
 * The dialog hears about a run three ways: the apply reply, run events, and a
 * fetch. They can arrive in any order. A run with nothing to do finishes and
 * publishes its result before the apply reply arrives, and that reply still
 * says "running". Main stamps every snapshot with a revision that only grows,
 * so the newest snapshot always wins, whichever way it came.
 */
export function newerRun(
  current: ThreadMaintenanceRun | undefined,
  next: ThreadMaintenanceRun | null | undefined,
): ThreadMaintenanceRun | undefined {
  if (!next) return current;
  if (!current) return next;
  return next.revision >= current.revision ? next : current;
}

/** Dialog steps before a run, and "run" once a run is shown. */
export type ThreadMaintenanceStoredPhase = "plan" | "scanning" | "threads" | "hibernate" | "checkouts" | "run";

export type ThreadMaintenancePhase = Exclude<ThreadMaintenanceStoredPhase, "run"> | "running" | "finished";

/** Running and finished come from the newest snapshot, never from a flag set
 * beside it, so the two cannot disagree. Any running run takes the dialog
 * over, including one an agent tool started. */
export function threadMaintenancePhase(
  stored: ThreadMaintenanceStoredPhase,
  run: ThreadMaintenanceRun | undefined,
): ThreadMaintenancePhase {
  if (run?.running) return "running";
  if (stored !== "run") return stored;
  return run ? "finished" : "plan";
}
