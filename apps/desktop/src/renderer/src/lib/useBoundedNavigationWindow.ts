import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classifyDirectory } from "@pwragent/shared";
import type { NavigationDirectoryRow, NavigationQueryAnchor } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { federationTargetsEqual } from "./federated-thread-events";
import { buildNavigationWindowDemand } from "./navigation-window-demand";
import { navigationIdentityKey } from "./navigation-query-state";
import { navigationQueryEventRequiresRefresh } from "./navigation-query-events";
import { NavigationWindowQueries, type NavigationWindowQueriesState } from "./navigation-window-queries";

type Demand = Omit<Parameters<typeof buildNavigationWindowDemand>[0], "directories">;
const EMPTY: NavigationWindowQueriesState = { resources: new Map() };

/** Window-owned demand/readiness. No row set represents the complete owner population. */
export function useBoundedNavigationWindow(params: Demand & {
  desktopApi?: DesktopApi;
  enabled: boolean;
  visible: boolean;
  observeEvents?: boolean;
}) {
  const { desktopApi, enabled, visible } = params;
  const [state, setState] = useState<NavigationWindowQueriesState>(EMPTY);
  const controllerRef = useRef<NavigationWindowQueries | undefined>(undefined);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const [connection, setConnection] = useState<{ target: string; connected: boolean; error?: string }>();
  const targetKey = JSON.stringify(params.target ?? { scope: "local" });
  const connected = connection?.target !== targetKey || connection.connected;
  const directories = useMemo(() => {
    const descriptors = new Map<string, NavigationDirectoryRow>();
    for (const id of ["directory-index", "selected-directories"]) {
      for (const directory of state.resources.get(id)?.state.page?.directories ?? []) descriptors.set(directory.key, directory);
    }
    return [...descriptors.values()];
  }, [state.resources]);
  const selectedResource = state.resources.get("selected-context");
  const selectedQuery = selectedResource?.state.request.query;
  const selectedContext = params.selectedRef && selectedQuery?.kind === "exact"
    && selectedQuery.identities.length === 1
    && navigationIdentityKey(selectedQuery.identities[0]!) === navigationIdentityKey(params.selectedRef)
    ? selectedResource?.state.page : undefined;
  const selectedRoot = selectedContext?.entries.find((entry) => entry.placement.kind === "root");
  const selectedDirectoryKeys = selectedRoot?.row.linkedDirectories.length
    ? selectedRoot.row.linkedDirectories.map((directory) => classifyDirectory(directory).key) : params.selectedDirectoryKeys;
  const demand = buildNavigationWindowDemand({ ...params, directories, selectedDirectoryKeys,
    selectedRootRef: selectedRoot?.row.ref, selectedContextReady: Boolean(selectedContext),
    indexedDirectoryKeys: new Set((state.resources.get("directory-index")?.state.page?.directories ?? []).map((directory) => directory.key)),
  });
  const demandKey = JSON.stringify([...demand]);
  const demandRef = useRef(demand);
  demandRef.current = demand;

  useEffect(() => {
    const controller = new NavigationWindowQueries(desktopApi ?? {});
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(() => setState(controller.getSnapshot()));
    const current = paramsRef.current;
    controller.setVisible(current.enabled && current.visible);
    controller.setDemand(demandRef.current);
    setState(controller.getSnapshot());
    return () => {
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = undefined;
    };
  }, [desktopApi]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.setVisible(enabled && visible && connected);
    controller.setDemand(demandRef.current);
  }, [desktopApi, demandKey, enabled, visible, connected]);

  useEffect(() => {
    const viewId = params.attentionView.id;
    const federationTarget = paramsRef.current.target;
    return () => { void desktopApi?.releaseNavigationAttentionView?.({ viewId, federationTarget }).catch(() => undefined); };
  }, [desktopApi, params.attentionView.id, targetKey]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      controllerRef.current?.invalidate();
      if (timer || !paramsRef.current.enabled || !paramsRef.current.visible) return;
      timer = setTimeout(() => { timer = undefined; void controllerRef.current?.refresh(); }, 250);
    };
    const unsubscribe = desktopApi?.onAgentEvent?.((event) => {
      const target = paramsRef.current.target;
      if (event.notification.method === "federation/peerStatus/changed") {
        const peer = event.notification.params as { instanceId: string; status: string; unavailableReason?: string };
        if (target?.scope !== "remote" || target.instanceId !== peer.instanceId) return;
        const next = { target: JSON.stringify(target), connected: peer.status === "connected",
          error: peer.status === "connected" ? undefined : peer.unavailableReason ?? `Federation peer ${peer.instanceId} is ${peer.status}.` };
        if (!next.connected) controllerRef.current?.invalidate();
        setConnection((previous) => previous?.target === next.target && previous.connected === next.connected && previous.error === next.error ? previous : next);
        return;
      }
      if (paramsRef.current.observeEvents === false) return;
      if (federationTargetsEqual(event.federationTarget, target)
        && navigationQueryEventRequiresRefresh(event.notification.method)) schedule();
    });
    const bindings = desktopApi?.onMessagingBindingsChanged?.(() => {
      if (paramsRef.current.observeEvents !== false && (!paramsRef.current.target || paramsRef.current.target.scope === "local")) schedule();
    });
    return () => { unsubscribe?.(); bindings?.(); if (timer) clearTimeout(timer); };
  }, [desktopApi]);

  const invalidate = useCallback(() => controllerRef.current?.invalidate(), []);
  const refresh = useCallback(() => controllerRef.current?.refresh() ?? Promise.resolve(), []);
  const loadMore = useCallback((id: string) => controllerRef.current?.loadMore(id) ?? Promise.resolve(), []);
  const rebaseline = useCallback((id: string, anchor: NavigationQueryAnchor) => controllerRef.current?.rebaseline(id, anchor) ?? Promise.resolve(), []);
  const restart = useCallback((id: string) => controllerRef.current?.restart(id) ?? Promise.resolve(), []);
  const setVisibleAnchor = useCallback((id: string, anchor: NavigationQueryAnchor | undefined) => controllerRef.current?.setVisibleAnchor(id, anchor), []);
  const connectionError = !connected && connection?.target === targetKey ? connection.error : undefined;
  return { ...state, directories, selectedDirectoryKeys, connected, ...(connectionError ? { connectionError } : {}), invalidate, refresh, loadMore, rebaseline, restart, setVisibleAnchor };
}
