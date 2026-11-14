import type {
  AppServerBackendKind,
  FederatedThreadRef,
  FederationInstanceId,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { buildFederatedThreadRef } from "@pwragent/shared";

type ThreadKey = { backend: AppServerBackendKind; threadId: string };
type TurnKey = ThreadKey & { turnId: string };

/**
 * What the owner made of one peer's input: it joined a turn, or it waits in
 * the thread's queue until a turn starts with it.
 */
export type TurnInputOutcome =
  | { kind: "turn"; turnId: string }
  | { kind: "queued"; queueEntryId: string }
  | { kind: "none" };

/** The outcome of a federated start: a turn, or a queue entry. */
export function startTurnInputOutcome(response: {
  turnId?: string;
  queueStatus?: string;
  queueEntryId?: string;
}): TurnInputOutcome {
  if (response.queueStatus === "queued") {
    return response.queueEntryId ? { kind: "queued", queueEntryId: response.queueEntryId } : { kind: "none" };
  }
  return response.turnId ? { kind: "turn", turnId: response.turnId } : { kind: "none" };
}

/**
 * The outcome of a federated steer. A steer that is queued waits under its
 * queue entry; a scheduled one is a later action, not this turn's input.
 */
export function steerInputOutcome(response: {
  ok?: boolean;
  turnId?: string;
  disposition?: string;
  queueEntryId?: string;
  requestId?: string;
}): TurnInputOutcome {
  if (response.ok === false || response.disposition === "scheduled" || response.disposition === "interrupted") {
    return { kind: "none" };
  }
  if (response.disposition === "queued") {
    const queueEntryId = response.queueEntryId ?? response.requestId;
    return queueEntryId ? { kind: "queued", queueEntryId } : { kind: "none" };
  }
  return response.turnId ? { kind: "turn", turnId: response.turnId } : { kind: "none" };
}

/**
 * Which peer viewers sent input to each turn on this owner.
 *
 * An operator who asks a peer's thread for a new thread expects it in their
 * own window, so a thread an agent creates during a turn is mounted on every
 * viewer that sent that turn input. The owner records the authenticated
 * sender of each federated start or steer. A queued input binds when its
 * queue entry starts a turn.
 *
 * Kept in memory and bounded: a turn's viewers matter only while the turn
 * runs, so a restart that forgets them loses nothing a running turn needs.
 */
export class TurnInputViewers {
  private readonly turns = new Map<string, Set<FederationInstanceId>>();
  private readonly queued = new Map<string, { thread: ThreadKey; viewers: Set<FederationInstanceId> }>();

  constructor(private readonly limit = 512) {}

  accepted(viewer: FederationInstanceId, thread: ThreadKey, outcome: TurnInputOutcome): void {
    if (outcome.kind === "turn") {
      this.add(this.turns, turnKey({ ...thread, turnId: outcome.turnId }), viewer);
    } else if (outcome.kind === "queued") {
      const entry = this.queued.get(outcome.queueEntryId) ?? { thread, viewers: new Set() };
      entry.viewers.add(viewer);
      this.touch(this.queued, outcome.queueEntryId, entry);
    }
  }

  /** A queue entry left the queue: bound to the turn it started, or dropped. */
  queueEntryChanged(event: ThreadKey & { queueEntryId: string; status: string; turnId?: string }): void {
    const entry = this.queued.get(event.queueEntryId);
    if (!entry) return;
    if (event.status === "started" && event.turnId) {
      if (entry.thread.backend !== event.backend || entry.thread.threadId !== event.threadId) return;
      this.queued.delete(event.queueEntryId);
      for (const viewer of entry.viewers) {
        this.add(this.turns, turnKey({ ...entry.thread, turnId: event.turnId }), viewer);
      }
    } else if (["cancelled", "failed", "terminal"].includes(event.status)) {
      this.queued.delete(event.queueEntryId);
    }
  }

  viewers(turn: ThreadKey & { turnId?: string }): FederationInstanceId[] {
    const turnId = turn.turnId?.trim();
    if (!turnId) return [];
    return [...(this.turns.get(turnKey({ ...turn, turnId })) ?? [])];
  }

  private add(map: Map<string, Set<FederationInstanceId>>, key: string, viewer: FederationInstanceId): void {
    const viewers = map.get(key) ?? new Set();
    viewers.add(viewer);
    this.touch(map, key, viewers);
  }

  private touch<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > this.limit) map.delete(map.keys().next().value!);
  }
}

function turnKey(turn: TurnKey): string {
  return JSON.stringify([turn.backend, turn.threadId, turn.turnId]);
}

/**
 * The viewers that still need a created thread mounted: every viewer of the
 * turn, except the one the thread lives on (it lists its own threads), this
 * owner, and one that already mounted it as its grouping root.
 */
export function createdThreadViewersToMount(params: {
  viewers: readonly FederationInstanceId[];
  createdOn: FederationInstanceId;
  localInstanceId: FederationInstanceId;
  alreadyMountedOn?: FederationInstanceId;
}): FederationInstanceId[] {
  return [...new Set(params.viewers)].filter((viewer) =>
    viewer !== params.createdOn
    && viewer !== params.localInstanceId
    && viewer !== params.alreadyMountedOn);
}

export type CreatedThread = {
  backend: AppServerBackendKind;
  threadId: string;
  instanceId: FederationInstanceId;
  instanceLabel: string;
  title?: string;
  parent?: { backend: AppServerBackendKind; threadId: string; instanceId: FederationInstanceId };
};

/**
 * Mounts a thread an agent created on each viewer whose input the calling
 * turn carried. Best effort: the thread exists, so a viewer that is offline
 * or refuses the mount must not fail the tool call that created it.
 */
export async function mountCreatedThreadOnTurnViewers(params: {
  viewers: TurnInputViewers;
  turn: ThreadKey & { turnId?: string };
  created: CreatedThread;
  localInstanceId: FederationInstanceId;
  alreadyMountedOn?: FederationInstanceId;
  mount: (viewer: FederationInstanceId, request: {
    ref: FederatedThreadRef;
    instanceLabel: string;
    summary: NavigationThreadSummary;
  }) => Promise<unknown>;
  onError?: (viewer: FederationInstanceId, error: unknown) => void;
}): Promise<FederationInstanceId[]> {
  const targets = createdThreadViewersToMount({
    viewers: params.viewers.viewers(params.turn),
    createdOn: params.created.instanceId,
    localInstanceId: params.localInstanceId,
    ...(params.alreadyMountedOn ? { alreadyMountedOn: params.alreadyMountedOn } : {}),
  });
  const { created } = params;
  const ref = buildFederatedThreadRef({ backend: created.backend, instanceId: created.instanceId, threadId: created.threadId });
  const summary: NavigationThreadSummary = {
    source: created.backend,
    id: created.threadId,
    title: created.title ?? created.threadId,
    titleSource: "fallback",
    linkedDirectories: [],
    inbox: { inInbox: false },
    ...(created.parent
      ? {
          parentThreadId: created.parent.threadId,
          parentThreadBackend: created.parent.backend,
          parentThreadInstanceId: created.parent.instanceId,
        }
      : {}),
  };
  const mounted: FederationInstanceId[] = [];
  await Promise.all(targets.map(async (viewer) => {
    try {
      await params.mount(viewer, { ref, instanceLabel: created.instanceLabel, summary });
      mounted.push(viewer);
    } catch (error) {
      params.onError?.(viewer, error);
    }
  }));
  return mounted;
}
