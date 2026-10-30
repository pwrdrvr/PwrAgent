import { createNavigationDiagnosticView } from "./navigation-listing-diagnostics";
import type { NavigationDiagnosticCause } from "../../../shared/navigation-diagnostic-cause";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { classifyDirectory } from "@pwragent/shared";
import type { AgentEvent, FederationTarget, NavigationDirectoryRow, NavigationQueryAnchor, NavigationQueryPage } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { federationTargetsEqual } from "./federated-thread-events";
import { addVisibleMountedOwnerDemand, buildNavigationWindowDemand, visibleDisclosedNavigationParents } from "./navigation-window-demand";
import { navigationIdentitiesEqual, navigationIdentityKey } from "./navigation-query-state";
import { navigationQueryEventRequiresRefresh } from "./navigation-query-events";
import { prepareNavigationDemand, NavigationWindowQueries, type NavigationWindowQueriesState } from "./navigation-window-queries";

type Demand = Omit<Parameters<typeof buildNavigationWindowDemand>[0], "directories">;
const EMPTY: NavigationWindowQueriesState = { resources: new Map() };

/** Window-owned demand/readiness. No row set represents the complete owner population. */
export function useBoundedNavigationWindow(params: Demand & {
  desktopApi?: DesktopApi;
  enabled: boolean;
  visible: boolean;
  observeEvents?: boolean;
  loadedRowsByQuery?: Readonly<Record<string, number>>;
  onLoadMore?: (queryKey: string, rows: number) => void;
  onRangeReset?: (queryKey: string) => void;
}) {
  const { desktopApi, enabled, visible } = params;
  const [state, setState] = useState<NavigationWindowQueriesState>(EMPTY);
  const diagnosticRef = useRef<{ view: number; effect: number } | undefined>(undefined);
  diagnosticRef.current ??= { view: createNavigationDiagnosticView(), effect: 0 };
  const controllerRef = useRef<NavigationWindowQueries | undefined>(undefined);
  const selectedRangeCheckedRef = useRef(new Map<string, string>());
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const [connection, setConnection] = useState<{ target: string; connected: boolean; error?: string }>();
  const pagesRef = useRef<ReadonlyMap<string, NavigationQueryPage>>(new Map());
  const pages = useMemo(() => {
    let count = 0;
    let same = true;
    for (const [id, resource] of state.resources) {
      if (!resource.state.page) continue;
      count += 1;
      if (pagesRef.current.get(id) !== resource.state.page) same = false;
    }
    if (same && count === pagesRef.current.size) return pagesRef.current;
    return new Map([...state.resources].flatMap(([id, resource]) => resource.state.page ? [[id, resource.state.page] as const] : []));
  }, [state.resources]);
  pagesRef.current = pages;
  const targetKey = useMemo(() => JSON.stringify(params.target ?? { scope: "local" }),
    [params.target?.scope, params.target?.scope === "remote" ? params.target.instanceId : undefined]);
  const connected = connection?.target !== targetKey || connection.connected;
  const directoriesRef = useRef<NavigationDirectoryRow[]>([]);
  const directories = useMemo(() => {
    // Later sources replace earlier ones, except that a page awaiting its
    // re-read never replaces a descriptor from a page that has re-read.
    // Pages re-read in any order after one change: a selection read still
    // waiting would otherwise restore a pin the index has just removed.
    const descriptors = new Map<string, { directory: NavigationDirectoryRow; stale: boolean }>();
    const offer = (directory: NavigationDirectoryRow, stale: boolean): void => {
      const current = descriptors.get(directory.key);
      if (current && stale && !current.stale) return;
      descriptors.set(directory.key, { directory, stale });
    };
    for (const id of ["directory-index", "selected-directories"]) {
      const resource = state.resources.get(id);
      if (!federationTargetsEqual(resource?.state.request.federationTarget, params.target)) continue;
      for (const directory of resource?.state.page?.directories ?? []) offer(directory, Boolean(resource?.state.stale));
    }
    for (const id of ["selected-context", "selected-viewer-mount"]) {
      const resource = state.resources.get(id);
      // Owner exact reads supply ancestry, not viewer project membership or
      // counts. Importing their descriptor duplicates peer paths and turns
      // owner-local activity into viewer-local activity.
      if (!federationTargetsEqual(resource?.state.request.federationTarget, params.target)) continue;
      const directory = resource?.state.page?.selectionDirectory;
      if (directory) offer(directory, Boolean(resource?.state.stale));
    }
    const next = [...descriptors.values()].map(({ directory }) => directory);
    return next.length === directoriesRef.current.length && next.every((directory, index) => directory === directoriesRef.current[index])
      ? directoriesRef.current : next;
  }, [state.resources, params.target]);
  directoriesRef.current = directories;
  const selectedResource = state.resources.get("selected-context");
  const selectedQuery = selectedResource?.state.request.query;
  const selectedContext = params.selectedRef && selectedQuery?.kind === "exact"
    && selectedQuery.identities.length === 1
    && navigationIdentitiesEqual(selectedQuery.identities[0]!, params.selectedRef)
    ? selectedResource?.state.page : undefined;
  const remoteViewerSelection = Boolean(params.selectedRef?.ownerInstanceId) && params.target?.scope !== "remote";
  const mountResource = state.resources.get("selected-viewer-mount");
  const mountQuery = mountResource?.state.request.query;
  const selectedMount = params.selectedRef && mountQuery?.kind === "exact"
    && mountQuery.identities.length === 1
    && navigationIdentitiesEqual(mountQuery.identities[0]!, params.selectedRef)
    ? mountResource?.state.page : undefined;
  // The owner's inventory cannot supply a root owned by this viewer. Reveal
  // and range seeking must use the same ancestry as directory presentation.
  const presentedSelection = remoteViewerSelection ? selectedMount : selectedContext;
  const selectedRoot = presentedSelection?.entries.find((entry) => entry.placement.kind === "root");
  const selectedHome = presentedSelection?.selectionDirectory;
  // While the viewer mount loads, neither owner-linked paths nor detail
  // fallback paths can identify a directory in the viewer inventory.
  const selectedDirectoryKeys = useMemo(() => selectedHome ? [selectedHome.key] : remoteViewerSelection ? []
    : selectedRoot?.row.linkedDirectories.length
      ? selectedRoot.row.linkedDirectories.map((directory) => classifyDirectory(directory).key) : params.selectedDirectoryKeys,
  [selectedHome?.key, remoteViewerSelection, selectedRoot?.row.linkedDirectories, params.selectedDirectoryKeys]);
  const indexedDirectories = state.resources.get("directory-index")?.state.page?.directories;
  const selectedContextReady = Boolean(presentedSelection);
  const demand = useMemo(() => {
    const demandParams = { browseMode: params.browseMode, target: params.target, attentionView: params.attentionView,
      expandedByKey: params.expandedByKey, unpinnedExpandedByKey: params.unpinnedExpandedByKey,
      selectedRef: params.selectedRef, removedDirectoryKeys: params.removedDirectoryKeys, draftRefs: params.draftRefs,
      pinnedThreadsOnTop: params.pinnedThreadsOnTop, directories, selectedDirectoryKeys,
      selectedRootRef: selectedRoot?.row.ref, selectedContextReady,
      indexedDirectoryKeys: new Set((indexedDirectories ?? []).map((directory) => directory.key)),
    };
    const collections = buildNavigationWindowDemand({ ...demandParams, disclosedParents: [] });
    const disclosedParents = visibleDisclosedNavigationParents({ collectionIds: collections.keys(), pages,
      disclosedParents: params.disclosedParents ?? [],
    });
    const requests = buildNavigationWindowDemand({ ...demandParams, disclosedParents });
    addVisibleMountedOwnerDemand({ demand: requests, pages, target: params.target, selectedRef: params.selectedRef });
    return prepareNavigationDemand(requests);
  }, [params.browseMode, params.target, params.attentionView, params.expandedByKey, params.unpinnedExpandedByKey,
    params.selectedRef, params.removedDirectoryKeys, params.draftRefs, params.pinnedThreadsOnTop, params.disclosedParents,
    directories, selectedDirectoryKeys, selectedRoot?.row.ref, selectedContextReady, indexedDirectories, pages]);
  // A previous lens can still own the snapshot during the render that changes
  // demand. Empty Drafts and collapsed Directories are ready only after that
  // transition, just like lenses with collection pages.
  const presentationReady = useMemo(() => {
    if (!controllerRef.current?.matchesDemand(demand, state)) return false;
    for (const resource of state.resources.values()) {
      if (!(resource.state.page || resource.state.error)) return false;
    }
    return true;
  }, [state, demand]);
  const demandRef = useRef(demand);
  demandRef.current = demand;

  useEffect(() => {
    const diagnostic = diagnosticRef.current!;
    diagnostic.effect += 1;
    const controller = new NavigationWindowQueries(paramsRef.current.desktopApi ?? {}, { ...diagnostic }, {
      loadedRowsByQuery: paramsRef.current.loadedRowsByQuery,
      onLoadMore: (key, rows) => paramsRef.current.onLoadMore?.(key, rows),
      onRangeReset: (key) => paramsRef.current.onRangeReset?.(key),
    });
    controllerRef.current = controller;
    selectedRangeCheckedRef.current.clear();
    const unsubscribe = controller.subscribe(() => setState(controller.getSnapshot()));
    const current = paramsRef.current;
    controller.setVisible(current.enabled && current.visible);
    controller.setPreparedDemand(demandRef.current);
    setState(controller.getSnapshot());
    return () => {
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = undefined;
    };
  }, [desktopApi?.getNavigationQueryPage, desktopApi?.releaseNavigationQuery]);

  useLayoutEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.setVisible(enabled && visible && connected);
    controller.setPreparedDemand(demandRef.current);
  }, [desktopApi, demand, enabled, visible, connected]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || controller.getSnapshot() !== state || !enabled || !visible || !connected) return;
    for (const id of selectedRangeCheckedRef.current.keys()) {
      if (!state.resources.has(id)) selectedRangeCheckedRef.current.delete(id);
    }
    if (params.browseMode !== "directories" || !params.selectedRef || !selectedRoot) return;
    // Exact selection supplies an off-page pin for presentation independently.
    // Seeking its append rank would replace the visible pins with a tail page.
    if (selectedRoot.row.pinnedRank) return;
    const selection = navigationIdentityKey(params.selectedRef);
    const rootKey = navigationIdentityKey(selectedRoot.row.ref);
    for (const directoryKey of selectedDirectoryKeys ?? []) {
      const id = `${selectedRoot.row.pinnedRank ? "directory-pins" : "directory"}:${directoryKey}`;
      const resource = state.resources.get(id);
      const query = resource?.state.request.query;
      const page = resource?.state.page;
      if (!page || resource?.loading || resource?.state.error || page.coverage.state !== "complete"
        || query?.kind !== "directory" || (query.roots === "pinned" && !selectedRoot.row.pinnedRank)) continue;
      const checked = JSON.stringify([selection, rootKey, query.roots]);
      if (selectedRangeCheckedRef.current.get(id) === checked) continue;
      selectedRangeCheckedRef.current.set(id, checked);
      // Seek only within the selected section; the other section retains its page.
      // Seek only when an exact restored/selected ancestor is outside it.
      if (!page.entries.some((entry) => navigationIdentityKey(entry.row.ref) === rootKey)) {
        void controller.rebaseline(id, { kind: "thread", ref: selectedRoot.row.ref });
      }
    }
  }, [connected, enabled, params.browseMode, params.selectedRef, selectedDirectoryKeys, selectedRoot, state, visible]);

  useEffect(() => {
    const viewId = params.attentionView.id;
    const federationTarget = paramsRef.current.target;
    const release = paramsRef.current.desktopApi?.releaseNavigationAttentionView;
    return () => { void release?.({ viewId, federationTarget }).catch(() => undefined); };
  }, [desktopApi?.releaseNavigationAttentionView, params.attentionView.id, targetKey]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pendingOwners = new Map<string, FederationTarget>();
    const schedule = (owner: FederationTarget = { scope: "local" }, event?: AgentEvent) => {
      // A peer change also affects viewer membership/counts, but never another peer.
      const owners: FederationTarget[] = [owner];
      if (owner.scope === "remote" && paramsRef.current.target?.scope !== "remote") owners.push({ scope: "local" });
      for (const target of owners) pendingOwners.set(JSON.stringify(target), target);
      controllerRef.current?.invalidate(undefined, owners, event);
      if (timer || !paramsRef.current.enabled || !paramsRef.current.visible) return;
      timer = setTimeout(() => {
        timer = undefined;
        const owners = [...pendingOwners.values()];
        pendingOwners.clear();
        void controllerRef.current?.refresh(undefined, owners, true);
      }, 250);
    };
    const api = paramsRef.current.desktopApi;
    const unsubscribe = api?.onAgentEvent?.((event) => {
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
      if ((federationTargetsEqual(event.federationTarget, target) || target?.scope !== "remote")
        && navigationQueryEventRequiresRefresh(event.notification.method, event.notification.params)) schedule(event.federationTarget, event);
    });
    const bindings = api?.onMessagingBindingsChanged?.(() => {
      if (paramsRef.current.observeEvents !== false && (!paramsRef.current.target || paramsRef.current.target.scope === "local")) schedule();
    });
    return () => { unsubscribe?.(); bindings?.(); if (timer) clearTimeout(timer); };
  }, [desktopApi?.onAgentEvent, desktopApi?.onMessagingBindingsChanged]);

  const invalidate = useCallback((owners?: readonly FederationTarget[], event?: AgentEvent) => controllerRef.current?.invalidate(undefined, owners, event), []);
  const refresh = useCallback((owners?: readonly FederationTarget[], invalidatedOnly = false, cause?: NavigationDiagnosticCause) => controllerRef.current?.refresh(undefined, owners, invalidatedOnly, cause) ?? Promise.resolve(), []);
  const loadMore = useCallback((id: string) => controllerRef.current?.loadMore(id) ?? Promise.resolve(), []);
  const rebaseline = useCallback((id: string, anchor: NavigationQueryAnchor) => controllerRef.current?.rebaseline(id, anchor) ?? Promise.resolve(), []);
  const restart = useCallback((id: string) => controllerRef.current?.restart(id) ?? Promise.resolve(), []);
  const setVisibleAnchor = useCallback((id: string, anchor: NavigationQueryAnchor | undefined) => controllerRef.current?.setVisibleAnchor(id, anchor), []);
  const connectionError = !connected && connection?.target === targetKey ? connection.error : undefined;
  return { ...state, presentationReady, directories, selectedDirectoryKeys, connected, ...(connectionError ? { connectionError } : {}), invalidate, refresh, loadMore, rebaseline, restart, setVisibleAnchor };
}
