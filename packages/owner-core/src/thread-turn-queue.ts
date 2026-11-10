import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  AppServerCollaborationModeRequest,
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
  ProjectHeldWakeupSource,
  ThreadExecutionMode,
  ThreadIdentifier,
} from "@pwragent/shared";
import { buildThreadIdentityKey, mergeCausalMessagingContext } from "@pwragent/shared";
import { transitionQueueAdmission, type QueueAdmission, type QueueAdmissionEvent } from "./queue-admission";

export type ThreadTurnQueueOrigin =
  | "manual"
  | "automation"
  | "messaging"
  | "scheduled";

export type ThreadTurnQueueEntry = {
  id: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  origin: ThreadTurnQueueOrigin;
  messageOrigin?: AppServerThreadMessageOrigin;
  delivery?: "queued-steer";
  agentMessages?: QueuedAgentMessage[];
  agentMessageOrigins?: AppServerThreadMessageOrigin[];
  input: AppServerTurnInputItem[];
  executionMode?: ThreadExecutionMode;
  approvalPolicy?: string;
  sandbox?: string;
  model?: string;
  collaborationMode?: AppServerCollaborationModeRequest;
  serviceTier?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  automationRunId?: string;
  automationName?: string;
  manualReleaseRequired?: boolean;
  holdReason?: string;
  /**
   * The operator held this entry back. Dispatch passes over it to the next
   * entry that is not paused; it keeps its place until it is resumed.
   */
  paused?: boolean;
  /**
   * Counts this entry's pause changes, so a reader holding a newer state can
   * tell an older read of `paused` from a fresh one.
   */
  pauseRevision?: number;
  /**
   * A wake-up held because forge activity in its project is paused. The
   * entry is also `paused`, so the operator's own sends pass it; resuming it
   * sends it and clears this marker.
   */
  projectHold?: ThreadTurnQueueProjectHold;
  /**
   * A quiet restart stopped this thread's turn, and this entry continues it.
   * It sits at the top of the FIFO, and the restart gate decides when it
   * starts and what waits behind it.
   */
  restartContinuation?: true;
  /**
   * Display-only label from `queued-message-title.ts`, set after admission
   * for messages too long to show as typed. Never sent with the turn.
   */
  title?: string;
  createdAt: number;
};

export type ThreadTurnQueueProjectHold = {
  /** `directory:<path>` key of the paused project. */
  directoryKey: string;
  source: ProjectHeldWakeupSource;
  /** One line for the resume list. */
  summary: string;
};

type QueuedAgentMessage = {
  input: AppServerTurnInputItem[];
  origin?: AppServerThreadMessageOrigin;
  receivedAt: number;
  /** The sender's handle survives peer edits only while this contribution waits. */
  replacementHandle?: string;
};

export type ThreadTurnQueueStartResult = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId: string;
};

export type ThreadTurnQueueSubmissionResult =
  | {
      status: "started";
      entry: ThreadTurnQueueEntry;
      turnId: string;
    }
  | {
      status: "queued";
      entry: ThreadTurnQueueEntry;
      position: number;
    };

export type ThreadTurnQueueImmediateSubmissionResult =
  | Extract<ThreadTurnQueueSubmissionResult, { status: "started" }>
  | { status: "busy" };

export type ThreadTurnQueueCancellationResult =
  | {
      disposition: "cancelled";
      entry: ThreadTurnQueueEntry;
    }
  | {
      disposition: "already_admitted";
      entryId: string;
      turnId?: string;
    }
  | {
      disposition: "not_found";
    };

export type ThreadTurnQueueReleaseResult =
  | {
      disposition: "started";
      entryId: string;
      turnId: string;
    }
  | {
      disposition: "blocked";
      entryId: string;
      error: Error;
    }
  | {
      disposition: "busy" | "not_found" | "not_head" | "not_held";
      entryId: string;
    };

export type ThreadTurnQueueMoveResult = {
  disposition: "moved" | "unchanged" | "not_found" | "anchor_not_found" | "held";
  entryId: string;
  /** Dispatch order after the move, when the entry's FIFO still exists. */
  entryIds?: string[];
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
};

export type ThreadTurnQueuePauseResult = {
  /** `held`: a held entry waits on the operator's Retry and cannot pause. */
  disposition: "updated" | "unchanged" | "not_found" | "held";
  entryId: string;
  /** The entry after the request, while it is still queued. */
  entry?: ThreadTurnQueueEntry;
};

export type ThreadTurnQueueLifecycleEvent =
  | {
      type: "queued";
      entry: ThreadTurnQueueEntry;
      position: number;
      inputUpdated?: boolean;
    }
  | {
      type: "started";
      entry: ThreadTurnQueueEntry;
      turnId: string;
    }
  | {
      type: "failed";
      entry: ThreadTurnQueueEntry;
      error: Error;
    }
  | {
      /**
       * A queued entry could not start and remains at the front of its FIFO.
       * It is held until an operator explicitly retries it.
       */
      type: "blocked";
      entry: ThreadTurnQueueEntry;
      error: Error;
    }
  | {
      type: "held";
      entry: ThreadTurnQueueEntry;
      position: number;
      reason: string;
    }
  | {
      type: "cancelled";
      entry: ThreadTurnQueueEntry;
      reason?: string;
    }
  | {
      type: "terminal";
      entry: ThreadTurnQueueEntry;
      turnId?: string;
      status?: string;
    };

export type ThreadTurnQueueOptions = {
  startTurn: (entry: ThreadTurnQueueEntry) => Promise<ThreadTurnQueueStartResult>;
  canSteerThread?: (entry: ThreadTurnQueueEntry) => boolean;
  steerTurn?: (entry: ThreadTurnQueueEntry) => Promise<ThreadTurnQueueStartResult | "retry" | undefined>;
  isThreadActive?: (params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
  }) => boolean;
  /**
   * Whether a gate outside the queue keeps this entry from starting or
   * steering now (the quiet-restart gate). A held entry keeps its place and
   * starts on a later drain; `drainAll` follows the gate opening.
   */
  isDispatchHeld?: (entry: ThreadTurnQueueDispatchCandidate) => boolean;
  onLifecycle?: (event: ThreadTurnQueueLifecycleEvent) => void | Promise<void>;
  now?: () => number;
};

/** An entry about to start, or a thread a new entry would start on. */
export type ThreadTurnQueueDispatchCandidate = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  id?: string;
  restartContinuation?: true;
};

type RunningEntry = {
  entry: ThreadTurnQueueEntry;
  turnId?: string;
};

type ThreadTurnQueueReleaseParams = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId?: string;
  status?: string;
  errorMessage?: string;
};

type AdmittedEntry = {
  entryId: string;
  turnId?: string;
};

type StartNextResult = "none" | "started" | "blocked";

const RECENT_ADMITTED_ENTRY_LIMIT = 1_000;
const RECENT_TERMINAL_TURN_LIMIT = 1_000;

