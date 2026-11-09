import { NAVIGATION_QUERY_PROTOCOL_VERSION, type AppServerBackendKind,
  type FederationRemoteTarget, type NavigationRow } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

type Target = { backend: AppServerBackendKind; threadId: string; instanceId?: string };
type Api = Pick<DesktopApi, "getNavigationQueryPage">;
type Entry = { expiresAt: number; promise: Promise<NavigationRow | undefined> };
const caches = new WeakMap<Api, Map<string, Entry>>();
const MAX_ROWS = 256;
const MISSING_TTL_MS = 15_000;

/**
 * One owner read for an encountered link, shared by chips and hover cards.
 * Names tolerate staleness; misses expire and failed reads remain retryable.
 * This adds no pin, background watch, subscription, or persistent state.
 */
export function readThreadLinkRow(
  api: Api,
  target: Target,
  windowTarget: FederationRemoteTarget | undefined,
): Promise<NavigationRow | undefined> {
  if (!api.getNavigationQueryPage) return Promise.resolve(undefined);
  const owner = target.instanceId ? { scope: "remote" as const, instanceId: target.instanceId } : windowTarget;
  const key = JSON.stringify([owner?.instanceId ?? null, target.backend, target.threadId]);
  let cache = caches.get(api);
  if (!cache) {
    cache = new Map();
    caches.set(api, cache);
  }
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.promise;
  }
  const entry: Entry = { expiresAt: Infinity, promise: Promise.resolve(undefined) };
  const retained = cache;
  entry.promise = api.getNavigationQueryPage({
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION, inventory: "owner", consumer: "exact-link",
    ...(owner ? { federationTarget: owner } : {}), pageSize: 1,
    query: { kind: "exact", identities: [{ backend: target.backend, threadId: target.threadId }] },
  }).then((page) => {
    const row = page.entries.find(({ row }) => row.id === target.threadId && row.source === target.backend
      && (!row.ref.ownerInstanceId || row.ref.ownerInstanceId === owner?.instanceId))?.row;
    if (!row && (!page.complete || page.coverage.state !== "complete")) {
      throw new Error("The thread's owner has not finished resolving its navigation rows.");
    }
    entry.expiresAt = row ? Infinity : Date.now() + MISSING_TTL_MS;
    return row;
  }).catch((error: unknown) => {
    if (retained.get(key) === entry) retained.delete(key);
    throw error;
  });
  cache.set(key, entry);
  while (cache.size > MAX_ROWS) cache.delete(cache.keys().next().value!);
  return entry.promise;
}
