import { useCallback, useEffect, useRef, useState } from "react";
import type { FederationTarget, FederationPeerSummary, NavigationIdentity, NavigationDetailCollections, NavigationDetailCollectionName, NavigationSelectedDetailResponse } from "@pwragent/shared";
import { buildPullRequestStatusKey, NAVIGATION_DETAIL_COLLECTION_NAMES } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { applyNavigationThreadEvent } from "./navigation-thread-event";
import { navigationQueryEventRequiresRefresh } from "./navigation-query-events";
import {
  applyNavigationSelectedDetail,
  navigationIdentityKey,
  selectNavigationIdentity,
  type NavigationSelectionState,
} from "./navigation-query-state";

let nextDetailConsumer = 0;

// Compare a canonical streamed collection with the owner's manifest before
// downloading the same historical records again.
async function collectionRevision(ref: NavigationIdentity, name: NavigationDetailCollectionName, values: unknown[]): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify({ ref: { backend: ref.backend, threadId: ref.threadId }, name, values }));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A row can select a thread; only this exact read can authorize its composer. */
export function useNavigationSelectedDetail(params: {
  desktopApi?: DesktopApi;
  ref?: NavigationIdentity;
  federationTarget?: FederationTarget;
  enabled?: boolean;
}): {
  state?: NavigationSelectionState;
  refresh: () => Promise<void>;
} {
  const { desktopApi, ref, federationTarget } = params;
  const identityKey = ref ? navigationIdentityKey(ref) : undefined;
  const targetKey = JSON.stringify(federationTarget);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const currentRef = useRef<NavigationSelectionState | undefined>(undefined);
  // Keep the owner response separate from event-patched presentation state.
  // An unchanged response may revalidate only this exact canonical baseline.
  const canonicalRef = useRef<{ identity: string; detail: NavigationSelectedDetailResponse } | undefined>(undefined);
  const pullRequestKeysRef = useRef(new Set<string>());
  const sequenceRef = useRef(0);
  const consumerRef = useRef<string | undefined>(undefined);
  if (!consumerRef.current) consumerRef.current = `selected-detail:${++nextDetailConsumer}`;
  const connectionRef = useRef<{ owner: string; status: string } | undefined>(undefined);
  const collectionsRef = useRef<{ identity?: string; values: NavigationDetailCollections; revisions: Map<NavigationDetailCollectionName, string> }>({ values: {}, revisions: new Map() });
  const collectionConsumersRef = useRef(new Set<string>());
  const collectionPagesRef = useRef(new Map<NavigationDetailCollectionName, {
    revision: string; values: unknown[]; cursor?: string; complete: boolean; pending?: Promise<void>;
  }>());
  const [state, setState] = useState<NavigationSelectionState>();
  const refresh = useCallback(async () => {
    const currentParams = paramsRef.current;
    const selectedRef = currentParams.ref;
    if (!selectedRef || currentParams.enabled === false) return;
    const owner = currentParams.federationTarget?.scope === "remote" ? currentParams.federationTarget.instanceId : selectedRef.ownerInstanceId;
    if (owner && connectionRef.current?.owner === owner && connectionRef.current.status !== "connected") return;
    const sequence = ++sequenceRef.current;
    const started = {
      ...selectNavigationIdentity(currentRef.current, selectedRef),
      pendingSequence: sequence,
    };
    currentRef.current = started;
    setState(started);
    try {
      if (!desktopApi?.getNavigationSelectedDetail) {
        throw new Error("Desktop bridge is missing selected-thread detail support. Upgrade this instance.");
      }
      const canonicalIdentity = JSON.stringify([selectedRef, currentParams.federationTarget]);
      const canonical = canonicalRef.current?.identity === canonicalIdentity ? canonicalRef.current.detail : undefined;
      const detail = await desktopApi.getNavigationSelectedDetail({
        protocol: 2,
        ref: selectedRef,
        federationTarget: currentParams.federationTarget,
        includeWorkspaceConfiguration: true,
        knownRevision: canonical?.revision,
      }, consumerRef.current);
      if (sequenceRef.current !== sequence) return;
      const next = applyNavigationSelectedDetail({
        state: detail.unchanged && canonical ? { ...started, detail: canonical, stale: false } : started,
        sequence,
        detail,
      });
      if (next.detail) canonicalRef.current = { identity: canonicalIdentity, detail: next.detail };
      const collectionIdentity = JSON.stringify([selectedRef, currentParams.federationTarget]);
      if (collectionsRef.current.identity !== collectionIdentity) {
        collectionsRef.current = { identity: collectionIdentity, values: {}, revisions: new Map() };
        collectionPagesRef.current.clear();
      }
      if (next.detail?.thread) next.detail = { ...next.detail, thread: { ...next.detail.thread, ...collectionsRef.current.values } };
      pullRequestKeysRef.current = new Set(next.detail?.thread?.prs?.map(buildPullRequestStatusKey));
      currentRef.current = next;
      setState(next);
      // Configuration is usable now. Historical collections have a separate
      // lease/readiness and may finish after the operator starts composing.
      if (detail.collections?.length && next.detail?.thread) {
        const token = `${consumerRef.current}:collections:${sequence}`;
        collectionConsumersRef.current.add(token);
        const publish = (patch: Partial<NavigationSelectionState>) => {
          if (sequenceRef.current !== sequence || !currentRef.current) return;
          currentRef.current = { ...currentRef.current, ...patch };
          setState(currentRef.current);
        };
        publish({ collectionReadiness: "loading", collectionError: undefined });
        try {
          for (const manifest of detail.collections) {
            if (collectionsRef.current.revisions.get(manifest.name) === manifest.revision) continue;
            const cached = collectionsRef.current.values[manifest.name];
            if (cached && await collectionRevision(detail.ref, manifest.name, cached) === manifest.revision) {
              if (sequenceRef.current !== sequence) return;
              collectionsRef.current.revisions.set(manifest.name, manifest.revision);
              continue;
            }
            if (sequenceRef.current !== sequence) return;
            let pages = collectionPagesRef.current.get(manifest.name);
            if (!pages || pages.revision !== manifest.revision) {
              pages = { revision: manifest.revision, values: [], complete: !manifest.count };
              collectionPagesRef.current.set(manifest.name, pages);
            }
            const retainedPages = pages;
            while (!retainedPages.complete) {
              // Collection revisions, not configuration invalidations, own
              // these pages. Share in-flight work and retain completed pages.
              if (!retainedPages.pending) {
                const cursor = retainedPages.cursor;
                retainedPages.pending = desktopApi.getNavigationSelectedDetail({ protocol: 2, ref: selectedRef,
                  federationTarget: currentParams.federationTarget, collection: { name: manifest.name, cursor } }, token).then((response) => {
                  const page = response.collectionPage;
                  if (!page || page.name !== manifest.name || page.revision !== manifest.revision
                    || page.complete === Boolean(page.nextCursor) || (cursor && cursor === page.nextCursor)) {
                    throw new Error("Selected history collection changed while loading. Refresh this thread to reload its history metadata.");
                  }
                  const values = [...retainedPages.values, ...(page.values[manifest.name] ?? [])];
                  if (new TextEncoder().encode(JSON.stringify({ ...collectionsRef.current.values, [manifest.name]: values })).byteLength > 8 * 1024 * 1024) {
                    throw new Error("Selected history metadata exceeds its retained budget.");
                  }
                  retainedPages.values = values;
                  retainedPages.cursor = page.nextCursor;
                  retainedPages.complete = page.complete;
                }).finally(() => { retainedPages.pending = undefined; });
              }
              await retainedPages.pending;
              if (sequenceRef.current !== sequence) return;
            }
            if (sequenceRef.current !== sequence) return;
            collectionsRef.current.values = { ...collectionsRef.current.values, [manifest.name]: retainedPages.values };
            collectionsRef.current.revisions.set(manifest.name, manifest.revision);
            collectionPagesRef.current.delete(manifest.name);
            const current = currentRef.current!;
            publish({ detail: { ...current.detail!, thread: { ...current.detail!.thread!, ...collectionsRef.current.values } } });
          }
          publish({ collectionReadiness: "ready" });
        } catch (error) {
          publish({ collectionReadiness: "failed", collectionError: error instanceof Error ? error.message : String(error) });
        } finally {
          collectionConsumersRef.current.delete(token);
          void desktopApi.releaseNavigationQuery?.(token).catch(() => undefined);
        }
      }
    } catch (error) {
      if (sequenceRef.current !== sequence) return;
      const next: NavigationSelectionState = {
        ...started,
        readiness: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      currentRef.current = next;
      setState(next);
    }
  }, [desktopApi]);

  useEffect(() => {
    const currentParams = paramsRef.current;
    const owner = currentParams.federationTarget?.scope === "remote" ? currentParams.federationTarget.instanceId : currentParams.ref?.ownerInstanceId;
    if (connectionRef.current?.owner !== owner) connectionRef.current = undefined;
    if (params.enabled === false) {
      const current = currentRef.current;
      if (current) {
        const next: NavigationSelectionState = { ...current, readiness: "loading", stale: true };
        currentRef.current = next;
        setState(next);
      }
    } else if (paramsRef.current.ref) void refresh();
    else {
      currentRef.current = undefined;
      setState(undefined);
    }
    return () => {
      sequenceRef.current += 1;
      void desktopApi?.releaseNavigationQuery?.(consumerRef.current!).catch(() => {});
      for (const token of collectionConsumersRef.current) void desktopApi?.releaseNavigationQuery?.(token).catch(() => undefined);
      collectionConsumersRef.current.clear();
      collectionPagesRef.current.clear();
      consumerRef.current = `selected-detail:${++nextDetailConsumer}`;
    };
  }, [identityKey, refresh, targetKey, params.enabled]);
  useEffect(() => {
    if (!identityKey || !desktopApi?.getNavigationSelectedDetail) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = desktopApi.onAgentEvent?.((event) => {
      const selected = paramsRef.current.ref;
      const target = paramsRef.current.federationTarget;
      const eventOwner = event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId : undefined;
      const selectedOwner = target?.scope === "remote" ? target.instanceId : selected?.ownerInstanceId;
      const notification = event.notification;
      if (notification.method === "federation/peerStatus/changed") {
        const peer = notification.params as { instanceId: string; status: string };
        if (!selectedOwner || peer.instanceId !== selectedOwner) return;
        if (connectionRef.current?.owner === selectedOwner && connectionRef.current.status === peer.status) return;
        connectionRef.current = { owner: selectedOwner, status: peer.status };
        canonicalRef.current = undefined;
        const sequence = ++sequenceRef.current;
        const current = currentRef.current;
        if (current) {
          const next: NavigationSelectionState = { ...current, pendingSequence: sequence, stale: true,
            readiness: peer.status === "connected" ? "loading" : "failed",
            error: peer.status === "connected" ? undefined : "The owning instance is disconnected. Reconnect before using thread actions.",
            detail: current.detail?.thread?.federation ? { ...current.detail, thread: { ...current.detail.thread,
              federation: { ...current.detail.thread.federation, peerStatus: peer.status as FederationPeerSummary["status"] } } } : current.detail };
          currentRef.current = next;
          setState(next);
        }
        if (timer !== undefined) clearTimeout(timer);
        timer = peer.status === "connected" ? setTimeout(() => { timer = undefined; void refresh(); }, 250) : undefined;
        return;
      }
      if (!selected || eventOwner !== selectedOwner) return;
      if (notification.method === "pullRequest/status/updated"
        && (typeof notification.params.prKey !== "string" || !pullRequestKeysRef.current.has(notification.params.prKey))) return;
      const currentThread = currentRef.current?.detail?.thread;
      const patchedThread = currentThread ? applyNavigationThreadEvent(currentThread, event) : undefined;
      if (patchedThread && notification.method === "thread/pullRequests/updated") {
        pullRequestKeysRef.current = new Set(patchedThread.prs?.map(buildPullRequestStatusKey));
      }
      const exactThreadEvent = event.backend === selected.backend
        && (("threadId" in notification.params && notification.params.threadId === selected.threadId)
          || ("parentThreadId" in notification.params && notification.params.parentThreadId === selected.threadId)
          || (notification.method === "navigation/threadDirectories/updated"
            && Array.isArray(notification.params.threadIds) && notification.params.threadIds.includes(selected.threadId)));
      // Main-process owner-wide invalidations cancel all exact reads on that
      // owner. Admit the same event here so a cancelled read gets a coalesced
      // replacement instead of leaving its composer permanently unavailable.
      const ownerWideEvent = !("threadId" in notification.params)
        && !("parentThreadId" in notification.params)
        && !("thread" in notification.params && notification.params.thread
          && typeof notification.params.thread === "object" && "id" in notification.params.thread);
      if (!exactThreadEvent && !ownerWideEvent && patchedThread === currentThread) return;
      if (!navigationQueryEventRequiresRefresh(notification.method)
        && notification.method !== "thread/codexEnvironment/updated"
        && notification.method !== "thread/acpRuntime/updated") return;
      // A canonical event supersedes the retained collection too. Otherwise
      // the configuration read overlays its older cache and briefly erases
      // live accounting while replacement history pages are still loading.
      if (patchedThread && currentThread) {
        for (const name of NAVIGATION_DETAIL_COLLECTION_NAMES) {
          if (patchedThread[name] === currentThread[name]) continue;
          collectionsRef.current.values = { ...collectionsRef.current.values, [name]: patchedThread[name] };
          collectionsRef.current.revisions.delete(name);
          collectionPagesRef.current.delete(name);
        }
      }
      // Fence an already-running read at event admission, not when the coalesced
      // refresh eventually starts. Its revision no longer describes this detail.
      const sequence = ++sequenceRef.current;
      const current = currentRef.current;
      if (current) {
        const next: NavigationSelectionState = { ...current, pendingSequence: sequence, readiness: "loading", stale: true,
          detail: current.detail?.thread ? { ...current.detail,
            thread: patchedThread ?? current.detail.thread } : current.detail };
        currentRef.current = next;
        setState(next);
      }
      if (timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 250);
    });
    const unsubscribeBindings = desktopApi.onMessagingBindingsChanged?.(() => {
      const sequence = ++sequenceRef.current;
      const current = currentRef.current;
      if (current) {
        const next: NavigationSelectionState = { ...current, pendingSequence: sequence, readiness: "loading", stale: true };
        currentRef.current = next;
        setState(next);
      }
      if (timer === undefined) timer = setTimeout(() => { timer = undefined; void refresh(); }, 250);
    });
    return () => { if (timer !== undefined) clearTimeout(timer); unsubscribe?.(); unsubscribeBindings?.(); };
  }, [desktopApi, identityKey, refresh, targetKey]);
  // A render for a new owner must never expose the previous owner's ready configuration.
  const visibleState = state && identityKey === navigationIdentityKey(state.ref) ? state : undefined;
  return { state: visibleState, refresh };
}
