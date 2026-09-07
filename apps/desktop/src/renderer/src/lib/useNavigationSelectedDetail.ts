import { useCallback, useEffect, useRef, useState } from "react";
import type { FederationTarget, NavigationIdentity } from "@pwragent/shared";
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
  const sequenceRef = useRef(0);
  const [state, setState] = useState<NavigationSelectionState>();
  const refresh = useCallback(async () => {
    const currentParams = paramsRef.current;
    const selectedRef = currentParams.ref;
    if (!selectedRef) return;
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
    if (paramsRef.current.ref) void refresh();
    else {
      currentRef.current = undefined;
      setState(undefined);
    }
    return () => { sequenceRef.current += 1; };
  }, [identityKey, refresh, targetKey]);
  useEffect(() => {
    if (!identityKey || !desktopApi?.onAgentEvent || !desktopApi.getNavigationSelectedDetail) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = desktopApi.onAgentEvent((event) => {
      const selected = paramsRef.current.ref;
      const target = paramsRef.current.federationTarget;
      const eventOwner = event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId : undefined;
      const selectedOwner = target?.scope === "remote" ? target.instanceId : selected?.ownerInstanceId;
      const notification = event.notification;
      if (!selected || event.backend !== selected.backend || eventOwner !== selectedOwner
        || !("threadId" in notification.params) || notification.params.threadId !== selected.threadId) return;
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
            thread: applyNavigationThreadEvent(current.detail.thread, event) } : current.detail };
        currentRef.current = next;
        setState(next);
      }
      if (timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 250);
    });
    return () => { if (timer !== undefined) clearTimeout(timer); unsubscribe(); };
  }, [desktopApi, identityKey, refresh, targetKey]);
  // A render for a new owner must never expose the previous owner's ready configuration.
  const visibleState = state && identityKey === navigationIdentityKey(state.ref) ? state : undefined;
  return { state: visibleState, refresh };
}
