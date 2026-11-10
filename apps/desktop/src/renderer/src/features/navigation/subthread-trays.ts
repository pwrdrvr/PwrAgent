import type { NavigationThreadSummary } from "@pwragent/shared";
import { sortSubthreadSummaries } from "@pwragent/shared";
import { threadSummaryIdentityKey, threadSupportsFederationCapability } from "../../lib/federated-thread-events";
import type { NavigationPresentedThread } from "../../lib/navigation-loaded-rows";

export type SubthreadTrays = {
  /**
   * Ordered keys of the *direct* children this tray actually renders — the
   * only rows a tray reorder may move, because `subthreadOrder` is stored per
   * parent. Writing a whole flattened tray back would list grandchildren as
   * children of the row they merely render under.
   */
  directChildKeys: (trayKey: string) => string[];
  /**
   * How deep a tray row sits below its tray owner: 1 for a direct child, 2 for
   * a grandchild, and so on. The tray renders flat, so this is the only thing
   * that tells a grandchild apart from the sibling above it — and it is also
   * why a deeper row does not drag: `subthreadOrder` ranks direct children
   * only. Returns 1 for a row no tray placed, which is the shallowest a
   * rendered tray row can be.
   */
  depth: (threadKey: string) => number;
  /**
   * `trayKey`'s whole descendant subtree, depth-first and already ordered.
   * Render it as-is: re-sorting by the tray owner's `subthreadOrder` would
   * scatter grandchildren away from their parents, because that order only
   * names direct children.
   */
  subtree: (trayKey: string) => NavigationThreadSummary[];
  /**
   * The descendant parents whose rendered subtree ends at `threadKey`,
   * innermost first. Each one owns its own child page, so its paging control
   * belongs right after its last rendered row: below the tray, a mid-level
   * parent's "Load more" would read as the tray owner's. A tray owner is never
   * listed; its control trails the whole tray.
   */
  pagesAfter: (threadKey: string) => readonly NavigationThreadSummary[];
  /**
   * Whether a row is loaded but hidden under a folded descendant. It has
   * landed: it is not a starting thread still waiting for a row, and a
   * starting sub-thread under it belongs inside the fold.
   */
  folded: (threadKey: string) => boolean;
  /**
   * Whether a sub-thread draft at or below this row holds its fold open.
   * Such a row renders open whatever its saved fold says, so its chevron
   * must read open too.
   */
  heldOpen: (threadKey: string) => boolean;
};

export type SubthreadTrayOptions = {
  /**
   * Whether a descendant row's own sub-threads are folded away. Pass it only
   * where every descendant with children renders its own disclosure toggle:
   * a fold with no control on screen hides rows the operator cannot reach.
   * A tray owner's own collapse is the caller's to honor.
   */
  isCollapsed?: (thread: NavigationThreadSummary) => boolean;
  /**
   * Parents of the sub-thread drafts being written. A draft opens every fold
   * above it, as it opens a tray owner, so the draft row is never shown under
   * a closed chevron or hidden inside a fold.
   */
  draftParentKeys?: ReadonlySet<string>;
};

/**
 * Flatten each rendered row's descendant subtree into one tray, depth-first.
 *
 * Sub-threads nest at their true depth in the data; only the view is one level
 * deep, and depth-first keeps a sub-thread immediately after the thread that
 * created it — the same trade `groupCodexNativeSubAgents` makes for native
 * workers. Collapsing the relationship itself instead would leave a grandchild
 * pointing at a row it does not belong to.
 *
 * A descendant's own collapse is consulted only through `options.isCollapsed`.
 * A caller passes it when it draws a disclosure toggle on every descendant
 * that has children; without that toggle, honoring the fold would hide rows
 * behind a control that is nowhere on screen — the invisible-row failure these
 * trays exist to prevent. A tray owner's own collapse is honored by the caller.
 *
 * Reserve every presentation root before walking any descendants. A promoted
 * root can also appear in an ancestor's child page; its own tray must keep
 * both that row and its descendants regardless of the owners' render order.
 *
 * `ownerChildOrder` comes from native child pages or sibling positions in
 * exact owner metadata reads. Navigation rows never carry `subthreadOrder`
 * (it is a detail collection). Without the owner's order a tray falls back
 * to newest-first, and every reorder snaps back on the next read.
 */
