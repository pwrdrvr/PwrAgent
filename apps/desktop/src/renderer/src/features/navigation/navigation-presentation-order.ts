import type { NavigationQueryEntry } from "@pwragent/shared";
import type { NavigationWindowQueriesState } from "../../lib/navigation-window-queries";
import { navigationThreadSelectionKey } from "../../lib/navigation-query-state";

export type NavigationPresentationEntry = {
  key: string;
  placement: NavigationQueryEntry["placement"];
  siblingOrder?: number;
};
export type NavigationPresentationOrder = ReadonlyMap<string, readonly NavigationPresentationEntry[]>;

/** Presentation metadata only: never a query page, cursor, generation or membership proof. */
export function readNavigationPresentationOrder(resources: NavigationWindowQueriesState["resources"]): NavigationPresentationOrder {
  return new Map([...resources].map(([id, resource]) => [id,
    (resource.state.page?.entries ?? []).map((entry) => ({ key: navigationThreadSelectionKey(entry.row.ref), placement: entry.placement,
      ...(entry.siblingOrder !== undefined ? { siblingOrder: entry.siblingOrder } : {}) })),
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
 * Each parent's child keys in its native owner's order. Exact metadata reads
 * retain sibling positions across batches; child pages supply the fallback.
 */
export function readOwnerChildOrder(
  resources: NavigationWindowQueriesState["resources"],
  presentation: NavigationPresentationOrder,
): Map<string, string[]> {
  const order = new Map<string, Set<string>>();
  const scopedParents = new Set([...resources.values()].flatMap(({ state: { request: { query } } }) =>
    query.kind === "children" && query.directoryKey !== undefined ? [navigationThreadSelectionKey(query.parent)] : []));
  const ranked = new Map<string, Map<string, number>>();
  for (const resource of resources.values()) {
    const request = resource.state.request;
    if (request.inventory !== "owner" || request.query.kind !== "exact") continue;
    const owner = request.federationTarget?.scope === "remote" ? request.federationTarget.instanceId : undefined;
    for (const entry of presentation.get(resource.id) ?? []) {
      if (entry.siblingOrder === undefined || entry.placement.kind !== "child"
        || entry.placement.parent.ownerInstanceId !== owner) continue;
      const parentKey = navigationThreadSelectionKey(entry.placement.parent);
      if (!scopedParents.has(parentKey)) continue;
      const children = ranked.get(parentKey) ?? new Map<string, number>();
      children.set(entry.key, entry.siblingOrder);
      ranked.set(parentKey, children);
    }
  }
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
  for (const [parentKey, children] of ranked) {
    const pageKeys = order.get(parentKey) ?? new Set<string>();
    const keys = [...pageKeys];
    const rankedChildren = [...children].sort(([, left], [, right]) => left - right);
    // An exact-only child has no page slot to preserve. Insert its slot at
    // the known sibling position, bounded by the currently loaded range.
    for (const [key, position] of rankedChildren) {
      if (!pageKeys.has(key)) keys.splice(Math.min(position, keys.length), 0, key);
    }
    const rankedKeys = rankedChildren.map(([key]) => key);
    let index = 0;
    // Exact reads can know only the selected child's position. Reorder the
    // known siblings within their existing slots; leave unknown siblings in
    // page order instead of promoting every child whose metadata arrives.
    order.set(parentKey, new Set(keys.map((key) => children.has(key) ? rankedKeys[index++]! : key)));
  }
  return new Map([...order].map(([parentKey, keys]) => [parentKey, [...keys]]));
}
