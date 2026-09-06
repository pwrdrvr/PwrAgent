import type { NavigationThreadSummary } from "@pwragent/shared";

type Member = {
  active: boolean;
  rank: number;
  updatedAt: number;
};

export type NavigationAttentionOrder = {
  members: Map<string, Member>;
  nextRank: number;
};

export function navigationAttentionIdentity(thread: NavigationThreadSummary): string {
  return JSON.stringify([
    thread.federation?.ref.target.scope === "remote"
      ? thread.federation.ref.target.instanceId
      : null,
    thread.source,
    thread.id,
  ]);
}

/** Reconcile complete eligible owner metadata, never a visible page. */
export function reconcileNavigationAttentionOrder(params: {
  previous?: NavigationAttentionOrder;
  threads: readonly NavigationThreadSummary[];
  promoteOnTurnEnd: boolean;
}): NavigationAttentionOrder {
  const members = new Map<string, Member>();
  let nextRank = params.previous?.nextRank ?? 1;
  const eligible = params.threads
    .filter((thread) => !thread.codexNativeSubAgent
      && (thread.threadStatus === "active" || thread.inbox.inInbox))
    .sort((left, right) => (left.updatedAt ?? 0) - (right.updatedAt ?? 0)
      || navigationAttentionIdentity(right).localeCompare(navigationAttentionIdentity(left)));
  for (const thread of eligible) {
    const key = navigationAttentionIdentity(thread);
    const previous = params.previous?.members.get(key);
    const active = thread.threadStatus === "active";
    const updatedAt = thread.updatedAt ?? 0;
    const started = active && previous?.active === false;
    const finished = !active && (previous?.active === true
      || (previous?.active === false && updatedAt > previous.updatedAt));
    const rank = !previous || started || (finished && params.promoteOnTurnEnd)
      ? nextRank++
      : previous.rank;
    members.set(key, { active, rank, updatedAt });
  }
  return { members, nextRank };
}

/** Serialized-equivalent backing, counted separately from page generations. */
export function navigationAttentionOrderBytes(order: NavigationAttentionOrder): number {
  return Buffer.byteLength(JSON.stringify({
    members: [...order.members],
    nextRank: order.nextRank,
  }), "utf8");
}
