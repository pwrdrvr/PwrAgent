import type { ResearchRunHeader } from "@pwragent/shared/research";

export type ResearchOwnerIdentity = Pick<ResearchRunHeader, "ownerId" | "ownerPid" | "ownerStartedAt">;

/**
 * Whether a process may record on a run. The process holding it always may.
 * A restart is a new process, so a later one may once the holder is gone: the
 * operator and coordinating thread are unchanged, and nobody else could ever
 * record on it. A different process that is still running keeps its runs,
 * live or not. A live Harness run is the exception: its bridge ended with its
 * process, so it stays put until recovery retires it.
 */
export function researchRunHeldBy(run: ResearchOwnerIdentity & Pick<ResearchRunHeader, "status"> & { harness?: unknown }, ownerId: string, isOwnerAlive: (owner: ResearchOwnerIdentity) => boolean): boolean {
  if (run.ownerId === ownerId) return true;
  if (run.harness && (run.status === "running" || run.status === "stopping")) return false;
  return !isOwnerAlive(run);
}

/** Whether recording on a run a gone process held first needs this process to take it over: it is still open for work. */
export function researchRunNeedsAdoption(run: Pick<ResearchRunHeader, "status" | "ownerId"> & { harness?: unknown }, ownerId: string): boolean {
  return run.ownerId !== ownerId && !run.harness && ["running", "stopping", "exhausted"].includes(run.status);
}

export const RESEARCH_RUN_HELD_ELSEWHERE = "Another running PwrAgent process owns this run. Record this from that process.";
