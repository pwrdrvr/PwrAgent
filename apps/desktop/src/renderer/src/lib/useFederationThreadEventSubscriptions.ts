import { useEffect, useMemo } from "react";
import {
  buildThreadIdentityKey,
  isRemoteFederationTarget,
  type FederationEventClass,
  type FederationEventSubscription,
  type FederationRemoteTarget,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

const THREAD_VIEW_EVENT_CLASS_ORDER: FederationEventClass[] = [
  "navigation",
  "transcript",
  "pending_requests",
  "scheduled_actions",
];

export function buildFederationThreadEventSubscriptions(params: {
  selectedThread?: NavigationThreadSummary;
  threads: NavigationThreadSummary[];
}): FederationEventSubscription[] {
  const selectedTarget = params.selectedThread?.federation?.ref.target;
  const selectedInstanceId =
    selectedTarget && isRemoteFederationTarget(selectedTarget)
      ? selectedTarget.instanceId
      : undefined;
  type ThreadRefs = Map<string, { backend: NavigationThreadSummary["source"]; threadId: string }>;
  const selectionsByInstance = new Map<
    string,
    Map<FederationEventClass, ThreadRefs>
  >();
  const threads = params.selectedThread
    ? [...params.threads, params.selectedThread]
    : params.threads;

  for (const thread of threads) {
    const federation = thread.federation;
    const target = federation?.ref.target;
    if (
      !federation
      || !target
      || !isRemoteFederationTarget(target)
      || (
        federation.peerStatus !== undefined
        && federation.peerStatus !== "connected"
      )
      || !federation.capabilities?.includes("event_subscriptions")
    ) {
      continue;
    }

    const eventClasses = new Set<FederationEventClass>();
    // Main-window remote pins do not inherit the dedicated remote window's
    // subscription. Keep lifecycle events flowing for every pinned owner so
    // background queue and scheduled-action projections can settle.
    if (federation.capabilities.includes("thread_navigation")) {
      eventClasses.add("navigation");
    }
    if (federation.capabilities.includes("scheduled_actions")) {
      eventClasses.add("scheduled_actions");
    }
    if (target.instanceId === selectedInstanceId
      && thread.source === params.selectedThread?.source
      && thread.id === params.selectedThread.id) {
      if (federation.capabilities.includes("thread_detail")) {
        eventClasses.add("transcript");
      }
      if (federation.capabilities.includes("pending_request_control")) {
        eventClasses.add("pending_requests");
      }
    }
    if (eventClasses.size > 0) {
      const selections = selectionsByInstance.get(target.instanceId) ?? new Map();
      for (const eventClass of eventClasses) {
        const refs = selections.get(eventClass) ?? new Map();
        refs.set(buildThreadIdentityKey(thread.source, thread.id), {
          backend: thread.source,
          threadId: thread.id,
        });
        selections.set(eventClass, refs);
      }
      selectionsByInstance.set(target.instanceId, selections);
    }
  }

  return [...selectionsByInstance]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceInstanceId, selections]) => {
      const allRefs: ThreadRefs = new Map();
      for (const refs of selections.values()) {
        for (const [key, ref] of refs) allRefs.set(key, ref);
      }
      const eventClassSelections = Object.fromEntries([...selections].map(([eventClass, refs]) => [
        eventClass, { kind: "threads" as const, threads: [...refs.values()] },
      ]));
      return {
        sourceInstanceId,
        eventClasses: THREAD_VIEW_EVENT_CLASS_ORDER.filter((eventClass) => selections.has(eventClass)),
        threadSelection: { kind: "threads" as const, threads: [...allRefs.values()] },
        ...([...selections.values()].some((refs) => refs.size !== allRefs.size)
          ? { eventClassSelections } : {}),
      };
    });
}

export function useFederationThreadEventSubscriptions(params: {
  desktopApi?: DesktopApi;
  enabled: boolean;
  selectedThread?: NavigationThreadSummary;
  threads: NavigationThreadSummary[];
}): FederationRemoteTarget[] {
  const subscriptionsJson = JSON.stringify(
    params.enabled
      ? buildFederationThreadEventSubscriptions(params)
      : [],
  );

  useEffect(() => {
    if (!params.desktopApi?.setFederationEventSubscriptions) {
      return;
    }
    const subscriptions = JSON.parse(
      subscriptionsJson,
    ) as FederationEventSubscription[];
    void params.desktopApi.setFederationEventSubscriptions({
      consumer: "thread_view",
      subscriptions,
    });
    return () => {
      void params.desktopApi?.setFederationEventSubscriptions?.({
        consumer: "thread_view",
        subscriptions: [],
      });
    };
  }, [params.desktopApi, subscriptionsJson]);

  return useMemo(() => {
    const subscriptions = JSON.parse(
      subscriptionsJson,
    ) as FederationEventSubscription[];
    return subscriptions
      .filter((subscription) =>
        subscription.eventClasses.includes("scheduled_actions")
      )
      .map((subscription) => ({
        scope: "remote" as const,
        instanceId: subscription.sourceInstanceId,
      }));
  }, [subscriptionsJson]);
}
