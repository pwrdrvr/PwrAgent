// Ordering policy for multi-path federation gateway endpoints. Endpoint
// selection is reachability only: every candidate is authenticated against
// the same pinned gateway signing key and Noise static key, so trying a
// different endpoint can never reach a different gateway identity.

/**
 * Attempt order for one reconnect cycle: the last endpoint that carried a
 * fully authenticated session first (when it is still configured), then the
 * remaining endpoints in configured order.
 */
export function orderFederationEndpointAttempts(
  endpoints: readonly string[],
  lastGoodEndpoint?: string,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const endpoint of endpoints) {
    const trimmed = endpoint.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  const lastGood = lastGoodEndpoint?.trim();
  if (!lastGood || !seen.has(lastGood)) {
    return ordered;
  }
  return [lastGood, ...ordered.filter((endpoint) => endpoint !== lastGood)];
}
