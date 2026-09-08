import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import type { NavigationDirectoryRow, NavigationQueryRequest, NavigationStarMapFilterSelection } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { NavigationWindowQueries } from "../../lib/navigation-window-queries";
import { threadProjectKey } from "./star-map-projects";
import { navigationQueryEventRequiresRefresh } from "../../lib/navigation-query-events";

export function starMapProjectResource(owner: string, project: string): string {
  return JSON.stringify([owner, project]);
}

/** Ten compact cards per project, then explicit project-local continuation.
 * The existing window controller bounds concurrency, retained bytes, deadlines,
 * cursor recovery and leases. Geometry never depends on these loaded ranges.
 */
export function useStarMapProjectPages(params: {
  desktopApi?: DesktopApi;
  enabled: boolean;
  active?: boolean;
  localInstanceId: string;
  descriptors: ReadonlyMap<string, readonly NavigationDirectoryRow[]>;
  filters: NavigationStarMapFilterSelection;
}) {
  const api = params.desktopApi;
  const active = params.active ?? true;
  const viewId = useId();
  const owners = useRef(new Set<string>());
  const controller = useMemo(() => {
    const result = new NavigationWindowQueries({
      releaseNavigationQuery: api?.releaseNavigationQuery,
      getNavigationQueryPage: async (request, consumer) => {
        if (!api?.getNavigationQueryPage) throw new Error("Navigation queries are unavailable. Upgrade this instance.");
        const page = await api.getNavigationQueryPage(request, consumer);
        const query = request.query;
        if (query.kind === "star-map" && query.projectKey !== undefined
          && page.entries.some((entry) => threadProjectKey(entry.row) !== query.projectKey)) {
          throw new Error("This instance does not support project card pages. Upgrade it to continue browsing Star Map.");
        }
        return page;
      },
    });
    result.setVisible(false);
    return result;
  }, [api]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const demandKey = JSON.stringify(params.enabled ? [...params.descriptors].flatMap(([owner, projects]) =>
    projects.map((project) => [owner, project.key])) : []);
  const filterKey = JSON.stringify(params.filters);
  useEffect(() => {
    const demand = new Map<string, NavigationQueryRequest>();
    for (const [owner, projectKey] of JSON.parse(demandKey) as [string, string][]) {
      owners.current.add(owner === params.localInstanceId ? "" : owner);
      demand.set(starMapProjectResource(owner, projectKey), {
        protocol: 2, consumer: "star-map", pageSize: 10,
        attentionView: { id: viewId, promoteOnTurnEnd: true },
        ...(owner !== params.localInstanceId ? { federationTarget: { scope: "remote" as const, instanceId: owner } } : {}),
        query: { kind: "star-map", projectKey, filters: JSON.parse(filterKey) as NavigationStarMapFilterSelection },
      });
    }
    if (!active) controller.setVisible(false);
    controller.setDemand(demand);
    controller.setVisible(active);
  }, [active, controller, demandKey, filterKey, params.localInstanceId, viewId]);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    if (!active) return;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const dirty = new Set<string>();
    const unsubscribe = api?.onAgentEvent?.((event) => {
      if (!navigationQueryEventRequiresRefresh(event.notification.method)) return;
      const owner = event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId : params.localInstanceId;
      const candidates = [...controller.getSnapshot().resources.values()].filter((resource) => {
        const target = resource.state.request.federationTarget;
        return (target?.scope === "remote" ? target.instanceId : params.localInstanceId) === owner;
      });
      const details = (event.notification.params ?? {}) as { threadId?: string; directoryKey?: string };
      const matched = details.threadId ? candidates.filter((resource) => resource.state.page?.entries.some((entry) =>
        entry.row.source === event.backend && entry.row.id === details.threadId)) : [];
      // Membership changes may move a thread between projects. Otherwise a
      // known card update needs only its own project; unknown IDs need the owner.
      const scoped = event.notification.method === "navigation/threadDirectories/updated" ? candidates
        : details.directoryKey ? candidates.filter((resource) => {
          const query = resource.state.request.query;
          return query.kind === "star-map" && query.projectKey === details.directoryKey;
        }) : matched.length ? matched : candidates;
      for (const resource of scoped) dirty.add(resource.id);
      if (!dirty.size || pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        const ids = [...dirty];
        dirty.clear();
        for (const id of ids) void controller.refresh(id);
      }, 250);
    });
    const timer = setInterval(() => { void controller.refresh(); }, 60_000);
    return () => {
      unsubscribe?.();
      clearInterval(timer);
      if (pending) clearTimeout(pending);
    };
  }, [active, api, controller, params.localInstanceId]);
  useEffect(() => {
    const admittedOwners = owners.current;
    return () => {
      for (const owner of admittedOwners) {
        void api?.releaseNavigationAttentionView?.({ viewId,
          ...(owner ? { federationTarget: { scope: "remote", instanceId: owner } } : {}) }).catch(() => undefined);
      }
    };
  }, [active, api, viewId]);
  return { state, controller };
}