export function createSubthreadTrays(
  childrenByParentKey: ReadonlyMap<string, NavigationThreadSummary[]>,
  owners: readonly NavigationThreadSummary[],
  ownerChildOrder?: ReadonlyMap<string, readonly string[]>,
  options: SubthreadTrayOptions = {},
): SubthreadTrays {
  const subtreeByTrayKey = new Map<string, NavigationThreadSummary[]>();
  const directChildKeysByTrayKey = new Map<string, string[]>();
  const depthByThreadKey = new Map<string, number>();
  const pagesAfterByThreadKey = new Map<string, NavigationThreadSummary[]>();
  const foldedThreadKeys = new Set<string>();
  const heldOpenThreadKeys = new Set<string>();
  // Only computed while a draft exists, which is rare; memoized per row.
  const holdsDraft = new Map<string, boolean>();
  const subtreeHoldsDraft = (threadKey: string): boolean => {
    const draftParentKeys = options.draftParentKeys;
    if (!draftParentKeys?.size) return false;
    const known = holdsDraft.get(threadKey);
    if (known !== undefined) return known;
    holdsDraft.set(threadKey, false);
    const held = draftParentKeys.has(threadKey)
      || (childrenByParentKey.get(threadKey) ?? []).some((child) =>
        subtreeHoldsDraft(threadSummaryIdentityKey(child)));
    holdsDraft.set(threadKey, held);
    return held;
  };
  const placedThreadKeys = new Set(owners.map(threadSummaryIdentityKey));

  const collectSubtree = (
    trayKey: string,
    parent: NavigationThreadSummary,
    parentKey: string,
    depth: number,
  ): void => {
    // Read the bucket before sorting: most rows have no sub-threads at all,
    // and sorting each one would copy an array and build a `subthreadOrder`
    // map for nothing.
    const bucket = childrenByParentKey.get(parentKey);
    if (!bucket?.length) return;
    const children = sortTrayChildren(parent, bucket, ownerChildOrder?.get(parentKey));
    // Resolved once per tray rather than per child: this runs for every
    // rendered sub-thread of every directory on each navigation update.
    let tray = subtreeByTrayKey.get(trayKey);
    if (!tray) {
      tray = [];
      subtreeByTrayKey.set(trayKey, tray);
    }
    // Only the rows this tray actually takes. A key an earlier tray already
    // claimed renders there, not here, so counting it would turn on this
    // tray's reorder affordance for a child that has no sibling to move past.
    const directChildKeys =
      parentKey === trayKey ? directChildKeysByTrayKey.get(trayKey) ?? [] : undefined;
    if (directChildKeys) {
      directChildKeysByTrayKey.set(trayKey, directChildKeys);
    }
    for (const child of children) {
      const childKey = threadSummaryIdentityKey(child);
      if (placedThreadKeys.has(childKey)) continue;
      placedThreadKeys.add(childKey);
      directChildKeys?.push(childKey);
      tray.push(child);
      depthByThreadKey.set(childKey, depth);
      if (options.isCollapsed?.(child)) {
        if (subtreeHoldsDraft(childKey)) {
          heldOpenThreadKeys.add(childKey);
        } else {
          foldSubtree(childKey);
          continue;
        }
      }
      collectSubtree(trayKey, child, childKey, depth + 1);
      // A parent with a child page (or one still loading) closes its subtree
      // here. Recursion has already closed every deeper parent, so the list
      // stays innermost first.
      if (childrenByParentKey.get(childKey)?.length || ordinaryChildCountOf(child) > 0) {
        const lastKey = threadSummaryIdentityKey(tray[tray.length - 1]!);
        const closes = pagesAfterByThreadKey.get(lastKey);
        if (closes) closes.push(child);
        else pagesAfterByThreadKey.set(lastKey, [child]);
      }
    }
  };

  // A promoted root keeps its own tray, so a fold never claims it.
  const foldSubtree = (parentKey: string): void => {
    for (const child of childrenByParentKey.get(parentKey) ?? []) {
      const childKey = threadSummaryIdentityKey(child);
      if (placedThreadKeys.has(childKey) || foldedThreadKeys.has(childKey)) continue;
      foldedThreadKeys.add(childKey);
      foldSubtree(childKey);
    }
  };

  for (const owner of owners) {
    const ownerKey = threadSummaryIdentityKey(owner);
    collectSubtree(ownerKey, owner, ownerKey, 1);
  }

  return {
    depth: (threadKey) => depthByThreadKey.get(threadKey) ?? 1,
    directChildKeys: (trayKey) => directChildKeysByTrayKey.get(trayKey) ?? [],
    folded: (threadKey) => foldedThreadKeys.has(threadKey),
    heldOpen: (threadKey) => heldOpenThreadKeys.has(threadKey),
    pagesAfter: (threadKey) => pagesAfterByThreadKey.get(threadKey) ?? NO_PAGES,
    subtree: (trayKey) => subtreeByTrayKey.get(trayKey) ?? [],
  };
}

/**
 * Whether a row draws its sub-thread chevron: the owner supports grouping and
 * this window can write the fold. A row folds only where this holds, or the
 * rows it hides would have no control to bring them back.
 */
export function canFoldSubthreads(
  thread: NavigationThreadSummary,
  canSetCollapsed: boolean,
): boolean {
  return canSetCollapsed && threadSupportsFederationCapability(thread, "thread_grouping");
}

/** The owner's count of a row's ordinary sub-threads, loaded or not. */
export function ordinaryChildCountOf(thread: NavigationPresentedThread): number {
  return thread.ordinaryChildCount ?? 0;
}

const NO_PAGES: readonly NavigationThreadSummary[] = [];

/**
 * A parent's own `subthreadOrder` wins: only this window's optimistic reorder
 * sets it on a row, and it is newer than the page it replaces. Otherwise the
 * owner's page order ranks the children, and a child no page listed yet
 * follows them newest-first, as `sortSubthreadSummaries` places an unranked
 * child.
 */
function sortTrayChildren(
  parent: NavigationThreadSummary,
  bucket: NavigationThreadSummary[],
  ownerOrder: readonly string[] | undefined,
): NavigationThreadSummary[] {
  if (parent.subthreadOrder?.length || !ownerOrder?.length) return sortSubthreadSummaries(parent, bucket);
  const rank = new Map(ownerOrder.map((key, index) => [key, index]));
  return [...bucket].sort((left, right) => {
    const leftRank = rank.get(threadSummaryIdentityKey(left));
    const rightRank = rank.get(threadSummaryIdentityKey(right));
    if (leftRank !== undefined || rightRank !== undefined) {
      return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
    }
    return (right.createdAt ?? 0) - (left.createdAt ?? 0);
  });
}
