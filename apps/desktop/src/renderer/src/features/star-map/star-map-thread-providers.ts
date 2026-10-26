import type {
  AppServerBackendKind,
  NavigationCounts,
  NavigationThreadSummary,
} from "@pwragent/shared";

/**
 * The providers that own threads across every instance on the map, for the
 * provider-chip rule in `provider-chip-visibility`. Each instance's whole-map
 * page reports its own list. An instance that has not answered yet adds the
 * providers of whatever cards it already has on the map. An instance that
 * answers without a list predates it, so the result is unknown and the chips
 * stay on.
 */
export function starMapThreadProviders(params: {
  instanceCounts: Iterable<NavigationCounts | undefined>;
  threads: Iterable<Pick<NavigationThreadSummary, "source">>;
}): AppServerBackendKind[] | undefined {
  const providers = new Set<AppServerBackendKind>();
  for (const counts of params.instanceCounts) {
    if (!counts) continue;
    if (!counts.backends) return undefined;
    for (const backend of counts.backends) providers.add(backend);
  }
  for (const thread of params.threads) providers.add(thread.source);
  return [...providers].sort();
}
