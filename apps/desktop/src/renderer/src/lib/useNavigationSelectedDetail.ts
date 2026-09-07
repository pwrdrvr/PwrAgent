import { useCallback, useEffect, useRef, useState } from "react";
import type { FederationTarget, FederationPeerSummary, NavigationIdentity } from "@pwragent/shared";
import { buildPullRequestStatusKey } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { applyNavigationThreadEvent } from "./navigation-thread-event";
import { navigationQueryEventRequiresRefresh } from "./navigation-query-events";
import {
  applyNavigationSelectedDetail,
  navigationIdentityKey,
  selectNavigationIdentity,
  type NavigationSelectionState,
} from "./navigation-query-state";

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
  const pullRequestKeysRef = useRef(new Set<string>());
  const sequenceRef = useRef(0);
  const connectionRef = useRef<{ owner: string; status: string } | undefined>(undefined);
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
      const detail = await desktopApi.getNavigationSelectedDetail({
        protocol: 2,
        ref: selectedRef,
        federationTarget: currentParams.federationTarget,
        knownRevision: started.stale ? undefined : started.detail?.revision,
      });
      if (sequenceRef.current !== sequence) return;
      const next = applyNavigationSelectedDetail({ state: started, sequence, detail });
      pullRequestKeysRef.current = new Set(next.detail?.thread?.prs?.map(buildPullRequestStatusKey));
      currentRef.current = next;
      setState(next);
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
    return () => { sequenceRef.current += 1; };
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
      if (!exactThreadEvent && patchedThread === currentThread) return;
      if (!navigationQueryEventRequiresRefresh(notification.method)
        && notification.method !== "thread/codexEnvironment/updated"
        && notification.method !== "thread/acpRuntime/updated") return;
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
