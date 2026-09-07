import type { NavigationThreadSummary } from "@pwragent/shared";

type Member = {
  active: boolean;
  rank: number;
  updatedAt: number;
  /** Canonical turn identity prevents replayed boundaries from moving a rank. */
  eventTurnId?: string;
  /** Membership-scoped replay protection, charged to the owner's Attention budget. */
  observedTurnIds?: readonly string[];
  eventTracked?: boolean;
  awaitingBaseline?: boolean;
};

export type NavigationAttentionOrder = {
  members: Map<string, Member>;
  nextRank: number;
};

export function observeNavigationAttentionTurn(params: {
  previous: NavigationAttentionOrder;
  key: string;
  active: boolean;
  turnId?: string;
  promoteOnTurnEnd: boolean;
}): NavigationAttentionOrder {
  const previous = params.previous.members.get(params.key);
  const observedTurnIds = previous?.observedTurnIds ?? (previous?.eventTurnId ? [previous.eventTurnId] : []);
  if (params.turnId && params.turnId !== previous?.eventTurnId && observedTurnIds.includes(params.turnId)) return params.previous;
  if (previous?.active === params.active && (!params.turnId || previous.eventTurnId === params.turnId)) return params.previous;
  // An old completion cannot finish a newer live turn.
  if (!params.active && previous?.active && previous.eventTurnId && params.turnId
    && previous.eventTurnId !== params.turnId) return params.previous;
  const newTurn = Boolean(params.turnId && previous?.eventTurnId !== params.turnId);
  const move = !previous || (params.active ? !previous.active || (newTurn && Boolean(previous.eventTurnId))
    : (!previous.active && newTurn) || params.promoteOnTurnEnd);
  const rank = move ? params.previous.nextRank : previous.rank;
  const members = new Map(params.previous.members);
  members.set(params.key, { active: params.active, rank, updatedAt: previous?.updatedAt ?? 0,
    observedTurnIds: params.turnId && !observedTurnIds.includes(params.turnId) ? [...observedTurnIds, params.turnId] : observedTurnIds,
    eventTurnId: params.active ? params.turnId : params.turnId ?? previous?.eventTurnId, eventTracked: true, awaitingBaseline: true });
  return { members, nextRank: params.previous.nextRank + Number(move) };
}

export function navigationAttentionIdentity(thread: NavigationThreadSummary): string {
  return JSON.stringify([
    thread.federation?.ref.target.scope === "remote"
      ? thread.federation.ref.target.instanceId
      : null,
    thread.source,
    thread.id,
  ]);
}

/** Reconcile owner metadata, never a visible page; incomplete coverage cannot remove unseen members. */
export function reconcileNavigationAttentionOrder(params: {
  previous?: NavigationAttentionOrder;
  threads: readonly NavigationThreadSummary[];
  promoteOnTurnEnd: boolean;
  complete?: boolean;
}): NavigationAttentionOrder {
  const members = params.complete === false ? new Map(params.previous?.members) : new Map<string, Member>();
  // Newly accepted turns can precede provider list visibility. Their owner
  // event ranks survive that absence until a baseline or removal confirms it.
  for (const [key, member] of params.previous?.members ?? []) {
    if (member.awaitingBaseline) members.set(key, member);
  }
  for (const thread of params.threads) {
    const key = navigationAttentionIdentity(thread);
    const previous = params.previous?.members.get(key);
    if (thread.codexNativeSubAgent || (thread.threadStatus !== "active" && !thread.inbox.inInbox
      && (!previous?.awaitingBaseline || !previous.active))) members.delete(key);
  }
  let nextRank = params.previous?.nextRank ?? 1;
  const eligible = params.threads
    .filter((thread) => !thread.codexNativeSubAgent
      && (thread.threadStatus === "active" || thread.inbox.inInbox))
    .sort((left, right) => (left.updatedAt ?? 0) - (right.updatedAt ?? 0)
      || navigationAttentionIdentity(right).localeCompare(navigationAttentionIdentity(left)));
  for (const thread of eligible) {
    const key = navigationAttentionIdentity(thread);
    const previous = params.previous?.members.get(key);
    const observedActive = thread.threadStatus === "active";
    const active = previous?.awaitingBaseline ? previous.active : observedActive;
    const updatedAt = thread.updatedAt ?? 0;
    const started = active && previous?.active === false;
    const finished = !active && (previous?.active === true
      || (previous?.active === false && !previous.eventTracked && updatedAt > previous.updatedAt));
    const rank = !previous || started || (finished && params.promoteOnTurnEnd)
      ? nextRank++
      : previous.rank;
    members.set(key, { active, rank, updatedAt,
      ...(previous?.eventTurnId ? { eventTurnId: previous.eventTurnId } : {}),
      ...(previous?.observedTurnIds ? { observedTurnIds: previous.observedTurnIds } : {}),
      ...(previous?.eventTracked ? { eventTracked: true } : {}),
      ...(previous?.awaitingBaseline && observedActive !== active ? { awaitingBaseline: true } : {}),
    });
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
