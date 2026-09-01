/**
 * One home for the per-worktree Git working-state refresh policy.
 *
 * Two lanes probe the same worktrees over the same durable cache: the
 * renderer's navigation path (`ipc/app-server.ts`) and the registry's
 * background convergence lane (`backend-registry.ts`), which serves messaging
 * commands and federated viewers. They are separate because they are driven by
 * different clocks, not because they should disagree about what is stale — so
 * the TTL, the batch size, the freshness predicate, and the selection order
 * live here rather than in either lane.
 *
 * Sibling of `directory-git-status-refresh-policy.ts`, which does the same job
 * for the directory lane.
 */

type WorktreeWorkingStateCacheEntryLike = {
  fetchedAt: number;
};

/**
 * Far shorter than the directory lane's five minutes. Directory status is
 * navigation context; working state feeds the dirty / unpushed / base-drift
 * chips an operator reads while a turn is running, so it has to converge
 * inside one.
 */
export const WORKTREE_WORKING_STATE_CACHE_MAX_AGE_MS = 30_000;

/**
 * Bounds one round, not the process. A fleet larger than this converges over
 * successive rounds because the selection below rotates; the cap only keeps a
 * single navigation snapshot from spawning an unbounded Git fleet.
 */
export const BACKGROUND_WORKTREE_WORKING_STATE_BATCH_SIZE = 8;

export function isFreshWorktreeWorkingStateCacheEntry(
  entry: WorktreeWorkingStateCacheEntryLike,
  now = Date.now(),
): boolean {
  return now - entry.fetchedAt < WORKTREE_WORKING_STATE_CACHE_MAX_AGE_MS;
}

/**
 * Picks the worktrees a round should probe.
 *
 * `exclude` is applied before the cap, not after: a lane that drops its
 * in-flight paths afterwards can select a full batch of paths it is already
 * probing and schedule nothing, while a stale worktree behind them waits for
 * a later round.
 *
 * `force` skips the freshness test but not `exclude` — a forced refresh still
 * has nothing to add to a probe already running against that worktree.
 *
 * Omitting `limit` returns every stale path unsorted. Focus and user-triggered
 * lanes ask about one worktree and want it now; the cap and the rotation below
 * exist for the automatic lanes that see the whole fleet.
 */
export function selectStaleWorktreeWorkingStatePaths(params: {
  cache: ReadonlyMap<string, WorktreeWorkingStateCacheEntryLike>;
  exclude?: ReadonlySet<string>;
  force?: boolean;
  limit?: number;
  now?: number;
  worktreePaths: readonly string[];
}): string[] {
  const now = params.now ?? Date.now();
  const stale = [
    ...new Set(params.worktreePaths.map((worktreePath) => worktreePath.trim())),
  ].filter((worktreePath) => {
    if (!worktreePath || params.exclude?.has(worktreePath)) {
      return false;
    }
    if (params.force) {
      return true;
    }
    const cached = params.cache.get(worktreePath);
    return !cached || !isFreshWorktreeWorkingStateCacheEntry(cached, now);
  });

  if (params.limit === undefined || stale.length <= params.limit) {
    return stale;
  }

  // Stable thread ordering must not let the same prefix win every round.
  // Never-probed worktrees go first; after that the oldest probe rotates
  // forward, so a fleet larger than one batch still converges.
  stale.sort((left, right) => {
    const leftFetchedAt = params.cache.get(left)?.fetchedAt;
    const rightFetchedAt = params.cache.get(right)?.fetchedAt;
    if (leftFetchedAt === undefined) {
      return rightFetchedAt === undefined ? 0 : -1;
    }
    if (rightFetchedAt === undefined) {
      return 1;
    }
    return leftFetchedAt - rightFetchedAt;
  });
  return stale.slice(0, params.limit);
}
