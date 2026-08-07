import { useEffect, useMemo } from "react";
import {
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
  const eventClassesByInstance = new Map<
    string,
    Set<FederationEventClass>
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

    const eventClasses = eventClassesByInstance.get(target.instanceId)
      ?? new Set<FederationEventClass>();
    // Main-window remote pins do not inherit the dedicated remote window's
    // subscription. Keep lifecycle events flowing for every pinned owner so
    // background queue and scheduled-action projections can settle.
    if (federation.capabilities.includes("thread_navigation")) {
      eventClasses.add("navigation");
    }
    if (federation.capabilities.includes("scheduled_actions")) {
      eventClasses.add("scheduled_actions");
    }
    if (target.instanceId === selectedInstanceId) {
      if (federation.capabilities.includes("thread_detail")) {
        eventClasses.add("transcript");
      }
      if (federation.capabilities.includes("pending_request_control")) {
        eventClasses.add("pending_requests");
      }
    }
    if (eventClasses.size > 0) {
      eventClassesByInstance.set(target.instanceId, eventClasses);
    }
  }

  return [...eventClassesByInstance]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceInstanceId, eventClasses]) => ({
      sourceInstanceId,
      eventClasses: THREAD_VIEW_EVENT_CLASS_ORDER.filter((eventClass) =>
        eventClasses.has(eventClass)
      ),
    }));
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
