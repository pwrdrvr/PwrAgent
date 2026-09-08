// Ordering policy for multi-path federation gateway endpoints. Endpoint
// selection is reachability only: every candidate is authenticated against
// the same pinned gateway signing key and Noise static key, so trying a
// different endpoint can never reach a different gateway identity.

/**
 * Attempt order for every startup and reconnect cycle follows Settings.
 * A successful fallback must never override the configured preference.
 */
export function orderFederationEndpointAttempts(
  endpoints: readonly string[],
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const endpoint of endpoints) {
    const trimmed = endpoint.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}
