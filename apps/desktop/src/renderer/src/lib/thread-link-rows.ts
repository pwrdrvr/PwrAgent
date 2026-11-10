import { NAVIGATION_QUERY_PROTOCOL_VERSION, type AppServerBackendKind,
  type FederationRemoteTarget, type NavigationRow, type NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

type Target = { backend: AppServerBackendKind; threadId: string; instanceId?: string };
type Api = Pick<DesktopApi, "getNavigationQueryPage">;
export type ThreadLinkRow = NavigationRow | NavigationThreadSummary;
type Entry = { expiresAt: number; promise: Promise<ThreadLinkRow | undefined> };
const caches = new WeakMap<Api, Map<string, Entry>>();
const MAX_ROWS = 256;
const MISSING_TTL_MS = 15_000;
const FACTS_TTL_MS = 30_000;

function rowKey(target: Target, owner: FederationRemoteTarget | undefined): string {
  return JSON.stringify([owner?.instanceId ?? null, target.backend, target.threadId]);
}

/** New owner observations supersede both cached facts and reads still in flight. */
export function observeThreadLinkRows(
  api: Api,
  threads: readonly NavigationThreadSummary[],
  windowTarget: FederationRemoteTarget | undefined,
): void {
  const cache = caches.get(api);
  if (!cache) return;
  for (const thread of threads) {
    const target = thread.federation?.ref.target;
    const owner = target?.scope === "remote" ? target : windowTarget;
    const key = rowKey({ backend: thread.source, threadId: thread.id }, owner);
    // Do not duplicate the entire navigation inventory for transcript links.
    if (cache.has(key)) cache.set(key, { expiresAt: Date.now() + FACTS_TTL_MS, promise: Promise.resolve(thread) });
  }
}

/**
 * One owner read for an encountered link, shared by chips and hover cards.
 * Mutable facts refresh only on demand after 30 seconds. A failed owner
 * read can use this viewer's last-known rows; an empty viewer cache cannot
 * establish absence. Chip names remain in the separate metadata store.
 */
export function readThreadLinkRow(
  api: Api,
  target: Target,
  windowTarget: FederationRemoteTarget | undefined,
): Promise<ThreadLinkRow | undefined> {
  if (!api.getNavigationQueryPage) return Promise.resolve(undefined);
  const owner = target.instanceId ? { scope: "remote" as const, instanceId: target.instanceId } : windowTarget;
  const key = rowKey(target, owner);
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
  const read = api.getNavigationQueryPage;
  entry.promise = read({
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION, inventory: "owner", consumer: "exact-link",
    ...(owner ? { federationTarget: owner } : {}), pageSize: 1,
    query: { kind: "exact", identities: [{ backend: target.backend, threadId: target.threadId }] },
  }).then((page) => {
    const row = page.entries.find(({ row }) => row.id === target.threadId && row.source === target.backend
      && (!row.ref.ownerInstanceId || row.ref.ownerInstanceId === owner?.instanceId))?.row;
    if (!row && (!page.complete || page.coverage.state !== "complete")) {
      throw new Error("The thread's owner has not finished resolving its navigation rows.");
    }
    return row;
  }).catch(async (error: unknown) => {
    if (owner) {
      try {
        const page = await read({
          protocol: NAVIGATION_QUERY_PROTOCOL_VERSION, inventory: "viewer", consumer: "exact-link", pageSize: 1,
          query: { kind: "exact", resolveFromOwners: true,
            identities: [{ backend: target.backend, threadId: target.threadId, ownerInstanceId: owner.instanceId }] },
        });
        const row = page.entries.find(({ row }) => row.id === target.threadId && row.source === target.backend
          && row.ref.ownerInstanceId === owner.instanceId)?.row;
        if (row) return row;
      } catch {
        // Preserve the failed owner read when the local fallback also fails.
      }
    }
    throw error;
  }).then((row) => {
    const observed = retained.get(key);
    if (observed && observed !== entry) return observed.promise;
    entry.expiresAt = Date.now() + (row ? FACTS_TTL_MS : MISSING_TTL_MS);
    return row;
  }, (error: unknown) => {
    const observed = retained.get(key);
    if (observed && observed !== entry) return observed.promise;
    if (retained.get(key) === entry) retained.delete(key);
    throw error;
  });
  cache.set(key, entry);
  while (cache.size > MAX_ROWS) cache.delete(cache.keys().next().value!);
  return entry.promise;
}
