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
