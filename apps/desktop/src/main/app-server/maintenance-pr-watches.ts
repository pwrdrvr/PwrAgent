import { buildPullRequestStatusKey, type PrSummary, type ThreadPullRequestWatchSummary } from "@pwragent/shared";

export type MaintenancePrObservation = { pr: PrSummary; fetchedAt: number };

/** Eligibility uses saved observations only. A pending terminal notification
 * may still need delivery, but it cannot keep an idle checkout on disk. */
export function protectiveMaintenanceWatches(
  watches: readonly ThreadPullRequestWatchSummary[],
  observations: readonly MaintenancePrObservation[],
): ThreadPullRequestWatchSummary[] {
  const latest = new Map<string, MaintenancePrObservation>();
  for (const observation of observations) {
    const key = buildPullRequestStatusKey(observation.pr).toLowerCase();
    const previous = latest.get(key);
    if (!previous || observation.fetchedAt >= previous.fetchedAt) latest.set(key, observation);
  }
  return watches.filter((watch) => {
    const state = latest.get(watch.prKey.trim().toLowerCase())?.pr.lifecycleState;
    return state !== "merged" && state !== "closed";
  });
}
