/**
 * PR discovery — the low-cadence "did a new PR appear?" sweep.
 *
 * The fast GraphQL poller (`pr-polling-scheduler.ts`) keeps the status of PRs
 * we ALREADY track fresh. It cannot find a PR we don't know about yet — it
 * polls by number. Discovery closes that gap by re-running the branch-based
 * lookup (`gh pr list --head <branch>`) across EVERY open thread, not just the
 * selected one, on a slow rotation.
 *
 * Why branch-lookup rather than a GitHub search/`since` crawl: PwrAgent attaches
 * PRs to a thread by matching the thread's branch. A raw "list PRs updated since
 * T" crawl would find PRs but have nowhere to attach them. Re-running the branch
 * lookup reuses the entire existing attachment + cache + coalescing path, so a
 * discovered PR surfaces on its thread exactly as an on-selection fetch would.
 * This is the periodic refresh across open repos that was lost.
 *
 * The selection below is a pure function so the rotation logic is testable
 * without timers or a live `gh`.
 */

export type DiscoveryDueSelection = {
  /** All threads that currently have a PR refresh context. */
  threadKeys: string[];
  /** Per-thread last discovery-refresh time; missing ⇒ never, so due now. */
  lastRefreshedAt: ReadonlyMap<string, number>;
  now: number;
  /** A thread is eligible again once this long has passed since its last sweep. */
  cadenceMs: number;
  /** Cap per tick so discovery can't drain the shared token budget in one pass. */
  maxPerTick: number;
  /**
   * Threads to skip — the selected / on-screen ones. They already get a fast
   * branch-lookup from the renderer, so re-doing it here is pure waste.
   */
  skipThreadKeys?: ReadonlySet<string>;
};

/**
 * Pick the threads to discovery-refresh this tick: those past their cadence,
 * least-recently-swept first (so the rotation covers everyone), capped.
 */
export function selectDiscoveryDueThreadKeys(
  selection: DiscoveryDueSelection,
): string[] {
  const skip = selection.skipThreadKeys;
  return selection.threadKeys
    .filter((threadKey) => !skip?.has(threadKey))
    .map((threadKey) => ({
      threadKey,
      lastRefreshedAt: selection.lastRefreshedAt.get(threadKey) ?? 0,
    }))
    .filter((entry) => selection.now - entry.lastRefreshedAt >= selection.cadenceMs)
    // Least-recently-swept first — this is what rotates coverage across the
    // whole list instead of always re-picking the head.
    .sort((a, b) => a.lastRefreshedAt - b.lastRefreshedAt)
    .slice(0, Math.max(0, selection.maxPerTick))
    .map((entry) => entry.threadKey);
}
