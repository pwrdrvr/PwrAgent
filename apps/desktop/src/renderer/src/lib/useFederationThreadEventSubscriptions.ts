import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { buildThreadIdentityKey, type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import {
  isRemoteFederationTarget,
  type FederationEventClass,
  type FederationEventSubscription,
  type FederationRemoteTarget,
} from "@pwragent/shared/contracts/federation";
import type { DesktopApi } from "./desktop-api";
import { threadSummaryIdentityKey } from "./federated-thread-events";

const THREAD_VIEW_EVENT_CLASS_ORDER: FederationEventClass[] = [
  "navigation",
  "transcript",
  "pending_requests",
  "scheduled_actions",
];

export function buildFederationThreadEventSubscriptions(params: {
  selectedThread?: NavigationThreadSummary;
  threads: NavigationThreadSummary[];
  retainedRemoteThreads?: NavigationThreadSummary[];
}): FederationEventSubscription[] {
  const retainedKeys = new Set(params.retainedRemoteThreads?.map(threadSummaryIdentityKey));
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
  const threads = new Map([...params.threads, ...(params.retainedRemoteThreads ?? []),
    ...(params.selectedThread ? [params.selectedThread] : [])]
    .map((thread) => [threadSummaryIdentityKey(thread), thread]));

  for (const thread of threads.values()) {
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
    // subscription. Keep navigation invalidations flowing for every pinned
    // owner; full scheduled-action events belong to the selected thread.
    if (federation.capabilities.includes("thread_navigation")) {
      eventClasses.add("navigation");
    }
    const selected = target.instanceId === selectedInstanceId
      && thread.source === params.selectedThread?.source
      && thread.id === params.selectedThread.id;
    if (selected && federation.capabilities.includes("scheduled_actions")) eventClasses.add("scheduled_actions");
    if (selected || retainedKeys.has(threadSummaryIdentityKey(thread))) {
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
      const orderedRefs = (refs: ThreadRefs) => [...refs].sort(([left], [right]) => left.localeCompare(right)).map(([, ref]) => ref);
      const eventClassSelections = Object.fromEntries(THREAD_VIEW_EVENT_CLASS_ORDER.filter((eventClass) => selections.has(eventClass)).map((eventClass) => [
        eventClass, { kind: "threads" as const, threads: orderedRefs(selections.get(eventClass)!) },
      ]));
      return {
        sourceInstanceId,
        eventClasses: THREAD_VIEW_EVENT_CLASS_ORDER.filter((eventClass) => selections.has(eventClass)),
        threadSelection: { kind: "threads" as const, threads: orderedRefs(allRefs) },
        ...([...selections.values()].some((refs) => refs.size !== allRefs.size)
          ? { eventClassSelections } : {}),
      };
    });
}

type SubscriptionThreads = Parameters<typeof buildFederationThreadEventSubscriptions>[0];
type ThreadSubscriptionInput = {
  backend: NavigationThreadSummary["source"];
  threadId: string;
  refBackend?: NavigationThreadSummary["source"];
  refThreadId?: string;
  targetScope?: "local" | "remote";
  instanceId?: string;
  eventCapabilities: number;
};
type SubscriptionInputSnapshot = {
  selectedThread?: ThreadSubscriptionInput;
  threads: ThreadSubscriptionInput[];
  retainedRemoteThreads: ThreadSubscriptionInput[];
};
type SubscriptionProjection = {
  inputs?: SubscriptionInputSnapshot;
  subscriptionsJson: string;
};
const DISABLED_PROJECTION: SubscriptionProjection = { subscriptionsJson: "[]" };

function subscriptionEventCapabilities(federation: NavigationThreadSummary["federation"]): number {
  if (!federation || !isRemoteFederationTarget(federation.ref.target)
    || (federation.peerStatus !== undefined && federation.peerStatus !== "connected")
    || !federation.capabilities?.includes("event_subscriptions")) return 0;
  return (federation.capabilities.includes("thread_navigation") ? 1 : 0)
    | (federation.capabilities.includes("thread_detail") ? 2 : 0)
    | (federation.capabilities.includes("pending_request_control") ? 4 : 0)
    | (federation.capabilities.includes("scheduled_actions") ? 8 : 0);
}

function snapshotThreadSubscriptionInput(thread: NavigationThreadSummary): ThreadSubscriptionInput {
  const federation = thread.federation;
  const target = federation?.ref.target;
  return {
    backend: thread.source,
    threadId: thread.id,
    refBackend: federation?.ref.backend,
    refThreadId: federation?.ref.threadId,
    targetScope: target?.scope,
    instanceId: target?.scope === "remote" ? target.instanceId : undefined,
    eventCapabilities: subscriptionEventCapabilities(federation),
  };
}

function threadSubscriptionInputMatches(thread: NavigationThreadSummary, previous: ThreadSubscriptionInput): boolean {
  const federation = thread.federation;
  const target = federation?.ref.target;
  return thread.id === previous.threadId
    && thread.source === previous.backend
    && federation?.ref.backend === previous.refBackend
    && federation?.ref.threadId === previous.refThreadId
    && target?.scope === previous.targetScope
    && (target?.scope === "remote" ? target.instanceId : undefined) === previous.instanceId
    && subscriptionEventCapabilities(federation) === previous.eventCapabilities;
}

function subscriptionThreadListMatches(threads: NavigationThreadSummary[] | undefined, previous: ThreadSubscriptionInput[]): boolean {
  if ((threads?.length ?? 0) !== previous.length) return false;
  for (let index = 0; index < previous.length; index++) {
    if (!threadSubscriptionInputMatches(threads![index]!, previous[index]!)) return false;
  }
  return true;
}

function subscriptionInputsMatch(params: SubscriptionThreads, previous: SubscriptionInputSnapshot): boolean {
  if (params.selectedThread
    ? !previous.selectedThread || !threadSubscriptionInputMatches(params.selectedThread, previous.selectedThread)
    : previous.selectedThread !== undefined) return false;
  return subscriptionThreadListMatches(params.threads, previous.threads)
    && subscriptionThreadListMatches(params.retainedRemoteThreads, previous.retainedRemoteThreads);
}

export function useFederationThreadEventSubscriptions(params: {
  desktopApi?: DesktopApi;
  enabled: boolean;
  selectedThread?: NavigationThreadSummary;
  threads: NavigationThreadSummary[];
  retainedRemoteThreads?: NavigationThreadSummary[];
}): FederationRemoteTarget[] {
  const committed = useRef<SubscriptionProjection | undefined>(undefined);
  let projection = DISABLED_PROJECTION;
  if (params.enabled) {
    const previous = committed.current;
    if (previous?.inputs && subscriptionInputsMatch(params, previous.inputs)) {
      projection = previous;
    } else {
      // Copy only the scalars the builder reads. Summary objects, nested refs,
      // and capability arrays can change in place; their identities are unsafe.
      // Preserve list order too: the builder deliberately lets later duplicates win.
      projection = {
        inputs: {
          selectedThread: params.selectedThread ? snapshotThreadSubscriptionInput(params.selectedThread) : undefined,
          threads: params.threads.map(snapshotThreadSubscriptionInput),
          retainedRemoteThreads: (params.retainedRemoteThreads ?? []).map(snapshotThreadSubscriptionInput),
        },
        subscriptionsJson: JSON.stringify(buildFederationThreadEventSubscriptions(params)),
      };
    }
  }
  // An abandoned render must not replace the last committed input snapshot.
  useLayoutEffect(() => { committed.current = projection; }, [projection]);
  const subscriptionsJson = projection.subscriptionsJson;

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
  }, [params.desktopApi, subscriptionsJson]);

  useEffect(() => {
    const desktopApi = params.desktopApi;
    return () => {
      void desktopApi?.setFederationEventSubscriptions?.({
        consumer: "thread_view",
        subscriptions: [],
      });
    };
  }, [params.desktopApi]);

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
