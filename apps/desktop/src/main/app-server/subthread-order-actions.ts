import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { isRemoteFederationTarget } from "@pwragent/shared/contracts/federation";
import { resolveThreadParentKey } from "@pwragent/shared/subthreads";
import type {
  NavigationThreadSummary,
  RemoteThreadPin,
  UpdateSubthreadOrderRequest,
  UpdateSubthreadOrderResponse,
} from "@pwragent/shared/contracts/navigation";
import { getDesktopBackendRegistry, type DesktopBackendRegistry } from "./backend-registry";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { getDesktopOverlayStore, type DesktopOwnerStorage } from "../storage/desktop-overlay-store";
import { archivedRemoteThreadPinMounts } from "./navigation-viewer-pins";
import type { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";
import { peerSubthreadKey } from "./thread-archive-sweeper";

/**
 * Whether a peer's thread names one of this machine's threads as its parent.
 * The peer stores that link and names this machine as the parent's owner, as
 * a sub-thread started here on that peer does. Sub-thread ordering and
 * archive promotion share this one definition of the group.
 */
export function isPeerChildOfLocalThread(params: {
  ownerInstanceId: string;
  summary: Pick<NavigationThreadSummary, "archivedAt" | "codexNativeSubAgent" | "parentThreadBackend"
    | "parentThreadId" | "parentThreadInstanceId" | "source">;
  parent: { backend: NavigationThreadSummary["source"]; threadId: string };
  localInstanceId: string;
}): boolean {
  const { summary } = params;
  return params.ownerInstanceId !== params.localInstanceId
    && summary.parentThreadId === params.parent.threadId
    && (summary.parentThreadBackend ?? summary.source) === params.parent.backend
    && summary.parentThreadInstanceId === params.localInstanceId
    && summary.archivedAt === undefined
    && summary.codexNativeSubAgent === undefined;
}

/**
 * Peer threads that are sub-threads of this machine's threads, by parent
 * identity key, from the pins this machine keeps of them. Child keys carry
 * the owner, so they never match a local thread and always count as left by
 * an archive here. The saved summary can trail its peer; that only keeps a
 * parent that might no longer need keeping.
 */
export function peerSubthreadChildren(
  pins: readonly Pick<RemoteThreadPin, "ref" | "summary" | "revokedAt">[],
  localInstanceId: string | undefined,
): Map<string, string[]> {
  const children = new Map<string, string[]>();
  if (!localInstanceId) return children;
  for (const { ref, summary, revokedAt } of pins) {
    if (!summary || revokedAt !== undefined || !isRemoteFederationTarget(ref.target)) continue;
    const parentId = summary.parentThreadId;
    if (!parentId) continue;
    const parent = { backend: summary.parentThreadBackend ?? summary.source, threadId: parentId };
    if (!isPeerChildOfLocalThread({ ownerInstanceId: ref.target.instanceId, summary, parent, localInstanceId })) continue;
    const key = buildThreadIdentityKey(parent.backend, parentId);
    const child = peerSubthreadKey(ref.target.instanceId, ref.backend, ref.threadId);
    const list = children.get(key) ?? [];
    if (!list.includes(child)) list.push(child);
    children.set(key, list);
  }
  return children;
}

/** What the owner needs to count a peer's threads into this machine's groups. */
export type PeerChildSource = {
  /** This machine's federation identity. Without one, no peer can link a child here. */
  localInstanceId: () => Promise<string | undefined>;
  /** The live peer summaries the sidebar reads its mounted peer threads through. */
  summaries: Pick<RemoteThreadSummaryCache, "readPinnedThreads">;
};

/**
 * Apply a sub-thread order change on the instance that owns the parent. The
 * desktop IPC handler and the federation owner both run this, so a peer
 * viewer's relative move is validated exactly like a local one.
 *
 * A parent's children can run on other providers (a Claude sub-thread under a
 * Codex parent), so the owner's child list covers every provider in the
 * group, and each entry carries its own backend for the store to validate
 * against. Membership uses the renderer's own resolver, so a legacy
 * cross-provider link that names only the parent id is a child here exactly
 * when the sidebar shows it as one.
 *
 * A peer's thread can be a child too (`isPeerChildOfLocalThread`). This
 * machine's pin of it is what places it here, and its link lives on the peer,
 * so a pin's saved snapshot can trail the peer. Membership therefore reads
 * pins the way the sidebar does: through the live peer summaries when the
 * peer is reachable, else the saved snapshot. That read never waits on a
 * peer, and it writes a pin only when its snapshot really changed.
 */
export async function updateLocalSubthreadOrder(
  request: Omit<UpdateSubthreadOrderRequest, "federationTarget">,
  options: { peers?: PeerChildSource } = {},
): Promise<UpdateSubthreadOrderResponse> {
  const backend = request.backend ?? "codex";
  const relative = Boolean(request.move || request.insertAfter);
  const store = getDesktopOverlayStore();
  const registry = getDesktopBackendRegistry();
  const target = { backend, parentThreadId: request.parentThreadId };
  const threadIds = relative
    ? await updateRelativeOrder(store, registry, target, request, options.peers)
    : await store.updateSubthreadOrder({ ...target, threadIds: request.threadIds });

  await registry.publishLocalEvent({
    backend,
    notification: {
      method: "thread/subthreadOrder/updated",
      params: {
        parentThreadId: request.parentThreadId,
        ...(relative ? {} : { threadIds }),
      },
    },
  });

  return { backend, parentThreadId: request.parentThreadId, ...(relative ? {} : { threadIds }) };
}

async function updateRelativeOrder(
  store: DesktopOwnerStorage,
  registry: DesktopBackendRegistry,
  target: { backend: NavigationThreadSummary["source"]; parentThreadId: string },
  request: Omit<UpdateSubthreadOrderRequest, "federationTarget">,
  peers: PeerChildSource | undefined,
): Promise<string[]> {
  const { backend, parentThreadId } = target;
  const group = store.readSubthreadGroup(backend, parentThreadId);
  let ownerChanged = false;
  const unsubscribe = registry.onEvent(({ backend: source, notification, federationTarget }) => {
    if (federationTarget?.scope === "remote") return;
    const { method, params } = notification;
    const id = method === "thread/started" ? params.threadId ?? (params.thread as { id?: unknown } | undefined)?.id
      : method === "thread/archived" || method === "thread/unarchived" || method === "thread/deleted"
        ? params.threadId : undefined;
    if (typeof id === "string" && group.scopes.get(source)?.has(id)) ownerChanged = true;
  });
  try {
    const assertComplete = () => {
      if (registry.getStartupProviderRefreshStatus()?.state === "checking") {
        throw new Error("Wait for complete owner discovery before moving a child.");
      }
    };
    assertComplete();
    // The old compatibility repair walks provider rows in listing order. A
    // single hop reads durable data either way, but a chain can observe an
    // earlier repair, so preserve canonical order for those providers.
    const orderedProviders = new Set<NavigationThreadSummary["source"]>();
    for (const row of group.overlays.values()) {
      if (!row.handoffSourceBackend || !row.handoffSourceThreadId || row.parentThreadId !== parentThreadId) continue;
      const origin = group.overlays.get(buildThreadIdentityKey(row.handoffSourceBackend, row.handoffSourceThreadId));
      if (origin?.parentThreadId === parentThreadId && origin.handoffSourceThreadId) {
        orderedProviders.add(row.handoffSourceBackend);
      }
    }
    const listings = await Promise.all([...group.scopes].map(async ([scope, ids]) => {
      const threads = await registry.readSubthreadOrderProviderRows(scope, ids, orderedProviders.has(scope));
      return threads.filter((thread) => thread.source === scope && ids.has(thread.id)
        && !group.managed.has(buildThreadIdentityKey(scope, thread.id)));
    }));
    const children = resolveLocalSubthreadOrderChildren(target, group, listings);
    const observedLocalKeys = new Set(listings.flatMap((listing) =>
      listing.map(({ source, id }) => buildThreadIdentityKey(source, id))));
    const localInstanceId = await peers?.localInstanceId();
    let peerPins: Parameters<DesktopOwnerStorage["commitSubthreadOrder"]>[0]["peerPins"];
    if (peers && localInstanceId) {
      const saved = store.readSubthreadOrderPeerPins();
      // Resolve and commit without yielding to a newer live cache publication.
      const resolved = peers.summaries.readPinnedThreads(saved.pins);
      peerPins = { fingerprint: saved.fingerprint, archived: archivedRemoteThreadPinMounts(saved.pins, resolved.archived),
        refreshed: resolved.refreshed };
      for (const thread of resolved.threads) {
        const ref = thread.federation?.ref;
        if (!ref || !isRemoteFederationTarget(ref.target) || thread.federation?.derivedFromMountedParent
          || !isPeerChildOfLocalThread({ ownerInstanceId: ref.target.instanceId, summary: thread,
            parent: { backend, threadId: parentThreadId }, localInstanceId })) continue;
        children.push({ backend: ref.backend, id: ref.threadId, createdAt: thread.createdAt,
          ownerInstanceId: ref.target.instanceId });
      }
    }
    assertComplete();
    if (ownerChanged) throw new Error("The owning group changed while discovering its children. Try the move again.");
    return store.commitSubthreadOrder({
      ...target, children, groupFingerprint: group.fingerprint, observedLocalKeys, peerPins,
      ...(request.move ? { move: request.move } : { insertAfter: request.insertAfter }),
    });
  } finally {
    unsubscribe();
  }
}

function resolveLocalSubthreadOrderChildren(
  { backend, parentThreadId }: { backend: NavigationThreadSummary["source"]; parentThreadId: string },
  group: ReturnType<DesktopOwnerStorage["readSubthreadGroup"]>,
  listings: AppServerThreadSummary[][],
): Array<{ backend: NavigationThreadSummary["source"]; id: string; createdAt?: number; ownerInstanceId?: string }> {
  const local = listings.flatMap((listing) => {
    const byKey = new Map(listing.map(({ source, id, createdAt, archivedAt, codexNativeSubAgent }) => {
      const key = buildThreadIdentityKey(source, id);
      const row = group.overlays.get(key);
      return [key, { source, id, createdAt, archivedAt, codexNativeSubAgent,
        parentThreadId: row?.parentThreadId ?? undefined,
        parentThreadBackend: row?.parentThreadBackend ?? undefined,
        parentThreadInstanceId: row?.parentThreadInstanceId ?? undefined }];
    }));
    // Match the sidebar's ordered compatibility repair for a handoff that
    // lost its remote parent owner. Any origin with the same parent ID is
    // already a candidate. It must be listed on this provider, and a real
    // local parent wins.
    for (const [key, thread] of byKey) {
      const row = group.overlays.get(key);
      if (thread.parentThreadId !== parentThreadId || thread.parentThreadInstanceId
        || !row?.handoffSourceBackend || !row.handoffSourceThreadId) continue;
      const parentBackend = thread.parentThreadBackend ?? thread.source;
      if (byKey.has(buildThreadIdentityKey(parentBackend, parentThreadId))) continue;
      const origin = byKey.get(buildThreadIdentityKey(row.handoffSourceBackend, row.handoffSourceThreadId));
      if (origin?.parentThreadInstanceId && origin.parentThreadId === parentThreadId
        && (origin.parentThreadBackend ?? origin.source) === parentBackend) {
        thread.parentThreadInstanceId = origin.parentThreadInstanceId;
      }
    }
    return [...byKey.values()];
  });
  const byKey = new Map(local.map((thread) => [buildThreadIdentityKey(thread.source, thread.id), thread]));
  const parentKey = buildThreadIdentityKey(backend, parentThreadId);
  const parent = byKey.get(parentKey);
  if (!parent || parent.archivedAt) throw new Error("The owning group no longer exists.");
  // Only same-ID roots affect the legacy fallback. Passing just those
  // identities keeps resolution independent of unrelated rows and siblings.
  const parents = new Map([...byKey].filter(([, thread]) => thread.id === parentThreadId));
  return local.filter((thread) => thread.parentThreadId === parentThreadId
    && !thread.parentThreadInstanceId && !thread.archivedAt && !thread.codexNativeSubAgent
    && resolveThreadParentKey(thread, parents) === parentKey)
    .map(({ source, id, createdAt }) => ({ backend: source, id, createdAt }));
}
