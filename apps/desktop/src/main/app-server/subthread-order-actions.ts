import { buildThreadIdentityKey, isRemoteFederationTarget, resolveThreadParentKey } from "@pwragent/shared";
import type { NavigationThreadSummary, UpdateSubthreadOrderRequest, UpdateSubthreadOrderResponse } from "@pwragent/shared";
import { getDesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import { loadLocalNavigationQueryIndex } from "./navigation-query-source";
import { loadViewerNavigationPins } from "./navigation-viewer-pins";

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

/** What the owner needs to count a peer's threads into this machine's groups. */
export type PeerChildSource = {
  /** This machine's federation identity. Without one, no peer can link a child here. */
  localInstanceId: () => Promise<string | undefined>;
  /** The live peer summaries the sidebar reads its mounted peer threads through. */
  summaries: Parameters<typeof loadViewerNavigationPins>[1];
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
  let children: {
    backend: NavigationThreadSummary["source"];
    id: string;
    createdAt?: number;
    ownerInstanceId?: string;
  }[] | undefined;
  const store = getDesktopOverlayStore();
  if (relative) {
    // List only the providers with a stake in this group. A provider that
    // fails to list blocks the move, because a missing child would drop out
    // of the order; one with no row here must not block it.
    const scopes = [...new Set([backend, ...store.readSubthreadGroupBackends(request.parentThreadId)])];
    const indexes = await Promise.all(scopes.map((scope) =>
      loadLocalNavigationQueryIndex({ backend: scope, callerReason: "relative-child-move" })));
    if (indexes.some((index) => index.coverage && index.coverage.state !== "complete")) {
      throw new Error("Wait for complete owner discovery before moving a child.");
    }
    const local = indexes.flatMap((index, position) =>
      index.threads.filter((thread) => thread.source === scopes[position] && !thread.federation));
    if (!local.some((thread) => thread.source === backend && thread.id === request.parentThreadId
      && !thread.archivedAt)) throw new Error("The owning group no longer exists.");
    const byKey = new Map(local.map((thread) => [buildThreadIdentityKey(thread.source, thread.id), thread]));
    const parentKey = buildThreadIdentityKey(backend, request.parentThreadId);
    children = local.filter((thread) => thread.parentThreadId === request.parentThreadId
      && !thread.parentThreadInstanceId && !thread.archivedAt && !thread.codexNativeSubAgent
      && resolveThreadParentKey(thread, byKey) === parentKey)
      .map(({ source, id, createdAt }) => ({ backend: source, id, createdAt }));
    const localInstanceId = await options.peers?.localInstanceId();
    if (options.peers && localInstanceId) {
      for (const thread of await loadViewerNavigationPins(store, options.peers.summaries)) {
        const ref = thread.federation?.ref;
        if (!ref || !isRemoteFederationTarget(ref.target) || thread.federation?.derivedFromMountedParent
          || !isPeerChildOfLocalThread({ ownerInstanceId: ref.target.instanceId, summary: thread,
            parent: { backend, threadId: request.parentThreadId }, localInstanceId })) continue;
        children.push({ backend: ref.backend, id: ref.threadId, createdAt: thread.createdAt,
          ownerInstanceId: ref.target.instanceId });
      }
    }
  }
  const threadIds = await store.updateSubthreadOrder({
    backend,
    parentThreadId: request.parentThreadId,
    ...(request.move ? { move: request.move, children }
      : request.insertAfter ? { insertAfter: request.insertAfter, children } : { threadIds: request.threadIds }),
  });

  await getDesktopBackendRegistry().publishLocalEvent({
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
