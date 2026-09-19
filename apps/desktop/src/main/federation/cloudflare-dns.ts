/**
 * Whether a request failed because its host name did not resolve on this
 * computer. Node's `https` reports the code on the error itself; `fetch` wraps
 * it in `cause`.
 */
export function isUnresolvedHost(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A new endpoint name that does not resolve yet, said as such.
 *
 * A name looked up before it existed — by the operator checking it was free,
 * or by an earlier failed attempt — can be cached as not found for the zone's
 * negative TTL, 30 minutes on Cloudflare's default SOA. Reporting that as a
 * missing feature sends the operator after a setting that is fine.
 */
export function unresolvedHostMessage(host: string): string {
  return `${host} does not resolve on this computer yet. A new name can take a few minutes to appear, `
    + "and a lookup made before it existed can be cached as not found for up to 30 minutes. Try again shortly.";
}
