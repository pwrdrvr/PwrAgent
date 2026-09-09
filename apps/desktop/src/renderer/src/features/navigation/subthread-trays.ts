import type { NavigationThreadSummary } from "@pwragent/shared";
import { sortSubthreadSummaries } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";

export type SubthreadTrays = {
  /**
   * Give `owner` a tray and fill it with its whole descendant subtree. Rows
   * already claimed by an earlier owner are skipped, so a cycle in the stored
   * parent links terminates and no row renders twice.
   */
  addTrayOwner: (owner: NavigationThreadSummary) => void;
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
 * A descendant's own `subthreadsCollapsed` is deliberately not consulted. Only
 * a tray owner renders a disclosure toggle, so honoring an intermediate row's
 * collapse would hide its children behind a control that is nowhere on screen
 * — the invisible-row failure these trays exist to prevent. A tray owner's own
 * collapse is honored by the caller.
 */
export function createSubthreadTrays(
  childrenByParentKey: ReadonlyMap<string, NavigationThreadSummary[]>,
): SubthreadTrays {
  const subtreeByTrayKey = new Map<string, NavigationThreadSummary[]>();
  const directChildKeysByTrayKey = new Map<string, string[]>();
  const depthByThreadKey = new Map<string, number>();
  const placedThreadKeys = new Set<string>();

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
    const children = sortSubthreadSummaries(parent, bucket);
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
      collectSubtree(trayKey, child, childKey, depth + 1);
    }
  };

  return {
    addTrayOwner: (owner) => {
      const ownerKey = threadSummaryIdentityKey(owner);
      placedThreadKeys.add(ownerKey);
      collectSubtree(ownerKey, owner, ownerKey, 1);
    },
    depth: (threadKey) => depthByThreadKey.get(threadKey) ?? 1,
    directChildKeys: (trayKey) => directChildKeysByTrayKey.get(trayKey) ?? [],
    subtree: (trayKey) => subtreeByTrayKey.get(trayKey) ?? [],
  };
}
