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
  localInstanceId: string;
  descriptors: ReadonlyMap<string, readonly NavigationDirectoryRow[]>;
  filters: NavigationStarMapFilterSelection;
}) {
  const api = params.desktopApi;
  const viewId = useId();
  const owners = useRef(new Set<string>());
  const controller = useMemo(() => new NavigationWindowQueries({
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
  }), [api]);
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
    controller.setDemand(demand);
  }, [controller, demandKey, filterKey, params.localInstanceId, viewId]);
  useEffect(() => {
    const visibility = () => controller.setVisible(document.visibilityState !== "hidden");
    visibility();
    document.addEventListener("visibilitychange", visibility);
    let pending: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = undefined; void controller.refresh(); }, 250);
    };
    const unsubscribe = api?.onAgentEvent?.((event) => {
      if (navigationQueryEventRequiresRefresh(event.notification.method)) refresh();
    });
    const timer = setInterval(() => { void controller.refresh(); }, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      unsubscribe?.();
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      controller.dispose();
    };
  }, [api, controller]);
  useEffect(() => {
    const admittedOwners = owners.current;
    return () => {
      for (const owner of admittedOwners) {
        void api?.releaseNavigationAttentionView?.({ viewId,
          ...(owner ? { federationTarget: { scope: "remote", instanceId: owner } } : {}) }).catch(() => undefined);
      }
    };
  }, [api, viewId]);
  return { state, controller };
}
