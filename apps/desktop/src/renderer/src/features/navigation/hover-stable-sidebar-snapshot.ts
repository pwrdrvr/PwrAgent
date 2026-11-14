import type {
  NavigationThreadSummary,
} from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import type { NavigationDirectoryView as NavigationDirectorySummary } from "../../lib/navigation-loaded-rows";
import {
  retainNavigationPresentationOrder,
  type NavigationPresentationOrder,
} from "./navigation-presentation-order";

export type HoverStableSidebarSnapshot = {
  order: NavigationPresentationOrder;
  visibleKeys: string[];
  directories: NavigationDirectorySummary[];
  threads: NavigationThreadSummary[];
};

export type HydrateHoverStableSidebarOptions = {
  refreshThreadPinRanks?: boolean;
  removeMissingThreads?: boolean;
};

/**
 * Refresh row content without accepting structural fields that can move a row
 * while the pointer is resting on it. Live state such as federation health,
 * turn status, PRs, and unread markers still reaches the stationary card.
 */
export function hydrateHoverStableSidebarSnapshot(
  frozen: HoverStableSidebarSnapshot,
  latest: HoverStableSidebarSnapshot,
  options?: HydrateHoverStableSidebarOptions,
): HoverStableSidebarSnapshot {
  const latestDirectoriesByKey = new Map(
    latest.directories.map((directory) => [directory.key, directory]),
  );
  const latestThreadsByKey = new Map(
    latest.threads.map((thread) => [
      threadSummaryIdentityKey(thread),
      thread,
    ]),
  );
  const frozenDirectoryKeys = new Set(
    frozen.directories.map((directory) => directory.key),
  );
  const frozenThreadKeys = new Set(
    frozen.threads.map((thread) =>
      threadSummaryIdentityKey(thread),
    ),
  );
  const frozenVisibleKeys = new Set(frozen.visibleKeys);
  const latestVisibleKeys = options?.removeMissingThreads ? new Set(latest.visibleKeys) : undefined;

  return {
    order: retainNavigationPresentationOrder(frozen.order, latest.order),
    visibleKeys: [...frozen.visibleKeys.filter((key) => !latestVisibleKeys || latestVisibleKeys.has(key)),
      ...latest.visibleKeys.filter((key) => !frozenVisibleKeys.has(key))],
    directories: [
      ...frozen.directories.map((directory) => {
        const latestDirectory = latestDirectoriesByKey.get(directory.key);
        if (!latestDirectory) return directory;
        if (latestDirectory.pinnedRank === directory.pinnedRank) return latestDirectory;
        return {
          ...latestDirectory,
          pinnedRank: directory.pinnedRank,

        };
      }),
      ...latest.directories
        .filter((directory) => !frozenDirectoryKeys.has(directory.key))
        .map((directory) => ({ ...directory, pinnedRank: undefined })),
    ],
    threads: [
      ...frozen.threads.flatMap((thread) => {
        const latestThread = latestThreadsByKey.get(
          threadSummaryIdentityKey(thread),
        );
        if (!latestThread) {
          return options?.removeMissingThreads ? [] : [thread];
        }
        if (latestThread.createdAt === thread.createdAt
          && latestThread.parentThreadBackend === thread.parentThreadBackend
          && latestThread.parentThreadId === thread.parentThreadId
          && latestThread.parentThreadInstanceId === thread.parentThreadInstanceId
          && (options?.refreshThreadPinRanks || latestThread.pinnedRank === thread.pinnedRank)
          && latestThread.codexNativeSubAgents === thread.codexNativeSubAgents
          && latestThread.subthreadsCollapsed === thread.subthreadsCollapsed
          && latestThread.subthreadOrder === thread.subthreadOrder) return [latestThread];
        return [
          {
            ...latestThread,
            createdAt: thread.createdAt,
            parentThreadBackend: thread.parentThreadBackend,
            parentThreadId: thread.parentThreadId,
            parentThreadInstanceId: thread.parentThreadInstanceId,
            pinnedRank: options?.refreshThreadPinRanks
              ? latestThread.pinnedRank
              : thread.pinnedRank,
            codexNativeSubAgents: thread.codexNativeSubAgents,
            subthreadsCollapsed: thread.subthreadsCollapsed,
            subthreadOrder: thread.subthreadOrder,
          },
        ];
      }),
      // A newly admitted row has no previous position to freeze. Preserve its
      // owner placement on first paint: clearing pin/parent fields renders a
      // false unpinned root until hover ends. Retained presentation order
      // already controls where new entries are appended within each resource.
      ...latest.threads.filter((thread) => !frozenThreadKeys.has(
        threadSummaryIdentityKey(thread),
      )),
    ],
  };
}

