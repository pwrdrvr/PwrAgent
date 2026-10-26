import type { NavigationQueryEntry } from "@pwragent/shared";
import type { NavigationWindowQueriesState } from "../../lib/navigation-window-queries";
import { navigationThreadSelectionKey } from "../../lib/navigation-query-state";

export type NavigationPresentationEntry = { key: string; placement: NavigationQueryEntry["placement"] };
export type NavigationPresentationOrder = ReadonlyMap<string, readonly NavigationPresentationEntry[]>;

/** Presentation metadata only: never a query page, cursor, generation or membership proof. */
export function readNavigationPresentationOrder(resources: NavigationWindowQueriesState["resources"]): NavigationPresentationOrder {
  return new Map([...resources].map(([id, resource]) => [id,
    (resource.state.page?.entries ?? []).map((entry) => ({ key: navigationThreadSelectionKey(entry.row.ref), placement: entry.placement })),
  ]));
}

/** One pointer-held range plus the current admitted range; no history accumulates. */
export function retainNavigationPresentationOrder(frozen: NavigationPresentationOrder, latest: NavigationPresentationOrder): NavigationPresentationOrder {
  const result = new Map(frozen);
  for (const [id, entries] of latest) {
    const previous = frozen.get(id) ?? [];
    const keys = new Set(previous.map((entry) => entry.key));
    result.set(id, [...previous, ...entries.filter((entry) => !keys.has(entry.key))]);
  }
  return result;
}

/**
 * Each parent's child keys in the order its owner's child pages listed them:
 * the saved `subthreadOrder`, which navigation rows do not carry.
 */
export function readOwnerChildOrder(
  resources: NavigationWindowQueriesState["resources"],
  presentation: NavigationPresentationOrder,
): Map<string, string[]> {
  const order = new Map<string, Set<string>>();
  for (const resource of resources.values()) {
    if (resource.state.request.query.kind !== "children") continue;
    for (const entry of presentation.get(resource.id) ?? []) {
      if (entry.placement.kind !== "child") continue;
      const parentKey = navigationThreadSelectionKey(entry.placement.parent);
      const keys = order.get(parentKey) ?? new Set<string>();
      keys.add(entry.key);
      order.set(parentKey, keys);
    }
  }
  return new Map([...order].map(([parentKey, keys]) => [parentKey, [...keys]]));
}
