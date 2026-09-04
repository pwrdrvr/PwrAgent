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

/**
 * Upper bound on the effective client dial list. Operator-configured entries
 * are never dropped to satisfy it — a cap that silently ignores what someone
 * typed into Settings is its own bug — so it bounds only how many
 * gateway-learned candidates ride along behind them.
 */
const MAX_CLIENT_ENDPOINTS = 8;

/**
 * The endpoints a client should actually dial: what the operator configured,
 * plus what the gateway told us about itself on its last accepted connection.
 *
 * The two sources stay in two stores on purpose. `federation.gatewayEndpoints`
 * in config.toml is the operator's declaration and is never rewritten by a
 * connect — partly so hand-edited config keeps meaning what it says, but
 * mostly because *any* write to the `federation` config section restarts the
 * federation runtime. Learning an endpoint by writing it back to config would
 * therefore tear down the session that just taught it to us, and a list that
 * did not converge would restart the runtime on every reconnect forever. The
 * learned list is a cache in the state database instead, replaced wholesale
 * each time the gateway describes itself, which is also what prunes an
 * endpoint the gateway has stopped advertising — a DHCP literal it no longer
 * holds, or a tailnet name from before its listener moved off the wildcard.
 * Each stale candidate costs a full connect timeout on every reconnect cycle,
 * so pruning them is not cosmetic.
 *
 * Configured entries come first. Cold-start order is all this decides, since
 * `orderFederationEndpointAttempts` promotes the last-good endpoint anyway,
 * and on a cold start the operator's explicit choice is the better guess.
 */
export function resolveFederationClientEndpoints(params: {
  /** `federation.gatewayEndpoints` — the operator's declaration. */
  configured: readonly string[];
  /** Endpoints the gateway advertised on its last accepted connection. */
  learned: readonly string[];
}): string[] {
  const seen = new Set<string>();
  const endpoints: string[] = [];
  for (const endpoint of params.configured) {
    const trimmed = endpoint.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push(trimmed);
  }
  for (const endpoint of params.learned) {
    // Checked before the push, so a configured list that already fills or
    // exceeds the cap admits no learned candidates at all.
    if (endpoints.length >= MAX_CLIENT_ENDPOINTS) break;
    const trimmed = endpoint.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push(trimmed);
  }
  return endpoints;
}
