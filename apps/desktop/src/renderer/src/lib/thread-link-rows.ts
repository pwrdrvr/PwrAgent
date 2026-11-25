import {
  NAVIGATION_QUERY_PROTOCOL_VERSION,
  type NavigationRow,
  type NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import { type AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { type FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import type { DesktopApi } from "./desktop-api";

type Target = { backend: AppServerBackendKind; threadId: string; instanceId?: string };
type Api = Pick<DesktopApi, "getNavigationQueryPage" | "getNavigationSelectedDetail">;
export type ThreadLinkRow = (NavigationRow | NavigationThreadSummary) & { archiveIdentity?: "present" | "archived" };
type Entry = { expiresAt: number; promise: Promise<ThreadLinkRow | undefined> };
const caches = new WeakMap<Api, Map<string, Entry>>();
const legacyComposerCaches = new WeakMap<Api, Map<string, Entry>>();
const detailCaches = new WeakMap<Api, Map<string, Entry>>();
const MAX_ROWS = 256;
const MISSING_TTL_MS = 15_000;
const FACTS_TTL_MS = 30_000;

function rowKey(target: Target, owner: FederationRemoteTarget | undefined): string {
  return JSON.stringify([owner?.instanceId ?? null, target.backend, target.threadId]);
}

async function readOwnerDetail(
  api: Api,
  { backend, threadId }: Target,
  owner: FederationRemoteTarget | undefined,
): Promise<ThreadLinkRow | undefined> {
  if (!api.getNavigationSelectedDetail) return undefined;
  const detail = await api.getNavigationSelectedDetail({
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
    lookup: "thread-link",
    ref: { backend, threadId },
    ...(owner ? { federationTarget: owner } : {}),
  });
  if (detail.lookup === "thread-link" && detail.readiness === "ready"
    && detail.ref.backend === backend && detail.ref.threadId === threadId
    && detail.ref.ownerInstanceId === owner?.instanceId) {
    if (detail.identity === "unresolved" || detail.identity === "deleted") return undefined;
    if ((detail.identity === "archived" || detail.identity === "present")
      && detail.thread?.id === threadId && detail.thread.source === backend) {
      return { ...detail.thread, archiveIdentity: detail.identity };
    }
  }
  throw new Error("The thread's owner did not return its detail.");
}

/** New owner observations supersede both cached facts and reads still in flight. */
export function observeThreadLinkRows(
  api: Api,
  threads: readonly NavigationThreadSummary[],
  windowTarget: FederationRemoteTarget | undefined,
): void {
  const active = caches.get(api);
  const details = detailCaches.get(api);
  if (!active && !details) return;
  for (const thread of threads) {
    const target = thread.federation?.ref.target;
    const owner = target?.scope === "remote" ? target : windowTarget;
    const key = rowKey({ backend: thread.source, threadId: thread.id }, owner);
    // Do not duplicate the entire navigation inventory for transcript links.
    if (!active?.has(key) && !details?.has(key)) continue;
    const entry = { expiresAt: Date.now() + FACTS_TTL_MS, promise: Promise.resolve(thread) };
    if (active?.has(key)) active.set(key, entry);
    if (details?.has(key)) details.set(key, entry);
  }
}

function cacheRow(
  cacheByApi: WeakMap<Api, Map<string, Entry>>,
  api: Api,
  key: string,
  load: () => Promise<ThreadLinkRow | undefined>,
): Promise<ThreadLinkRow | undefined> {
  let cache = cacheByApi.get(api);
  if (!cache) {
    cache = new Map();
    cacheByApi.set(api, cache);
  }
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.promise;
  }
  const entry: Entry = { expiresAt: Infinity, promise: Promise.resolve(undefined) };
  const retained = cache;
  entry.promise = load().then((row) => {
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

/** Passive chip hydration reads the active index. Viewer rows can supply
 * last-known facts when a named owner is unavailable. */
export function readThreadLinkRow(
  api: Api,
  target: Target,
  windowTarget: FederationRemoteTarget | undefined,
): Promise<ThreadLinkRow | undefined> {
  const read = api.getNavigationQueryPage;
  if (!read) return Promise.resolve(undefined);
  const owner = target.instanceId ? { scope: "remote" as const, instanceId: target.instanceId } : windowTarget;
  return cacheRow(caches, api, rowKey(target, owner), async () => {
    try {
      const page = await read({
        protocol: NAVIGATION_QUERY_PROTOCOL_VERSION, inventory: "owner", consumer: "exact-link",
        ...(owner ? { federationTarget: owner } : {}), pageSize: 1,
        query: { kind: "exact", identities: [{ backend: target.backend, threadId: target.threadId }] },
      });
      const row = page.entries.find(({ row }) => row.id === target.threadId && row.source === target.backend
        && (!row.ref.ownerInstanceId || row.ref.ownerInstanceId === owner?.instanceId))?.row;
      if (!row && (!page.complete || page.coverage.state !== "complete")) {
        throw new Error("The thread's owner has not finished resolving its navigation rows.");
      }
      return row;
    } catch (error) {
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
    }
  });
}

/**
 * Older sidebar copies omitted the peer owner. Only a completed local miss
 * followed by one exact peer match can repair that old URL.
 */
export function readLegacyComposerThreadRow(
  api: Api & Pick<DesktopApi, "jumpSearchRemoteThreads">,
  target: Target,
): Promise<ThreadLinkRow | undefined> {
  const search = api.jumpSearchRemoteThreads;
  if (!api.getNavigationQueryPage || !search || target.instanceId) return Promise.resolve(undefined);
  return cacheRow(legacyComposerCaches, api, rowKey(target, undefined), async () => {
    const local = api.getNavigationSelectedDetail
      ? await readThreadInfoRow(api, target, undefined)
      : await readThreadLinkRow(api, target, undefined);
    if (local) return undefined;
    const limit = 50;
    const response = await search({ query: target.threadId, limit });
    if (response.incomplete || response.results.length >= limit) return undefined;
    const matches = response.results.filter((row) => row.id === target.threadId
      && row.source === target.backend && row.federation?.ref.target.scope === "remote");
    const owner = matches.length === 1 ? matches[0]?.federation?.ref.target : undefined;
    if (owner?.scope !== "remote") return undefined;
    return readThreadLinkRow(api, target, owner);
  });
}

/** Opening a card can resolve an archived identity omitted by the active page. */
export async function readThreadInfoRow(
  api: Api,
  target: Target,
  windowTarget: FederationRemoteTarget | undefined,
): Promise<ThreadLinkRow | undefined> {
  const row = await readThreadLinkRow(api, target, windowTarget);
  if (row) return row;
  const owner = target.instanceId ? { scope: "remote" as const, instanceId: target.instanceId } : windowTarget;
  return await cacheRow(detailCaches, api, rowKey(target, owner), () => readOwnerDetail(api, target, owner));
}
