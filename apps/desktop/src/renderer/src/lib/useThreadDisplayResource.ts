import { useCallback, useEffect, useRef, useState } from "react";
import type { NavigationThreadSummary, ThreadDisplayData, SubAgentLens, PricingGateSelection } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { readRendererFederationTarget } from "./federation-window";

function appendPage(previous: ThreadDisplayData, page: ThreadDisplayData): ThreadDisplayData {
  if (previous.revision !== page.revision) throw new Error("Thread history changed. Refresh this panel to continue.");
  return {
    ...page,
    ...(page.subAgents && previous.subAgents ? { subAgents: [...previous.subAgents, ...page.subAgents] } : {}),
    ...(page.pricingPage && previous.pricingPage ? { pricingPage: { ...page.pricingPage, rows: [...previous.pricingPage.rows, ...page.pricingPage.rows] } } : {}),
    ...(page.toolsPage && previous.toolsPage ? { toolsPage: { ...page.toolsPage, invocations: [...previous.toolsPage.invocations, ...page.toolsPage.invocations] } } : {}),
  };
}

/** A mounted panel owns its resource request; closing it ends refresh demand. */
export function useThreadDisplayResource(params: {
  desktopApi?: DesktopApi;
  thread?: Pick<NavigationThreadSummary, "id" | "source" | "federation" | "updatedAt">;
  resource?: "pricing" | "tools" | "subagents";
  subAgentLens?: SubAgentLens;
  pricingGateGroup?: PricingGateSelection;
}) {
  const target = params.thread?.federation?.ref.target ?? readRendererFederationTarget();
  const instanceId = target?.scope === "remote" ? target.instanceId : undefined;
  const key = JSON.stringify([instanceId, params.thread?.source, params.thread?.id, params.resource, params.resource === "subagents" ? params.subAgentLens : undefined, params.pricingGateGroup]);
  const current = useRef(params);
  current.current = params;
  const generation = useRef(0);
  const [state, setState] = useState<{ key: string; data?: ThreadDisplayData; loading?: boolean; error?: string }>({ key });
  const dataRef = useRef<{ key: string; data: ThreadDisplayData; pages: number } | undefined>(undefined);
  const read = useCallback(async (more = false) => {
    const { desktopApi, thread, resource, subAgentLens, pricingGateGroup } = current.current;
    if (!desktopApi?.readThread || !thread || !resource) return;
    const previous = dataRef.current?.key === key ? dataRef.current : undefined;
    if (more && !previous?.data.nextCursor) return;
    const sequence = ++generation.current;
    setState((old) => ({ key, data: old.key === key ? old.data : undefined, loading: true }));
    try {
      let data = more ? previous?.data : undefined;
      let pages = more ? previous!.pages : 0;
      // Refresh the pages the operator has opened, so an event does not hide
      // older rows or combine rows from different owner revisions.
      const pageCount = more ? 1 : previous?.pages ?? 1;
      for (let index = 0; index < pageCount; index += 1) {
        const response = await desktopApi.readThread({
          backend: thread.source, threadId: thread.id,
          federationTarget: thread.federation?.ref.target ?? readRendererFederationTarget(),
          display: { resource, cursor: data?.nextCursor, limit: 20,
            ...(resource === "subagents" && subAgentLens ? { subAgentLens } : {}),
            ...(resource === "pricing" ? { deferPricingGates: true, ...(pricingGateGroup ? { pricingGateGroup } : {}) } : {}),
          },
          includeTurns: false, viewOnly: true,
        });
        if (sequence !== generation.current) return;
        if (!response.display) throw new Error("Thread owner did not return the requested display resource.");
        data = data ? appendPage(data, response.display) : response.display;
        pages += 1;
        if (!data.nextCursor) break;
      }
      if (!data) return;
      dataRef.current = { key, data, pages };
      setState({ key, data });
    } catch (error) {
      if (sequence === generation.current) setState((old) => ({ ...old, key, loading: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }, [key]);
  useEffect(() => {
    void read();
    return () => { generation.current += 1; };
  }, [read, params.desktopApi]);
  useEffect(() => {
    const threadId = params.thread?.id;
    const backend = params.thread?.source;
    if (!params.resource || !threadId || !backend) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      generation.current += 1;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void read(); }, 200);
    };
    const unsubscribe = params.desktopApi?.onAgentEvent?.((event) => {
      const fields = event.notification.params as Record<string, unknown>;
      if (instanceId && fields.instanceId === instanceId
        && (event.notification.method === "federation/eventStream/changed"
          || (event.notification.method === "federation/peerStatus/changed" && fields.status === "connected"))) {
        refresh();
        return;
      }
      if (event.backend !== backend
        || (event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId : undefined) !== instanceId
        || fields.threadId !== threadId) return;
      if (["thread/pricing/updated", "thread/toolAccounting/updated", "thread/subAgents/updated", "turn/started", "turn/completed"].includes(event.notification.method)) refresh();
    });
    return () => { if (timer) clearTimeout(timer); unsubscribe?.(); };
  }, [instanceId, params.desktopApi, params.resource, params.thread?.id, params.thread?.source, read]);
  // Peers may permit detail reads without subscribing to events. Their
  // navigation timestamp remains a recovery signal for an open panel.
  const snapshotVersion = instanceId && !params.thread?.federation?.capabilities?.includes("event_subscriptions")
    ? params.thread?.updatedAt : undefined;
  const previousSnapshot = useRef({ key, version: snapshotVersion });
  useEffect(() => {
    const previous = previousSnapshot.current;
    previousSnapshot.current = { key, version: snapshotVersion };
    if (previous.key === key && snapshotVersion !== undefined && previous.version !== snapshotVersion) void read();
  }, [snapshotVersion, key, read]);
  const refresh = useCallback(() => read(), [read]);
  const loadMore = useCallback(() => read(true), [read]);
  return { ...(state.key === key ? state : {}), refresh, loadMore };
}
