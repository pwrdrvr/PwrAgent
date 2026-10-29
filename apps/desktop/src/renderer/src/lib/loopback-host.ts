/**
 * Hosts that stay on this machine, the only places the app opens plain
 * `http:` links. Mirrors `isLoopbackHost` in main's `external-url-policy.ts`,
 * which makes the final decision; the renderer checks first only so it never
 * offers a link that main would refuse.
 */
export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized.endsWith(".localhost")
  );
}
