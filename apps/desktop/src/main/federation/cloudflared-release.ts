/**
 * Whether a newer cloudflared exists than the one installed.
 *
 * PwrAgent runs the connector with `--no-autoupdate`, and a package-managed
 * install never updates itself either, so without this nothing tells the
 * operator their connector is falling behind; Cloudflare's own dashboard does,
 * but only for someone already looking at it. The latest version comes from
 * the project's GitHub release record. A failed lookup reports nothing rather
 * than a guess, and is retried after an hour, not on every status read.
 */
export const CLOUDFLARED_LATEST_RELEASE_URL =
  "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";

const CHECK_TTL_MS = 24 * 60 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
const VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,4})$/;

/** cloudflared's calendar versions (`2026.8.3`), compared numerically; undefined when either is not one. */
export function compareCloudflaredVersions(a: string, b: string): number | undefined {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) return undefined;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function createCloudflaredReleaseCheck(options: {
  fetch?: typeof fetch;
  now?: () => number;
} = {}): () => Promise<string | undefined> {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { at: number; ttl: number; version?: string } | undefined;
  let pending: Promise<string | undefined> | undefined;
  return async () => {
    if (cached && now() - cached.at < cached.ttl) return cached.version;
    pending ??= (async () => {
      let version: string | undefined;
      try {
        const response = await fetcher(CLOUDFLARED_LATEST_RELEASE_URL, {
          headers: { Accept: "application/vnd.github+json" },
          redirect: "error",
          signal: AbortSignal.timeout(4_000),
        });
        if (response.ok) {
          const body = await response.json() as { tag_name?: unknown };
          const tag = typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : "";
          version = VERSION.test(tag) ? tag : undefined;
        }
      } catch { /* Offline or throttled: report nothing. */ }
      cached = { at: now(), ttl: version ? CHECK_TTL_MS : RETRY_AFTER_FAILURE_MS, version };
      return version;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
