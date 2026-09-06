import { useCallback, useEffect, useRef, useState } from "react";
import type { FederationTarget, NavigationIdentity } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
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
        knownRevision: started.detail?.revision,
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
  return { state, refresh };
}