/**
 * Own-enumerable-key comparison — deliberately the same test `React.memo`
 * applies to props, so "this object is interchangeable with the previous one"
 * means the same thing here as it does at the memo boundary downstream.
 */
function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]));
}

function preserveItems<T extends object>(
  previous: readonly T[],
  next: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const previousByKey = new Map(previous.map((item) => [keyOf(item), item]));
  let reusable = previous.length === next.length;
  const result = next.map((item, index) => {
    const candidate = previousByKey.get(keyOf(item));
    const reused =
      candidate !== undefined
      && shallowEqual(
        candidate as unknown as Record<string, unknown>,
        item as unknown as Record<string, unknown>,
      )
        ? candidate
        : item;
    if (reused !== previous[index]) reusable = false;
    return reused;
  });
  return reusable ? (previous as T[]) : result;
}

function preserveKeys(previous: string[], next: string[]): string[] {
  return previous.length === next.length
    && previous.every((key, index) => key === next[index])
    ? previous
    : next;
}

function preserveOrder(
  previous: NavigationPresentationOrder,
  next: NavigationPresentationOrder,
): NavigationPresentationOrder {
  if (previous.size !== next.size) return next;
  for (const [id, entries] of next) {
    const previousEntries = previous.get(id);
    if (
      previousEntries === undefined
      || previousEntries.length !== entries.length
      || previousEntries.some((entry, index) => entry !== entries[index])
    ) {
      return next;
    }
  }
  return previous;
}

/**
 * Wrap `hydrateHoverStableSidebarSnapshot` so that a call producing the same
 * VALUES as the previous call returns the previous OBJECTS.
 *
 * Hydration runs while the pointer rests on a row. Structural overrides can
 * allocate replacement rows, so recover the previous identity when their
 * values have not changed at the downstream memo boundary.
 *
 * Immutable input collections also allow unrelated Sidebar renders to reuse
 * the result before building indexes. Equal-but-fresh producer values still
 * recover identity at the row memo boundary below.
 *
 * One hydrator instance holds one previous result, so callers must keep it
 * per component instance (a ref), not per module.
 */
export function createHoverStableSidebarHydrator(): (
  frozen: HoverStableSidebarSnapshot,
  latest: HoverStableSidebarSnapshot,
  options?: HydrateHoverStableSidebarOptions,
) => HoverStableSidebarSnapshot {
  let previous: HoverStableSidebarSnapshot | undefined;
  let inputs: { frozen: HoverStableSidebarSnapshot; latest: HoverStableSidebarSnapshot;
    refreshThreadPinRanks: boolean; removeMissingThreads: boolean } | undefined;
  return (frozen, latest, options) => {
    const refreshThreadPinRanks = options?.refreshThreadPinRanks === true;
    const removeMissingThreads = options?.removeMissingThreads === true;
    if (inputs?.frozen === frozen && inputs.latest.directories === latest.directories
      && inputs.latest.threads === latest.threads && inputs.latest.visibleKeys === latest.visibleKeys
      && inputs.latest.order === latest.order && inputs.refreshThreadPinRanks === refreshThreadPinRanks
      && inputs.removeMissingThreads === removeMissingThreads) return previous!;
    inputs = { frozen, latest, refreshThreadPinRanks, removeMissingThreads };
    const next = hydrateHoverStableSidebarSnapshot(frozen, latest, options);
    if (previous === undefined) {
      previous = next;
      return next;
    }
    const threads = preserveItems(
      previous.threads,
      next.threads,
      threadSummaryIdentityKey,
    );
    const directories = preserveItems(
      previous.directories,
      next.directories,
      (directory) => directory.key,
    );
    const visibleKeys = preserveKeys(previous.visibleKeys, next.visibleKeys);
    const order = preserveOrder(previous.order, next.order);
    previous =
      threads === previous.threads
      && directories === previous.directories
      && visibleKeys === previous.visibleKeys
      && order === previous.order
        ? previous
        : { directories, order, threads, visibleKeys };
    return previous;
  };
}