function groupedAgentInput(messages: QueuedAgentMessage[]): AppServerTurnInputItem[] {
  if (messages.length === 1) return structuredClone(messages[0]!.input);
  return messages.flatMap((message, index) => {
    const source = message.origin?.sourceThread;
    const context = source
      ? `${source.title ?? source.threadId} (${source.backend}, thread ${source.threadId}${source.instanceId ? `, instance ${source.instanceLabel ?? source.instanceId}` : ""})`
      : "Operator-edited guidance";
    return [
      { type: "text" as const, text: `Message ${index + 1} from ${context}\nReceived: ${new Date(message.receivedAt).toISOString()}` },
      ...structuredClone(message.input),
    ];
  });
}

/** Whether the FIFO holds an entry that dispatch would start. */
function hasWaitingEntry(queue: readonly ThreadTurnQueueEntry[]): boolean {
  return queue.some((entry) => !entry.paused);
}

/** The entry dispatch starts next: the first one that is not paused. */
function nextWaitingIndex(queue: readonly ThreadTurnQueueEntry[]): number {
  return queue.findIndex((entry) => !entry.paused);
}

/**
 * Puts an entry that could not start back where it was: right after the
 * paused entry it sat behind, or at the front when none did. Its neighbors
 * keep their order even if that entry was resumed or new ones arrived while
 * the start was in flight. If that entry has gone, the restored one goes in
 * front of the first entry that is not paused.
 */
function restoreAfter(
  queue: ThreadTurnQueueEntry[],
  entry: ThreadTurnQueueEntry,
  previousId: string | undefined,
): void {
  if (previousId === undefined) {
    queue.unshift(entry);
    return;
  }
  const previous = queue.findIndex((candidate) => candidate.id === previousId);
  const index = previous >= 0 ? previous + 1 : nextWaitingIndex(queue);
  queue.splice(index < 0 ? queue.length : index, 0, entry);
}

export class ThreadTurnQueue {
  private readonly queuedEntries = new Map<string, ThreadTurnQueueEntry[]>();
  private readonly admissions = new Map<string, QueueAdmission>();
  private readonly runningEntries = new Map<string, RunningEntry>();
  private readonly recentlyAdmittedEntries = new Map<string, AdmittedEntry>();
  private readonly recentlyProcessedTerminals = new Set<string>();
  private readonly releasingKeys = new Set<string>();
  private readonly pendingReleaseKeys = new Set<string>();
  /**
   * Why each held FIFO is held, oldest first. Kinds of hold release
   * differently: unlocking drops only a lock's refusal, and Retry drops
   * them all. Each held entry keeps the reason it was held for. `revision`
   * changes with each hold, so a start in flight can tell one arrived.
   */
  private readonly heldQueues = new Map<string, { reasons: string[]; revision: number }>();
  private holdRevision = 0;
  private readonly dispatchSuspensions = new Map<string, number>();
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly drainTimers = new Map<string, ReturnType<typeof setImmediate>>();
  private closed = false;

  constructor(private readonly options: ThreadTurnQueueOptions) {}

