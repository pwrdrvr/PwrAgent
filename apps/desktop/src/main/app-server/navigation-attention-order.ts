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
  /** Observation clock value of the boundary or listing that last decided this member. */
  observedAt?: number;
};

export type NavigationAttentionOrder = {
  members: Map<string, Member>;
  nextRank: number;
  /**
   * Members a boundary or listing removed, by the observation value of that
   * removal. An older listing cannot admit them again; the first listing that
   * began after the removal decides them and drops the entry.
   */
  removed?: Map<string, number>;
  /**
   * When the newest complete listing applied here began. That listing decided
   * every thread it did not admit, so an older one cannot admit it either.
   */
  listedAt?: number;
};

export function observeNavigationAttentionTurn(params: {
  previous: NavigationAttentionOrder;
  key: string;
  active: boolean;
  turnId?: string;
  promoteOnTurnEnd: boolean;
  /** This boundary's observation clock value. */
  observedAt?: number;
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
    eventTurnId: params.active ? params.turnId : params.turnId ?? previous?.eventTurnId, eventTracked: true, awaitingBaseline: true,
    ...(params.observedAt !== undefined ? { observedAt: params.observedAt } : {}) });
  let removed = params.previous.removed;
  if (removed?.has(params.key)) {
    removed = new Map(removed);
    removed.delete(params.key);
  }
  return { members, nextRank: params.previous.nextRank + Number(move), ...(removed?.size ? { removed } : {}),
    ...(params.previous.listedAt !== undefined ? { listedAt: params.previous.listedAt } : {}) };
}

/** A boundary took the member out of Attention (archive, or a seen idle thread). */
export function removeNavigationAttentionMember(params: {
  previous: NavigationAttentionOrder;
  key: string;
  observedAt: number;
}): NavigationAttentionOrder {
  const members = new Map(params.previous.members);
  members.delete(params.key);
  const removed = new Map(params.previous.removed);
  removed.set(params.key, params.observedAt);
  return { ...params.previous, members, removed };
}

/** Whether something in the order was observed after a listing that began at `observedAt`. */
export function navigationAttentionOrderFollows(order: NavigationAttentionOrder, observedAt: number): boolean {
  if ((order.listedAt ?? 0) > observedAt) return true;
  for (const member of order.members.values()) if ((member.observedAt ?? 0) > observedAt) return true;
  for (const at of order.removed?.values() ?? []) if (at > observedAt) return true;
  return false;
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

/** A live turn, an owned worker, or background tasks that outlived the turn. */
function isLive(thread: NavigationThreadSummary): boolean {
  return thread.threadStatus === "active"
    || thread.hasActiveSubAgent === true
    || thread.hasBackgroundTasks === true;
}

/**
 * Reconcile owner metadata, never a visible page; incomplete coverage cannot remove unseen members.
 *
 * `observedAt` is the observation clock value taken when the listing began.
 * Reads for one view overlap, and a read can be served a scan that began
 * before a boundary the store has already applied, so a listing can be older
 * than what the order already holds. A member decided, or removed, by a
 * later boundary or listing is left as it is. Rows from a peer are as fresh
 * as the viewer's peer summary cache, which this value does not describe.
 */
export function reconcileNavigationAttentionOrder(params: {
  previous?: NavigationAttentionOrder;
  threads: readonly NavigationThreadSummary[];
  promoteOnTurnEnd: boolean;
  complete?: boolean;
  observedAt?: number;
}): NavigationAttentionOrder {
  const { observedAt } = params;
  const follows = (at: number | undefined): boolean => observedAt !== undefined && at !== undefined && at > observedAt;
  const members = params.complete === false ? new Map(params.previous?.members) : new Map<string, Member>();
  // Newly accepted turns can precede provider list visibility. Their owner
  // event ranks survive that absence until a baseline or removal confirms it.
  for (const [key, member] of params.previous?.members ?? []) {
    if (member.awaitingBaseline || follows(member.observedAt)) members.set(key, member);
  }
  const removed = new Map<string, number>();
  for (const [key, at] of params.previous?.removed ?? []) {
    if (follows(at)) removed.set(key, at);
  }
  // This listing has no say over a member or removal observed after it began,
  // nor over a non-member a newer complete listing already left out.
  const decides = (key: string): boolean => {
    const member = params.previous?.members.get(key);
    return !follows(member?.observedAt) && !removed.has(key) && (member !== undefined || !follows(params.previous?.listedAt));
  };
  for (const thread of params.threads) {
    const key = navigationAttentionIdentity(thread);
    const previous = params.previous?.members.get(key);
    if (decides(key) && (thread.codexNativeSubAgent || (!isLive(thread) && !thread.inbox.inInbox
      && (!previous?.awaitingBaseline || !previous.active)))) members.delete(key);
  }
  let nextRank = params.previous?.nextRank ?? 1;
  const eligible = params.threads
    .filter((thread) => !thread.codexNativeSubAgent && decides(navigationAttentionIdentity(thread))
      && (isLive(thread) || thread.inbox.inInbox))
    .sort((left, right) => (left.updatedAt ?? 0) - (right.updatedAt ?? 0)
      || navigationAttentionIdentity(right).localeCompare(navigationAttentionIdentity(left)));
  for (const thread of eligible) {
    const key = navigationAttentionIdentity(thread);
    const previous = params.previous?.members.get(key);
    // Worker activity keeps membership, but ordering still follows parent turns.
    const observedActive = thread.threadStatus === "active";
    const active = previous?.awaitingBaseline ? previous.active : observedActive;
    const updatedAt = thread.updatedAt ?? 0;
    const started = active && previous?.active === false;
    const finished = !active && (previous?.active === true
      || (previous?.active === false && !previous.eventTracked && updatedAt > previous.updatedAt));
    const rank = !previous || started || (finished && params.promoteOnTurnEnd)
      ? nextRank++
      : previous.rank;
    const awaitingBaseline = previous?.awaitingBaseline && observedActive !== active;
    // A boundary still awaiting agreement keeps its own observation.
    const memberObservedAt = awaitingBaseline ? previous?.observedAt : observedAt ?? previous?.observedAt;
    members.set(key, { active, rank, updatedAt,
      ...(previous?.eventTurnId ? { eventTurnId: previous.eventTurnId } : {}),
      ...(previous?.observedTurnIds ? { observedTurnIds: previous.observedTurnIds } : {}),
      ...(previous?.eventTracked ? { eventTracked: true } : {}),
      ...(awaitingBaseline ? { awaitingBaseline: true } : {}),
      ...(memberObservedAt !== undefined ? { observedAt: memberObservedAt } : {}),
    });
  }
  // A member this listing took out stays out for any older listing.
  if (observedAt !== undefined) {
    for (const key of params.previous?.members.keys() ?? []) {
      if (!members.has(key)) removed.set(key, observedAt);
    }
  }
  const listedAt = params.complete !== false && observedAt !== undefined
    && !follows(params.previous?.listedAt) ? observedAt : params.previous?.listedAt;
  return { members, nextRank, ...(removed.size ? { removed } : {}), ...(listedAt !== undefined ? { listedAt } : {}) };
}

/** Serialized-equivalent backing, counted separately from page generations. */
export function navigationAttentionOrderBytes(order: NavigationAttentionOrder): number {
  return Buffer.byteLength(JSON.stringify({
    members: [...order.members],
    nextRank: order.nextRank,
    removed: [...order.removed ?? []],
    listedAt: order.listedAt,
  }), "utf8");
}
