import type { ResearchRunHeader } from "@pwragent/shared/research";

export type ResearchOwnerIdentity = Pick<ResearchRunHeader, "ownerId" | "ownerPid" | "ownerStartedAt">;

/**
 * Whether a process may record on a run: review a candidate, finish it, or
 * reconcile its source. A run's own process always may. A restart is a new
 * process, so a later one may too once the run is no longer live and the
 * process that started it is gone. The operator and coordinating thread are
 * unchanged, and nobody else could ever record on it. A different process
 * that is still running keeps its runs, live or not, and a live run stays
 * with the process that holds its workers or bridge until recovery retires it.
 */
export function researchRunHeldBy(run: ResearchOwnerIdentity & Pick<ResearchRunHeader, "status">, ownerId: string, isOwnerAlive: (owner: ResearchOwnerIdentity) => boolean): boolean {
  if (run.ownerId === ownerId) return true;
  if (run.status === "running" || run.status === "stopping") return false;
  return !isOwnerAlive(run);
}

export const RESEARCH_RUN_HELD_ELSEWHERE = "Another running PwrAgent process owns this run. Record this from that process.";
