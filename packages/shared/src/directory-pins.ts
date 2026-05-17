import type { NavigationDirectorySummary } from "./contracts/navigation";
import {
  comparePinnedThreads,
  isPinnedThread,
  moveThreadKey,
} from "./thread-pins";

/**
 * Directory-shaped wrappers around the generic pin helpers in
 * `thread-pins.ts`. The underlying helpers are shape-generic over
 * `{ id, pinnedRank, updatedAt? }`, but directories use `key` and
 * `latestUpdatedAt`, so these wrappers project to the shared shape
 * once at the call site rather than forcing every caller to do the
 * field renaming inline.
 *
 * Keeping the wrappers in their own file (instead of importing
 * `comparePinnedThreads` directly into `DirectoriesList.tsx`) keeps
 * the reading intent clear at every call site: `comparePinnedDirectories`
 * tells the reader "we're comparing directory pin order" without
 * leaking the thread-shaped helper's name into directory code.
 *
 * NOTE: shape-agnostic helpers (`buildAppendPinRank`,
 * `buildPinnedRanks`) are NOT re-exported here. Importing them from
 * `thread-pins` directly at the call site keeps the dependency
 * direction obvious — `directory-pins` is a thin adapter, not a
 * superset.
 */
export function isPinnedDirectory(
  directory: Pick<NavigationDirectorySummary, "pinnedRank">,
): boolean {
  return isPinnedThread({ id: "", pinnedRank: directory.pinnedRank });
}

export function comparePinnedDirectories(
  left: NavigationDirectorySummary,
  right: NavigationDirectorySummary,
): number {
  return comparePinnedThreads(
    {
      id: left.key,
      pinnedRank: left.pinnedRank,
      updatedAt: left.latestUpdatedAt,
    },
    {
      id: right.key,
      pinnedRank: right.pinnedRank,
      updatedAt: right.latestUpdatedAt,
    },
  );
}

export const moveDirectoryKey = moveThreadKey;
