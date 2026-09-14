import { useCallback, useEffect, useRef, useState } from "react";
import type { NavigationThreadSummary, SubAgentLens, PricingGateSelection } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { readRendererFederationTarget } from "./federation-window";
import { acquireThreadDisplayResource, type DisplayResourceState, type ThreadDisplayResourceStore } from "./thread-display-resource-store";

/** A mounted panel owns resource demand; sibling panels share its pages and reads. */
export function useThreadDisplayResource(params: {
  desktopApi?: DesktopApi;
  thread?: Pick<NavigationThreadSummary, "id" | "source" | "federation" | "updatedAt">;
  resource?: "pricing" | "tools" | "subagents";
  subAgentLens?: SubAgentLens;
  pricingGateGroup?: PricingGateSelection;
}) {
  const target = params.thread?.federation?.ref.target ?? readRendererFederationTarget();
  const instanceId = target?.scope === "remote" ? target.instanceId : undefined;
  const key = JSON.stringify([instanceId, params.thread?.source, params.thread?.id, params.resource,
    params.resource === "subagents" ? params.subAgentLens : undefined, params.pricingGateGroup]);
  const current = useRef(params);
  current.current = params;
  const owner = useRef<{ key: string; store: ThreadDisplayResourceStore } | undefined>(undefined);
  const [state, setState] = useState<DisplayResourceState & { key: string }>({ key });
  useEffect(() => {
    const { desktopApi, thread, resource, subAgentLens, pricingGateGroup } = current.current;
    if (!desktopApi?.readThread || !thread || !resource) return;
    const { store, release } = acquireThreadDisplayResource(desktopApi, {
      backend: thread.source, threadId: thread.id,
      federationTarget: thread.federation?.ref.target ?? readRendererFederationTarget(),
      display: { resource, limit: 20,
        ...(resource === "subagents" && subAgentLens ? { subAgentLens } : {}),
        ...(resource === "pricing" ? { deferPricingGates: true, ...(pricingGateGroup ? { pricingGateGroup } : {}) } : {}),
      }, includeTurns: false, viewOnly: true,
    });
    owner.current = { key, store };
    const unsubscribe = store.subscribe(() => setState({ key, ...store.getSnapshot() }));
    setState({ key, ...store.getSnapshot() });
    return () => { unsubscribe(); release(); if (owner.current?.store === store) owner.current = undefined; };
  }, [key, params.desktopApi]);
  useEffect(() => {
    const threadId = params.thread?.id;
    const backend = params.thread?.source;
    const resource = params.resource;
    if (!resource || !threadId || !backend) return;
    const refresh = () => owner.current?.key === key && owner.current.store.invalidate();
    return params.desktopApi?.onAgentEvent?.((event) => {
      const fields = event.notification.params as Record<string, unknown>;
      const method = event.notification.method;
      if (instanceId && fields.instanceId === instanceId
        && (method === "federation/eventStream/changed" || (method === "federation/peerStatus/changed" && fields.status === "connected"))) {
        refresh(); return;
      }
      if (event.backend !== backend
        || (event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId : undefined) !== instanceId
        || fields.threadId !== threadId) return;
      // Pricing includes Token Miser and subagent costs. Tools and subagent
      // collections must not refetch in response to unrelated ledger events.
      if (method === "turn/started" || method === "turn/completed"
        || (resource === "pricing" && ["thread/pricing/updated", "thread/toolAccounting/updated", "thread/subAgents/updated"].includes(method))
        || (resource === "tools" && method === "thread/toolAccounting/updated")
        || (resource === "subagents" && method === "thread/subAgents/updated")) refresh();
    });
  }, [instanceId, key, params.desktopApi, params.resource, params.thread?.id, params.thread?.source]);
  const snapshotVersion = instanceId && !params.thread?.federation?.capabilities?.includes("event_subscriptions")
    ? params.thread?.updatedAt : undefined;
  const previousSnapshot = useRef({ key, version: snapshotVersion });
  useEffect(() => {
    const previous = previousSnapshot.current;
    previousSnapshot.current = { key, version: snapshotVersion };
    if (previous.key === key && snapshotVersion !== undefined && previous.version !== snapshotVersion) owner.current?.store.invalidate();
  }, [snapshotVersion, key]);
  const refresh = useCallback(async () => { if (owner.current?.key === key) await owner.current.store.refresh(); }, [key]);
  const loadMore = useCallback(async () => { if (owner.current?.key === key) await owner.current.store.loadMore(); }, [key]);
  return { ...(state.key === key ? state : {}), refresh, loadMore };
}
