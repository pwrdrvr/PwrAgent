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

  return {
    order: retainNavigationPresentationOrder(frozen.order, latest.order),
    visibleKeys: [...frozen.visibleKeys.filter((key) => !options?.removeMissingThreads || latest.visibleKeys.includes(key)),
      ...latest.visibleKeys.filter((key) => !frozen.visibleKeys.includes(key))],
    directories: [
      ...frozen.directories.map((directory) => {
        const latestDirectory = latestDirectoriesByKey.get(directory.key);
        if (!latestDirectory) return directory;
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
 * The hydrate runs during render for as long as the pointer rests on a row,
 * and it rebuilds every thread, every directory, and every array on each
 * call — so without this a memoized row re-renders on every parent render for
 * exactly as long as the pointer is on it, which is the one situation the
 * memo was added for. Measured before this existed: 200 `thread`-identity
 * changes while hovering versus 0 when not.
 *
 * Identity has to be recovered from values rather than from input references.
 * The `latest` argument is a fresh object literal built inline at the
 * `useHoverStableSnapshot` call site — its `visibleKeys` is a fresh `.map()`
 * and its `order` a fresh Map — so it is never reference-equal to the
 * previous render's, and a cache keyed on the inputs would never hit.
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
  return (frozen, latest, options) => {
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