  /** Suspend the entire FIFO before awaiting an edit, including queued editors. */
  async withDispatchSuspended<T>(
    params: { backend: AppServerBackendKind; threadId: ThreadIdentifier },
    edit: () => T | Promise<T>,
  ): Promise<T> {
    const key = this.keyFor(params);
    this.dispatchSuspensions.set(key, (this.dispatchSuspensions.get(key) ?? 0) + 1);
    const previous = this.mutationTails.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const tail = new Promise<void>((resolve) => { unlock = resolve; });
    this.mutationTails.set(key, tail);
    try {
      await previous;
      return await edit();
    } finally {
      unlock();
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key);
      const remaining = (this.dispatchSuspensions.get(key) ?? 1) - 1;
      if (remaining) this.dispatchSuspensions.set(key, remaining);
      else {
        this.dispatchSuspensions.delete(key);
        this.scheduleDrain(key);
      }
    }
  }

  async submitGroupedSteer(
    input: Omit<ThreadTurnQueueEntry, "id" | "createdAt"> &
      Partial<Pick<ThreadTurnQueueEntry, "id" | "createdAt">>,
    options?: { deferStart?: boolean; onAdmission?: () => void },
  ): Promise<ThreadTurnQueueSubmissionResult> {
    const message: QueuedAgentMessage = {
      input: structuredClone(input.input),
      origin: structuredClone(input.messageOrigin),
      receivedAt: this.now(),
    };
    return await this.withDispatchSuspended(input, async () => {
      const key = this.keyFor(input);
      const queue = this.queueFor(key);
      // A paused batch keeps the messages it has; a new one starts beside it.
      const index = queue.findIndex((entry) =>
        entry.delivery === "queued-steer" && entry.agentMessages !== undefined && !entry.paused
      );
      const current = index >= 0 ? queue[index] : undefined;
      const messages = [...(current?.agentMessages ?? []), message];
      const holdReason = this.holdReasonFor(key);
      // A title named the batch before this message joined it.
      const { title: _staleTitle, ...base } = current ?? input;
      // A to-do marker labels one message. A batch keeps each message's own
      // origin in agentMessages, so the batch origin must not claim it.
      const { threadTodo: _threadTodo, ...batchOrigin }: Partial<AppServerThreadMessageOrigin> =
        input.messageOrigin ?? {};
      const entry: ThreadTurnQueueEntry = {
        ...base,
        id: current?.id ?? input.id ?? `thread-turn:${randomUUID()}`,
        createdAt: current?.createdAt ?? input.createdAt ?? message.receivedAt,
        delivery: "queued-steer",
        agentMessages: messages,
        agentMessageOrigins: [
          ...(current?.agentMessageOrigins ?? []),
          ...(message.origin ? [message.origin] : []),
        ],
        input: groupedAgentInput(messages),
        messageOrigin: { ...(messages.length > 1 ? batchOrigin : input.messageOrigin), kind: "agent",
          ...mergeCausalMessagingContext(current ? [current.messageOrigin, message.origin] : [message.origin]) },
        ...(holdReason ? { manualReleaseRequired: true, holdReason } : {}),
      };
      if (
        !options?.deferStart
        && !current
        && !hasWaitingEntry(queue)
        && this.dispatchSuspensions.get(key) === 1
        && !this.admissions.has(key)
        && !this.runningEntries.has(key)
        && !this.heldQueues.has(key)
        && !(this.options.isThreadActive?.(entry) ?? false)
        && !this.isDispatchHeld(entry)
      ) {
        const starting = this.startEntry(entry);
        options?.onAdmission?.();
        const started = await starting;
        return { status: "started", entry, turnId: started.turnId };
      }
      if (current) queue[index] = entry;
      else queue.push(entry);
      options?.onAdmission?.();
      const position = current ? index + 1 : queue.length;
      await this.emit({ type: "queued", entry, position, ...(current ? { inputUpdated: true } : {}) });
      return { status: "queued", entry, position };
    });
  }

  /**
   * Admits one message that joins the running turn once it reaches the FIFO
   * head, and otherwise starts the next turn, as a composer reply that steers
   * would. It is its own entry, so a grouped steer never absorbs it.
   */
  async submitSteer(
    input: Omit<ThreadTurnQueueEntry, "id" | "createdAt" | "delivery" | "agentMessages"> &
      Partial<Pick<ThreadTurnQueueEntry, "id" | "createdAt">>,
    options?: { onAdmission?: () => void },
  ): Promise<ThreadTurnQueueSubmissionResult> {
    return await this.withDispatchSuspended(input, async () => {
      const key = this.keyFor(input);
      const queue = this.queueFor(key);
      const holdReason = this.holdReasonFor(key);
      const entry: ThreadTurnQueueEntry = {
        ...input,
        id: input.id ?? `thread-turn:${randomUUID()}`,
        createdAt: input.createdAt ?? this.now(),
        delivery: "queued-steer",
        ...(holdReason ? { manualReleaseRequired: true, holdReason } : {}),
      };
      if (
        !hasWaitingEntry(queue)
        && this.dispatchSuspensions.get(key) === 1
        && !this.admissions.has(key)
        && !this.runningEntries.has(key)
        && !holdReason
        && !(this.options.isThreadActive?.(entry) ?? false)
        && !this.isDispatchHeld(entry)
      ) {
        const starting = this.startEntry(entry);
        options?.onAdmission?.();
        const started = await starting;
        return { status: "started", entry, turnId: started.turnId };
      }
      // The drain that ends this suspension steers it when it is the head.
      queue.push(entry);
      options?.onAdmission?.();
      const position = queue.length;
      await this.emit({ type: "queued", entry, position });
      return { status: "queued", entry, position };
    });
  }

  close(): void {
    this.closed = true;
    for (const timer of this.drainTimers.values()) clearImmediate(timer);
    this.drainTimers.clear();
  }

  async submit(
    input: Omit<ThreadTurnQueueEntry, "id" | "createdAt"> &
      Partial<Pick<ThreadTurnQueueEntry, "id" | "createdAt">>,
    options?: {
      onAdmission?: () => void;
      /** Zero-based replacement position captured under withDispatchSuspended. */
      queueIndex?: number;
    },
  ): Promise<ThreadTurnQueueSubmissionResult> {
    const entry: ThreadTurnQueueEntry = {
      ...input,
      id: input.id ?? `thread-turn:${randomUUID()}`,
      createdAt: input.createdAt ?? this.now(),
    };
    const key = this.keyFor(entry);

    if (!this.canStartImmediately({ backend: entry.backend, threadId: entry.threadId })) {
      const queue = this.queueFor(key);
      const holdReason = this.holdReasonFor(key);
      const queuedEntry = holdReason && !entry.manualReleaseRequired
        ? {
            ...entry,
            manualReleaseRequired: true,
            holdReason,
          }
        : entry;
      const index = Math.min(options?.queueIndex ?? queue.length, queue.length);
      queue.splice(index, 0, queuedEntry);
      options?.onAdmission?.();
      const position = index + 1;
      await this.emit({ type: "queued", entry: queuedEntry, position });
      return { status: "queued", entry: queuedEntry, position };
    }

    const starting = this.startEntry(entry);
    options?.onAdmission?.();
    const started = await starting;
    return {
      status: "started",
      entry,
      turnId: started.turnId,
    };
  }

  async submitHeld(
    input: Omit<ThreadTurnQueueEntry, "id" | "createdAt"> &
      Partial<Pick<ThreadTurnQueueEntry, "id" | "createdAt">>,
    reason: string,
    options?: {
      onAdmission?: () => void;
      /** Zero-based replacement position captured under withDispatchSuspended. */
      queueIndex?: number;
    },
  ): Promise<Extract<ThreadTurnQueueSubmissionResult, { status: "queued" }>> {
    const entry: ThreadTurnQueueEntry = {
      ...input,
      id: input.id ?? `thread-turn:${randomUUID()}`,
      createdAt: input.createdAt ?? this.now(),
      manualReleaseRequired: true,
      holdReason: reason,
    };
    const existing = this.findQueuedEntry(entry.id);
    if (existing) {
      if (
        existing.entry.backend !== entry.backend
        || existing.entry.threadId !== entry.threadId
        || JSON.stringify(existing.entry.input) !== JSON.stringify(entry.input)
      ) {
        throw new Error(`Queued turn id ${entry.id} was reused with different input`);
      }
      options?.onAdmission?.();
      return {
        status: "queued",
        entry: existing.entry,
        position: existing.position,
      };
    }

    const key = this.keyFor(entry);
    const queue = this.queueFor(key);
    // On a held FIFO a held entry joins the back, so held entries go in the
    // order they arrived. Otherwise it goes ahead of the turns waiting, and
    // its hold then covers them, though never ahead of a restart continuation.
    const leadingContinuations = queue.findIndex((queued) => !queued.restartContinuation);
    const index = options?.queueIndex ?? (this.heldQueues.has(key)
      ? queue.length
      : leadingContinuations < 0 ? queue.length : leadingContinuations);
    this.addHoldReason(key, reason);
    queue.splice(index, 0, entry);
    options?.onAdmission?.();
    // Entries already held keep their own reason, so each still releases
    // the way it was held. Cover the pre-existing FIFO before any publication
    // can cancel this new row and drain its unreviewed successors.
    await this.holdQueue(key, reason, { keepHeld: true });
    const held = this.findQueuedEntry(entry.id);
    // A hold observer can cancel, release or replace this row. Its newer
    // event owns the projection; do not publish this admission over it.
    if (held?.entry === entry) {
      await this.emit({ type: "queued", entry, position: held.position });
    }
    const current = this.findQueuedEntry(entry.id);
    return {
      status: "queued",
      entry: current?.entry ?? entry,
      position: current?.position ?? index + 1,
    };
  }

  /**
   * Queue a wake-up that its paused project holds. Unlike `submitHeld`, this
   * holds only the entry: it waits paused at the back of the FIFO, so turns
   * the operator sends start or queue as usual. Reusing an id that is still
   * queued returns that entry.
   */
  async submitProjectHeld(
    input: Omit<ThreadTurnQueueEntry, "id" | "createdAt" | "paused" | "pauseRevision" | "holdReason" | "projectHold"> &
      Partial<Pick<ThreadTurnQueueEntry, "id" | "createdAt">>,
    hold: { reason: string; projectHold: ThreadTurnQueueProjectHold },
    options?: { onAdmission?: () => void },
  ): Promise<Extract<ThreadTurnQueueSubmissionResult, { status: "queued" }>> {
    const entry: ThreadTurnQueueEntry = {
      ...input,
      id: input.id ?? `thread-turn:${randomUUID()}`,
      createdAt: input.createdAt ?? this.now(),
      paused: true,
      pauseRevision: 1,
      holdReason: hold.reason,
      projectHold: hold.projectHold,
    };
    const existing = this.findQueuedEntry(entry.id);
    if (existing) {
      options?.onAdmission?.();
      return { status: "queued", entry: existing.entry, position: existing.position };
    }
    const queue = this.queueFor(this.keyFor(entry));
    queue.push(entry);
    options?.onAdmission?.();
    const position = queue.length;
    await this.emit({ type: "queued", entry, position });
    return { status: "queued", entry, position };
  }

  /**
   * Puts back project-held wake-ups that an earlier process held, at
   * startup and before any window reads the queue, so it emits nothing.
   * They wait paused at the back of their FIFOs in hold order. An id that
   * is already queued is skipped.
   */
  restoreProjectHeld(
    entries: ReadonlyArray<Omit<ThreadTurnQueueEntry, "paused" | "pauseRevision"> & {
      holdReason: string;
      projectHold: ThreadTurnQueueProjectHold;
    }>,
  ): ThreadTurnQueueEntry[] {
    const restored: ThreadTurnQueueEntry[] = [];
    for (const input of [...entries].sort((left, right) => left.createdAt - right.createdAt)) {
      if (this.findQueuedEntry(input.id)) continue;
      const entry: ThreadTurnQueueEntry = { ...input, paused: true, pauseRevision: 1 };
      this.queueFor(this.keyFor(entry)).push(entry);
      restored.push(entry);
    }
    return restored;
  }

  /**
   * Atomically reject instead of queueing when the thread is busy. The
   * availability check and admission attempt claim happen in the same JS turn,
   * so another submit cannot slip between them and push this entry on deck.
   */
  async submitIfIdle(
    input: Omit<ThreadTurnQueueEntry, "id" | "createdAt"> &
      Partial<Pick<ThreadTurnQueueEntry, "id" | "createdAt">>,
    options?: { onAdmission?: () => void },
  ): Promise<ThreadTurnQueueImmediateSubmissionResult> {
    const entry: ThreadTurnQueueEntry = {
      ...input,
      id: input.id ?? `thread-turn:${randomUUID()}`,
      createdAt: input.createdAt ?? this.now(),
    };
    if (!this.canStartImmediately({
      backend: entry.backend,
      threadId: entry.threadId,
    })) {
      options?.onAdmission?.();
      return { status: "busy" };
    }
    const starting = this.startEntry(entry);
    options?.onAdmission?.();
    const started = await starting;
    return {
      status: "started",
      entry,
      turnId: started.turnId,
    };
  }

  canStartImmediately(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
  }): boolean {
    const key = this.keyFor(params);
    return (
      !this.admissions.has(key) &&
      !this.dispatchSuspensions.has(key) &&
      !this.runningEntries.has(key) &&
      !this.heldQueues.has(key) &&
      !hasWaitingEntry(this.queueFor(key)) &&
      !(this.options.isThreadActive?.(params) ?? false) &&
      !this.isDispatchHeld({ backend: params.backend, threadId: params.threadId })
    );
  }

  /**
   * Puts back the continuations of turns a quiet restart stopped, at
   * startup and before any window reads the queue, so it emits nothing.
   * Each goes to the top of its thread's FIFO, ahead of anything queued
   * there. An id that is already queued is skipped.
   */
  restoreRestartContinuations(
    entries: ReadonlyArray<Omit<ThreadTurnQueueEntry, "restartContinuation" | "paused" | "pauseRevision">>,
  ): ThreadTurnQueueEntry[] {
    const restored: ThreadTurnQueueEntry[] = [];
    for (const input of [...entries].sort((left, right) => right.createdAt - left.createdAt)) {
      if (this.findQueuedEntry(input.id)) continue;
      const entry: ThreadTurnQueueEntry = { ...input, restartContinuation: true };
      this.queueFor(this.keyFor(entry)).unshift(entry);
      restored.unshift(entry);
    }
    return restored;
  }

  /**
   * Puts back messages that waited in thread queues when a quiet restart
   * stopped the app, at startup and before any window reads the queue, so
   * it emits nothing. Each joins the back of its FIFO in the order given,
   * which is the order they waited, behind the thread's continuation. An id
   * that is already queued is skipped.
   */
  restoreQueued(
    entries: ReadonlyArray<Omit<ThreadTurnQueueEntry, "restartContinuation" | "pauseRevision">>,
  ): ThreadTurnQueueEntry[] {
    const restored: ThreadTurnQueueEntry[] = [];
    for (const input of entries) {
      if (this.findQueuedEntry(input.id)) continue;
      const entry: ThreadTurnQueueEntry = input.paused
        ? { ...input, paused: true, pauseRevision: 1 }
        : input;
      this.queueFor(this.keyFor(entry)).push(entry);
      restored.push(entry);
    }
    return restored;
  }

  /** Recheck every FIFO, after a gate outside the queue opens. */
  drainAll(): void {
    for (const key of this.queuedEntries.keys()) this.scheduleDrain(key);
  }

  getQueuedEntries(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
  }): ThreadTurnQueueEntry[] {
    return [...this.queueFor(this.keyFor(params))];
  }

  /** Synchronous projection reads borrow entries without cloning the complete FIFO. */
  *iterateQueuedEntries(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
  }): IterableIterator<ThreadTurnQueueEntry> {
    yield* this.queueFor(this.keyFor(params));
  }

  getAllQueuedEntries(): ThreadTurnQueueEntry[] {
    return [...this.queuedEntries.values()].flatMap((queue) => [...queue]);
  }

  cancelEntry(entryId: string, reason?: string, options?: { retainQueueHold?: boolean }): ThreadTurnQueueEntry | undefined {
    for (const [key, queue] of this.queuedEntries.entries()) {
      const index = queue.findIndex((entry) => entry.id === entryId);
      if (index === -1) continue;
      const [entry] = queue.splice(index, 1);
      if (queue.length === 0) this.queuedEntries.delete(key);
      if (!options?.retainQueueHold) this.dropSpentHold(key);
      if (entry) {
        void this.emit({ type: "cancelled", entry, reason });
      }
      if (index === 0 && queue.length > 0) this.scheduleDrain(key);
      return entry;
    }
    return undefined;
  }

  /**
   * Moves a waiting entry in front of `beforeEntryId`, or to the end of its
   * FIFO when that is omitted. A held entry stays where it is, and nothing
   * moves in front of one: a hold waits on the operator's Retry. Dispatch is
   * suspended for the move, so the head cannot start between the lookup and
   * the splice; the drain that ends the suspension starts the new head.
   */
  async moveEntry(
    entryId: string,
    beforeEntryId?: string,
  ): Promise<ThreadTurnQueueMoveResult> {
    const found = this.findQueuedEntry(entryId);
    if (!found) return { disposition: "not_found", entryId };
    const { backend, threadId } = found.entry;
    return await this.withDispatchSuspended(found.entry, () => {
      // Not queueFor: the FIFO can have drained while the move waited, and
      // a lookup must not leave an empty one behind.
      const queue = this.queuedEntries.get(found.key) ?? [];
      const result = (
        disposition: ThreadTurnQueueMoveResult["disposition"],
      ): ThreadTurnQueueMoveResult => ({
        disposition,
        entryId,
        entryIds: queue.map((entry) => entry.id),
        backend,
        threadId,
      });
      // The suspension waited for earlier edits; any of them can have
      // started, cancelled or moved this entry.
      const from = queue.findIndex((entry) => entry.id === entryId);
      const entry = queue[from];
      if (!entry) return { disposition: "not_found", entryId };
      // A restart continuation stays on top until it starts: the restart
      // gate holds everything behind it, so nothing may pass it.
      if (entry.manualReleaseRequired || entry.restartContinuation) return result("held");
      if (beforeEntryId === entryId) return result("unchanged");
      const anchor = beforeEntryId === undefined
        ? queue.length
        : queue.findIndex((candidate) => candidate.id === beforeEntryId);
      if (anchor < 0) return result("anchor_not_found");
      const passed = anchor > from
        ? queue.slice(from + 1, anchor)
        : queue.slice(anchor, from);
      if (passed.some((candidate) => candidate.manualReleaseRequired || candidate.restartContinuation)) {
        return result("held");
      }
      const to = anchor > from ? anchor - 1 : anchor;
      if (to === from) return result("unchanged");
      queue.splice(from, 1);
      queue.splice(to, 0, entry);
      return result("moved");
    });
  }

  /**
   * Pauses or resumes a waiting entry. A paused entry keeps its place and
   * dispatch passes over it; resuming it lets the drain that ends this
   * suspension start it when nothing is ahead of it. A held entry waits on
   * Retry and does not pause, though a paused entry that a hold reached can
   * still resume.
   */
  async setEntryPaused(
    entryId: string,
    paused: boolean,
  ): Promise<ThreadTurnQueuePauseResult> {
    const found = this.findQueuedEntry(entryId);
    if (!found) return { disposition: "not_found", entryId };
    return await this.withDispatchSuspended(found.entry, () => {
      // The suspension waited for earlier edits; any of them can have
      // started or cancelled this entry.
      const queue = this.queuedEntries.get(found.key) ?? [];
      const index = queue.findIndex((entry) => entry.id === entryId);
      const entry = queue[index];
      if (!entry) return { disposition: "not_found", entryId };
      if (Boolean(entry.paused) === paused) {
        return { disposition: "unchanged", entryId, entry };
      }
      if (paused && entry.manualReleaseRequired) {
        return { disposition: "held", entryId, entry };
      }
      const { paused: _previous, ...rest } = entry;
      const pauseRevision = (entry.pauseRevision ?? 0) + 1;
      // Resuming a project-held wake-up is the operator sending it, so it
      // stops reading as held.
      const { projectHold: _projectHold, holdReason: _holdReason, ...released } = rest;
      // A held FIFO still holds it. A project hold put it there without
      // the queue's hold, which it takes up now.
      const updated: ThreadTurnQueueEntry = paused
        ? { ...rest, paused: true, pauseRevision }
        : entry.projectHold
          ? this.heldByQueue(found.key, { ...released, pauseRevision })
          : { ...rest, pauseRevision };
      queue[index] = updated;
      return { disposition: "updated", entryId, entry: updated };
    });
  }

  cancelEntryWithDisposition(
    entryId: string,
    reason?: string,
  ): ThreadTurnQueueCancellationResult {
    const cancelled = this.cancelEntry(entryId, reason);
    if (cancelled) {
      return {
        disposition: "cancelled",
        entry: cancelled,
      };
    }
    const admitted = this.recentlyAdmittedEntries.get(entryId);
    if (admitted) {
      return {
        disposition: "already_admitted",
        entryId: admitted.entryId,
        ...(admitted.turnId ? { turnId: admitted.turnId } : {}),
      };
    }
    return { disposition: "not_found" };
  }

  updateQueuedEntryInput(
    entryId: string,
    input: AppServerTurnInputItem[],
    sourceTurn?: Pick<NonNullable<AppServerThreadMessageOrigin["sourceThread"]>, "turnId" | "rootTurnId">,
  ): ThreadTurnQueueEntry | undefined {
    for (const queue of this.queuedEntries.values()) {
      const index = queue.findIndex((entry) => entry.id === entryId);
      if (index === -1) continue;
      const current = queue[index];
      if (!current) return undefined;
      // The title named the input being replaced.
      const { title: _staleTitle, ...rest } = current;
      const updated = {
        ...rest,
        input,
        ...(sourceTurn && current.messageOrigin?.sourceThread ? {
          messageOrigin: {
            ...current.messageOrigin,
            sourceThread: {
              ...current.messageOrigin.sourceThread,
              turnId: sourceTurn.turnId,
              rootTurnId: sourceTurn.rootTurnId,
            },
          },
        } : {}),
        // An operator edit replaces the complete batch. Do not subsequently
        // rebuild it from stale per-sender input when another message arrives.
        ...(current.agentMessages ? { agentMessages: undefined } : {}),
      };
      queue[index] = updated;
      return updated;
    }
    return undefined;
  }

  async replaceQueuedAgentInput(
    entryId: string,
    input: AppServerTurnInputItem[],
    sender: NonNullable<AppServerThreadMessageOrigin["sourceThread"]>,
    origin?: AppServerThreadMessageOrigin,
  ): Promise<ThreadTurnQueueEntry | undefined> {
    const found = this.findQueuedEntry(entryId, sender);
    if (!found) return undefined;
    return await this.withDispatchSuspended(found.entry, async () => {
      const current = this.findQueuedEntry(entryId, sender);
      if (!current || this.closed || (current.entry.agentMessageOrigins && !current.entry.agentMessages)) return undefined;
      const owns = (source: AppServerThreadMessageOrigin["sourceThread"]) => source
        && source.backend === sender.backend && source.threadId === sender.threadId
        && source.instanceId === sender.instanceId;
      const entry = current.entry;
      if (entry.messageOrigin?.kind !== "agent") return undefined;
      const replacementId = `thread-turn:${randomUUID()}`;
      let replaced = false;
      const messages = entry.agentMessages?.flatMap((message) => {
        if (!owns(message.origin?.sourceThread)) return [{ ...message, replacementHandle: message.replacementHandle ?? entry.id }];
        if (replaced) return [];
        replaced = true;
        return [{ ...message, replacementHandle: replacementId, input: structuredClone(input), receivedAt: this.now(), ...(origin ? { origin: structuredClone(origin) } : {}) }];
      });
      if (messages ? !replaced : !owns(entry.messageOrigin.sourceThread)) return undefined;
      const { id: _oldId, createdAt: _oldCreatedAt, title: _staleTitle, ...rest } = entry;
      const messageOrigin = structuredClone(origin && owns(entry.messageOrigin.sourceThread) ? origin : entry.messageOrigin);
      const replacement = {
        ...rest,
        id: replacementId,
        input: messages ? groupedAgentInput(messages) : structuredClone(input),
        messageOrigin: messages ? { ...messageOrigin, kind: "agent" as const,
          causalMessagingSource: undefined, causalMessagingAmbiguous: undefined,
          ...mergeCausalMessagingContext(messages.map(message => message.origin)) } : messageOrigin,
        ...(messages ? { agentMessages: messages,
          agentMessageOrigins: messages.flatMap(message => message.origin ? [message.origin] : []) } : {}),
      };
      // Retire the immutable acceptance before admitting changed input. Keep
      // the FIFO's independent holds through this synchronous empty boundary.
      this.cancelEntry(entry.id, "Replaced before dispatch", { retainQueueHold: true });
      if (this.closed) { this.dropSpentHold(current.key); return undefined; }
      const result = await this.submit(replacement, { queueIndex: current.position - 1 });
      return result.entry;
    });
  }

  /** Sets a still-queued entry's display title. Undefined once it has left. */
  setQueuedEntryTitle(
    entryId: string,
    title: string,
  ): ThreadTurnQueueEntry | undefined {
    for (const queue of this.queuedEntries.values()) {
      const index = queue.findIndex((entry) => entry.id === entryId);
      if (index === -1) continue;
      const current = queue[index];
      if (!current) return undefined;
      // Display metadata does not replace the entry's lifecycle identity.
      // Pending hold/release events still belong to this same queued input.
      current.title = title;
      return current;
    }
    return undefined;
  }

  /**
   * Drops a thread's hold reasons that pass `shouldRelease`, and drains the
   * queue once the thread is idle. Other reasons keep holding: an entry held
   * for a dropped reason takes the reason of the nearest entry ahead that is
   * still held, and is released when none is. Returns whether a reason was
   * dropped.
   */
  async releaseHold(
    params: { backend: AppServerBackendKind; threadId: string },
    shouldRelease: (reason: string) => boolean,
  ): Promise<boolean> {
    const key = this.keyFor(params);
    const hold = this.heldQueues.get(key);
    if (!hold?.reasons.some(shouldRelease)) return false;
    // Publication can await a newer failure's held events. Keep pending
    // drains out until that publication finishes covering the live FIFO.
    // Do not serialize lifecycle callbacks: they may release another cause.
    this.dispatchSuspensions.set(key, (this.dispatchSuspensions.get(key) ?? 0) + 1);
    try {
      const queue = this.queuedEntries.get(key) ?? [];
      const kept = new Set<string>();
      const updatedEntries: ThreadTurnQueueEntry[] = [];
      let ahead: string | undefined;
      for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index];
        if (!current?.manualReleaseRequired) continue;
        if (current.holdReason !== undefined && !shouldRelease(current.holdReason)) {
          ahead = current.holdReason;
          kept.add(ahead);
          continue;
        }
        const updated: ThreadTurnQueueEntry = ahead
          ? { ...current, holdReason: ahead }
          : { ...current, manualReleaseRequired: undefined, holdReason: undefined };
        queue[index] = updated;
        updatedEntries.push(updated);
      }
      // Commit this release before publication can admit another independent
      // hold. Its new reasons and entries must not be replaced by this snapshot.
      // A reason no held entry carries any more has nothing left to hold.
      const reasons = hold.reasons.filter((reason) => kept.has(reason));
      if (reasons.length > 0) this.heldQueues.set(key, { ...hold, reasons });
      else this.heldQueues.delete(key);
      for (const released of updatedEntries) {
        const live = this.queuedEntries.get(key);
        const index = live?.findIndex(entry => entry.id === released.id) ?? -1;
        const entry = live?.[index];
        // A title or input refresh keeps this release's transition. A newer
        // hold/release or cancellation owns any different live hold state.
        if (!entry || entry.manualReleaseRequired !== released.manualReleaseRequired
          || entry.holdReason !== released.holdReason) continue;
        await this.emit(entry.manualReleaseRequired && entry.holdReason !== undefined
          ? { type: "held", entry, position: index + 1, reason: entry.holdReason }
          : { type: "queued", entry, position: index + 1 });
      }
      return true;
    } finally {
      const remaining = (this.dispatchSuspensions.get(key) ?? 1) - 1;
      if (remaining) this.dispatchSuspensions.set(key, remaining);
      else {
        this.dispatchSuspensions.delete(key);
        this.scheduleDrain(key);
      }
    }
  }

  async releaseEntryWithDisposition(
    entryId: string,
  ): Promise<ThreadTurnQueueReleaseResult> {
    const found = this.findQueuedEntry(entryId);
    if (!found) {
      return { disposition: "not_found", entryId };
    }
    // Retry answers the entry dispatch would start, which can sit behind
    // paused ones.
    const queue = this.queueFor(found.key);
    if (queue[nextWaitingIndex(queue)]?.id !== entryId) {
      return { disposition: "not_head", entryId };
    }
    // An entry an unlock already released is not held, though entries
    // behind it may be, and its Retry must not release theirs.
    if (!this.heldQueues.has(found.key) || !found.entry.manualReleaseRequired) {
      return { disposition: "not_held", entryId };
    }
    const steer = found.entry.delivery === "queued-steer" && this.options.canSteerThread?.(found.entry);
    if (
      this.closed
      || this.isDispatchHeld(found.entry)
      || this.admissions.has(found.key)
      || this.dispatchSuspensions.has(found.key)
      || (!steer && (this.runningEntries.has(found.key)
        || (this.options.isThreadActive?.(found.entry) ?? false)))
    ) {
      return { disposition: "busy", entryId };
    }

    await this.withDispatchSuspended(found.entry, async () => await this.clearQueueHold(found.key));
    const result = await this.startNext(found.key);
    if (result === "started") {
      const admitted = this.recentlyAdmittedEntries.get(entryId);
      if (admitted?.turnId) {
        return {
          disposition: "started",
          entryId,
          turnId: admitted.turnId,
        };
      }
    }
    if (result === "blocked") {
      return {
        disposition: "blocked",
        entryId,
        error:
          this.lastHoldError(found.key)
          ?? new Error("The queued turn could not be started."),
      };
    }
    return { disposition: "busy", entryId };
  }

  /** Recheck the FIFO after external occupancy changes, preserving running entries and error holds. */
  scheduleThreadDrain(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
  }): void {
    this.scheduleDrain(this.keyFor(params));
  }

  async releaseThread(params: ThreadTurnQueueReleaseParams): Promise<void> {
    const key = this.keyFor(params);
    // Only processed outcomes prove a turn has ended. An admission or
    // an unidentified idle release says nothing about its final outcome.
    if (params.turnId !== undefined
      && this.recentlyProcessedTerminals.has(JSON.stringify([key, params.turnId]))) return;
    const admission = this.admissions.get(key);
    // Buffer identified outcomes through the started callback as well as the
    // backend handoff. Only the acknowledgement proves which turn they end.
    if (params.turnId !== undefined && admission && admission.phase !== "idle" && admission.kind === "start") {
      this.applyAdmission(key, {
        type: "terminal",
        terminal: { turnId: params.turnId, status: params.status, errorMessage: params.errorMessage },
      });
      return;
    }
    const running = this.runningEntries.get(key);
    if (params.turnId !== undefined && running?.turnId !== undefined
      && running.turnId !== params.turnId) return;
    if (this.releasingKeys.has(key)) {
      // Codex commonly follows a terminal event with a status→idle event.
      // Keep only that no-turn-id release if it lands while we are awaiting a
      // queued start. A rejected start emits its own synthetic terminal event
      // with a turn id; coalescing that would retry forever. Replay the idle
      // release only if the queued start rejects. Replaying it after a
      // successful start would let stale idle state terminate the new turn.
      if (params.turnId === undefined) {
        this.pendingReleaseKeys.add(key);
      }
      return;
    }
    this.releasingKeys.add(key);
    let startResult: StartNextResult = "none";
    try {
      await this.settleRelease(key, params);
      startResult = await this.startNext(key);
    } finally {
      this.releasingKeys.delete(key);
      if (
        this.pendingReleaseKeys.delete(key)
        && startResult === "blocked"
      ) {
        void this.releaseThread({
          backend: params.backend,
          threadId: params.threadId,
        });
      }
    }
  }

  private async settleRelease(key: string, params: ThreadTurnQueueReleaseParams): Promise<void> {
    if (params.turnId !== undefined && params.status !== "idle") {
      this.rememberTerminal(key, params.turnId);
    }
    const running = this.runningEntries.get(key);
    const released = running &&
      (params.turnId === undefined ||
        running.turnId === undefined ||
        running.turnId === params.turnId);
    try {
      if (released) {
        // Terminal publication can await controls that schedule a drain. Keep
        // this turn's queue ownership until those observers have settled.
        await this.emit({
          type: "terminal",
          entry: running.entry,
          turnId: params.turnId,
          status: params.status,
        });
      }
    } finally {
      if (released) this.runningEntries.delete(key);
      // Install the failure hold synchronously after retiring ownership,
      // including when terminal publication rejects, before any drain runs.
      if (params.status === "turn/failed") {
        await this.holdAfterTurnFailure(key, params.errorMessage);
      }
    }
  }

  private async startNext(key: string): Promise<StartNextResult> {
    if (this.closed || this.admissions.has(key) || this.dispatchSuspensions.has(key)) return "none";
    const queue = this.queueFor(key);
    const index = nextWaitingIndex(queue);
    const head = queue[index];
    // A held head waits for its release. Entries ahead of every hold, which
    // an unlock released, still start.
    if (!head || head.manualReleaseRequired) return "none";
    if (this.isDispatchHeld(head)) return "none";
    const steer = head.delivery === "queued-steer" && this.options.canSteerThread?.(head);
    if (!steer && (this.runningEntries.has(key)
      || (this.options.isThreadActive?.(head) ?? false))) return "none";
    const previousId = queue[index - 1]?.id;
    const [next] = queue.splice(index, 1);
    if (!next) return "none";
    if (queue.length === 0) this.queuedEntries.delete(key);
    this.dropSpentHold(key);
    const holdRevision = this.heldQueues.get(key)?.revision;
    let accepted = false;
    try {
      if (steer && this.options.steerTurn) {
        // Shift and claim synchronously. The backend now owns this immutable
        // batch; new senders can only append to the next queued steer.
        const attempt = Symbol("queue admission");
        this.applyAdmission(key, { type: "begin", attempt, kind: "steer" });
        this.rememberAdmittedEntry({ entryId: next.id });
        let delivered = false;
        try {
          const result = await this.options.steerTurn(next);
          const admission = this.admissions.get(key);
          if (admission?.phase !== "starting" || admission.attempt !== attempt) return "none";
          if (!result || result === "retry") {
            this.recentlyAdmittedEntries.delete(next.id);
            restoreAfter(this.queueFor(key), next, previousId);
            // A hold that arrived while it was out covers it too.
            const reason = this.holdReasonFor(key);
            if (reason && this.heldQueues.get(key)?.revision !== holdRevision) {
              await this.holdQueue(key, reason, { keepHeld: true });
            }
            if (result === "retry") this.scheduleDrain(key);
            return "none";
          }
          this.applyAdmission(key, { type: "acknowledge", attempt, turnId: result.turnId });
          this.rememberAdmittedEntry({ entryId: next.id, turnId: result.turnId });
          delivered = true;
          accepted = true;
          await this.emit({ type: "started", entry: next, turnId: result.turnId });
          return "started";
        } finally {
          this.applyAdmission(key, { type: "settle", attempt });
          if (delivered || !(this.options.isThreadActive?.(next) ?? false)) this.scheduleDrain(key);
        }
      }
      await this.startEntry(next, { deferFailureEvent: true });
      return "started";
    } catch (error) {
      // Publication cannot put native-accepted guidance back in the FIFO.
      if (accepted) return "started";
      this.recentlyAdmittedEntries.delete(next.id);
      // A rejected start says nothing about whether this thread can safely
      // accept a different queued request. Keep this entry at the FIFO head
      // and require an explicit retry instead of looping on idle signals.
      restoreAfter(this.queueFor(key), next, previousId);
      const normalized = error instanceof Error ? error : new Error(String(error));
      // It holds the entry it could not start and anything not yet held.
      // Entries behind it keep their own reasons: a lock's refusal must not
      // turn a stale steer's hold into one that unlocking releases.
      // Cover every waiting input before a blocked observer can cancel this
      // row and await a drain, including when that observer rejects.
      await this.holdQueue(key, normalized.message, { keepHeld: true });
      const held = this.findQueuedEntry(next.id)?.entry;
      // Hold observers can cancel, release or replace this row's review.
      // Their newer publication must not be overwritten by the old refusal.
      if (held?.manualReleaseRequired && held.holdReason === normalized.message) {
        await this.emit({ type: "blocked", entry: held, error: normalized });
      }
      return "blocked";
    }
  }

  private isDispatchHeld(entry: ThreadTurnQueueDispatchCandidate): boolean {
    return this.options.isDispatchHeld?.(entry) ?? false;
  }

  private scheduleDrain(key: string): void {
    if (this.closed || this.drainTimers.has(key)) return;
    // One event-loop admission window also groups simultaneous local/remote
    // sends before paying for a backend steer.
    const timer = setImmediate(() => {
      this.drainTimers.delete(key);
      void this.startNext(key);
    });
    timer.unref?.();
    this.drainTimers.set(key, timer);
  }

  private async startEntry(
    entry: ThreadTurnQueueEntry,
    options?: { deferFailureEvent?: boolean },
  ): Promise<ThreadTurnQueueStartResult> {
    const key = this.keyFor(entry);
    const attempt = Symbol("queue admission");
    this.applyAdmission(key, { type: "begin", attempt });
    this.rememberAdmittedEntry({ entryId: entry.id });
    let accepted: ThreadTurnQueueStartResult | undefined;
    try {
      const result = await this.options.startTurn(entry);
      accepted = result;
      const admission = this.applyAdmission(key, { type: "acknowledge", attempt, turnId: result.turnId });
      if (admission.phase !== "acknowledged" || admission.attempt !== attempt) return result;
      // Completion may precede the acknowledgement. Publish start then terminal,
      // without resurrecting a running entry for the already completed turn.
      if (!admission.terminal) this.runningEntries.set(key, { entry, turnId: result.turnId });
      this.rememberAdmittedEntry({
        entryId: entry.id,
        turnId: result.turnId,
      });
      try {
        await this.emit({ type: "started", entry, turnId: result.turnId });
      } finally {
        // A terminal buffered during native submission/publication still owns
        // completion even when the started observer rejects.
        const completedAdmission = this.admissions.get(key);
        const terminal = completedAdmission?.phase === "acknowledged" && completedAdmission.attempt === attempt
          ? completedAdmission.terminal : undefined;
        if (terminal) {
          if (admission.terminal) {
            this.rememberTerminal(key, terminal.turnId);
            try {
              await this.emit({ type: "terminal", entry, turnId: terminal.turnId, status: terminal.status });
            } finally {
              if (terminal.status === "turn/failed") {
                await this.holdAfterTurnFailure(key, terminal.errorMessage);
              }
            }
          } else {
            await this.settleRelease(key, { backend: entry.backend, threadId: entry.threadId, ...terminal });
          }
        }
      }
      return result;
    } catch (error) {
      // Once the host transfers native ownership, only publication remains.
      // Keep that accepted identity, including unknown native outcomes, so a
      // caller or queued drain cannot restore/resend its immutable input.
      if (accepted) return accepted;
      this.recentlyAdmittedEntries.delete(entry.id);
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (!options?.deferFailureEvent) {
        // A rejected direct admission has no acknowledgement to match. Keep
        // its terminal failure holds; startNext owns holds for queued starts.
        const admission = this.admissions.get(key);
        if (admission && admission.phase !== "idle" && admission.attempt === attempt) {
          for (const terminal of admission.terminals.values()) {
            if (terminal.status === "turn/failed") {
              this.rememberTerminal(key, terminal.turnId);
              await this.holdAfterTurnFailure(key, terminal.errorMessage);
            }
          }
        }
        await this.emit({ type: "failed", entry, error: normalized });
      }
      throw normalized;
    } finally {
      this.applyAdmission(key, { type: "settle", attempt });
      this.scheduleDrain(key);
    }
  }

  private applyAdmission(key: string, event: QueueAdmissionEvent): QueueAdmission {
    const next = transitionQueueAdmission(this.admissions.get(key) ?? { phase: "idle" }, event);
    if (next.phase === "idle") this.admissions.delete(key);
    else this.admissions.set(key, next);
    return next;
  }

  private queueFor(key: string): ThreadTurnQueueEntry[] {
    const queue = this.queuedEntries.get(key);
    if (queue) return queue;
    const nextQueue: ThreadTurnQueueEntry[] = [];
    this.queuedEntries.set(key, nextQueue);
    return nextQueue;
  }

  private findQueuedEntry(entryId: string, sender?: NonNullable<AppServerThreadMessageOrigin["sourceThread"]>): {
    entry: ThreadTurnQueueEntry;
    key: string;
    position: number;
  } | undefined {
    for (const [key, queue] of this.queuedEntries) {
      const index = queue.findIndex((entry) => entry.id === entryId || (sender && entry.agentMessages?.some(message => {
        const source = message.origin?.sourceThread;
        return message.replacementHandle === entryId && source?.backend === sender.backend
          && source.threadId === sender.threadId && source.instanceId === sender.instanceId;
      })));
      const entry = queue[index];
      if (index >= 0 && entry) {
        return { entry, key, position: index + 1 };
      }
    }
    return undefined;
  }

  private async holdAfterTurnFailure(
    key: string,
    errorMessage?: string,
  ): Promise<void> {
    const reason = errorMessage
      ?? "The previous turn failed. Review the error before retrying queued messages.";
    // An immediate start's release may already have applied this hold.
    if (this.holdReasonFor(key) === reason
      && this.queueFor(key).every((entry) =>
        entry.manualReleaseRequired && entry.holdReason === reason)) return;
    await this.holdQueue(key, reason);
  }

  /**
   * Holds the whole FIFO for `reason`. A failed or refused start holds every
   * entry for review, whatever else held it. With `keepHeld`, an entry that
   * is already held keeps its reason, so a lock's own hold still releases on
   * unlock and a failure's still waits for Retry.
   */
  private async holdQueue(
    key: string,
    reason: string,
    options: { keepHeld?: boolean } = {},
  ): Promise<void> {
    const queue = this.queuedEntries.get(key);
    if (!queue?.length) return;
    this.addHoldReason(key, reason);
    const heldEntries: ThreadTurnQueueEntry[] = [];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!current) continue;
      if (options.keepHeld && current.manualReleaseRequired) continue;
      const held = {
        ...current,
        manualReleaseRequired: true,
        holdReason: reason,
      };
      queue[index] = held;
      heldEntries.push(held);
    }
    // Hold the entire FIFO before publication can cancel or release a row.
    // Later controls own any entries they replace while these events await.
    for (const held of heldEntries) {
      const index = this.queuedEntries.get(key)?.indexOf(held) ?? -1;
      if (index < 0) continue;
      await this.emit({
        type: "held",
        entry: held,
        position: index + 1,
        reason,
      });
    }
  }

  private async clearQueueHold(key: string): Promise<void> {
    this.heldQueues.delete(key);
    const queue = this.queuedEntries.get(key) ?? [];
    // Finish this release before publication yields to another hold. That
    // hold must cover the whole waiting FIFO without retaining old causes.
    const released = queue.map((current) => ({
      ...current,
      manualReleaseRequired: undefined,
      holdReason: undefined,
    }));
    for (let index = 0; index < released.length; index += 1) queue[index] = released[index]!;
    for (const [index, entry] of released.entries()) {
      // Retry answered only the old review. Never publish its release over
      // a newer hold, or resurrect an entry cancelled during publication.
      if (this.heldQueues.has(key)) return;
      const currentIndex = queue[index]?.id === entry.id ? index : queue.findIndex(current => current.id === entry.id);
      const current = queue[currentIndex];
      if (!current || current.manualReleaseRequired) continue;
      await this.emit({ type: "queued", entry: current, position: currentIndex + 1 });
    }
  }

  private lastHoldError(key: string): Error | undefined {
    const reason = this.holdReasonFor(key);
    return reason ? new Error(reason) : undefined;
  }

  /** The newest reason a FIFO is held for: what an entry joining it waits on. */
  private holdReasonFor(key: string): string | undefined {
    return this.heldQueues.get(key)?.reasons.at(-1);
  }

  private addHoldReason(key: string, reason: string): void {
    const reasons = (this.heldQueues.get(key)?.reasons ?? []).filter((current) => current !== reason);
    this.holdRevision += 1;
    this.heldQueues.set(key, { reasons: [...reasons, reason], revision: this.holdRevision });
  }

  /**
   * Ends a FIFO's hold once no entry in it is held: after an unlock released
   * the front, the held ones behind can start, finish or be cancelled.
   */
  private dropSpentHold(key: string): void {
    if (!this.heldQueues.has(key)) return;
    const queue = this.queuedEntries.get(key) ?? [];
    if (!queue.some((entry) => entry.manualReleaseRequired)) this.heldQueues.delete(key);
  }

  /** Holds an entry joining a held FIFO, keeping a reason it already has. */
  private heldByQueue(key: string, entry: ThreadTurnQueueEntry): ThreadTurnQueueEntry {
    const reason = this.holdReasonFor(key);
    if (!reason) return entry;
    return { ...entry, manualReleaseRequired: true, holdReason: entry.holdReason ?? reason };
  }

  private rememberTerminal(key: string, turnId: string): void {
    this.recentlyProcessedTerminals.add(JSON.stringify([key, turnId]));
    while (this.recentlyProcessedTerminals.size > RECENT_TERMINAL_TURN_LIMIT) {
      const oldest = this.recentlyProcessedTerminals.values().next().value;
      if (oldest === undefined) break;
      this.recentlyProcessedTerminals.delete(oldest);
    }
  }

  private rememberAdmittedEntry(entry: AdmittedEntry): void {
    this.recentlyAdmittedEntries.delete(entry.entryId);
    this.recentlyAdmittedEntries.set(entry.entryId, entry);
    while (this.recentlyAdmittedEntries.size > RECENT_ADMITTED_ENTRY_LIMIT) {
      const oldestId = this.recentlyAdmittedEntries.keys().next().value;
      if (typeof oldestId !== "string") break;
      this.recentlyAdmittedEntries.delete(oldestId);
    }
  }

  private keyFor(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
  }): string {
    return buildThreadIdentityKey(params.backend, params.threadId);
  }

  private async emit(event: ThreadTurnQueueLifecycleEvent): Promise<void> {
    await this.options.onLifecycle?.(event);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
