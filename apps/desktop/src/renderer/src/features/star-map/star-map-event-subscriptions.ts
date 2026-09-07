import {
  buildThreadIdentityKey,
  isRemoteFederationTarget,
  type FederationEventClass,
  type FederationEventSubscription,
  type FederationPeerSummary,
  type FederationThreadSelection,
  type NavigationThreadSummary,
} from "@pwragent/shared";

/** Graph invalidations are broad; only open cards own detail payload demand. */
export function buildStarMapEventSubscriptions(
  peers: readonly Pick<FederationPeerSummary, "id" | "status" | "capabilities">[],
  cards: readonly {
    ownerInstanceId: string;
    thread: Pick<NavigationThreadSummary, "id" | "source" | "federation">;
  }[],
): FederationEventSubscription[] {
  return peers.filter((peer) => peer.status === "connected"
    && peer.capabilities.includes("event_subscriptions")).map((peer) => {
    const eventClasses: FederationEventClass[] = [
      ...(peer.capabilities.includes("thread_navigation")
        ? ["navigation" as const, "star_map" as const] : []),
      ...(peer.capabilities.includes("scheduled_actions")
        ? ["scheduled_actions" as const] : []),
    ];
    const refs = new Map<string, { backend: NavigationThreadSummary["source"]; threadId: string }>();
    for (const card of cards) {
      const target = card.thread.federation?.ref.target;
      const owner = target && isRemoteFederationTarget(target) ? target.instanceId : card.ownerInstanceId;
      if (owner !== peer.id) continue;
      refs.set(buildThreadIdentityKey(card.thread.source, card.thread.id), {
        backend: card.thread.source, threadId: card.thread.id,
      });
    }
    const selections: NonNullable<FederationEventSubscription["eventClassSelections"]> =
      Object.fromEntries(eventClasses.map((eventClass) => [eventClass, { kind: "all" }]));
    if (refs.size > 0) {
      const selected: FederationThreadSelection = {
        kind: "threads",
        threads: [...refs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, ref]) => ref),
      };
      for (const [eventClass, capability] of [
        ["transcript", "thread_detail"], ["pending_requests", "pending_request_control"],
      ] as const) {
        if (!peer.capabilities.includes(capability)) continue;
        eventClasses.push(eventClass);
        selections[eventClass] = selected;
      }
    }
    return {
      sourceInstanceId: peer.id,
      eventClasses,
      threadSelection: { kind: "all" as const },
      ...(refs.size > 0 ? { eventClassSelections: selections } : {}),
    };
  });
}
