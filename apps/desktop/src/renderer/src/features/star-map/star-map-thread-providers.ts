import {
  threadProviderIdentity,
  type NavigationCounts,
  type NavigationThreadSummary,
} from "@pwragent/shared";

/**
 * The providers that own threads across every instance on the map, for the
 * provider-chip rule in `provider-chip-visibility`. Each instance's whole-map
 * page reports its own list: provider identities, or backend kinds from an
 * instance that predates them. An instance that has not answered yet adds
 * the providers of whatever cards it already has on the map. An instance
 * that answers without a list predates it, so the result is unknown and the
 * chips stay on.
 */
export function starMapThreadProviders(params: {
  instanceCounts: Iterable<NavigationCounts | undefined>;
  threads: Iterable<Pick<NavigationThreadSummary, "source" | "model">>;
}): string[] | undefined {
  const providers = new Set<string>();
  for (const counts of params.instanceCounts) {
    if (!counts) continue;
    const listed = counts.providers ?? counts.backends;
    if (!listed) return undefined;
    for (const provider of listed) providers.add(provider);
  }
  for (const thread of params.threads) providers.add(threadProviderIdentity(thread.source, thread.model));
  return [...providers].sort();
}
