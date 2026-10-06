import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  AppServerCollaborationModeRequest,
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
  ThreadExecutionMode,
  ThreadIdentifier,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";

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
   * Display-only label from `queued-message-title.ts`, set after admission
   * for messages too long to show as typed. Never sent with the turn.
   */
  title?: string;
  createdAt: number;
};

type QueuedAgentMessage = {
  input: AppServerTurnInputItem[];
  origin?: AppServerThreadMessageOrigin;
  receivedAt: number;
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
  onLifecycle?: (event: ThreadTurnQueueLifecycleEvent) => void | Promise<void>;
  now?: () => number;
};

type RunningEntry = {
  entry: ThreadTurnQueueEntry;
  turnId?: string;
};

type AdmittedEntry = {
  entryId: string;
  turnId?: string;
};

type StartNextResult = "none" | "started" | "blocked";

const RECENT_ADMITTED_ENTRY_LIMIT = 1_000;

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

export class ThreadTurnQueue {
  private readonly queuedEntries = new Map<string, ThreadTurnQueueEntry[]>();
  private readonly startingKeys = new Set<string>();
  private readonly runningEntries = new Map<string, RunningEntry>();
  private readonly recentlyAdmittedEntries = new Map<string, AdmittedEntry>();
  private readonly releasingKeys = new Set<string>();
  private readonly pendingReleaseKeys = new Set<string>();
  private readonly heldQueues = new Map<string, string>();
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
    options?: { deferStart?: boolean },
  ): Promise<ThreadTurnQueueSubmissionResult> {
    const message: QueuedAgentMessage = {
      input: structuredClone(input.input),
      origin: structuredClone(input.messageOrigin),
      receivedAt: this.now(),
    };
    return await this.withDispatchSuspended(input, async () => {
      const key = this.keyFor(input);
      const queue = this.queueFor(key);
      const index = queue.findIndex((entry) => entry.delivery === "queued-steer" && entry.agentMessages !== undefined);
      const current = index >= 0 ? queue[index] : undefined;
      const messages = [...(current?.agentMessages ?? []), message];
      const holdReason = this.heldQueues.get(key);
      // A title named the batch before this message joined it.
      const { title: _staleTitle, ...base } = current ?? input;
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
        ...(holdReason ? { manualReleaseRequired: true, holdReason } : {}),
      };
      if (
        !options?.deferStart
        && !current
        && queue.length === 0
        && this.dispatchSuspensions.get(key) === 1
        && !this.startingKeys.has(key)
        && !this.runningEntries.has(key)
        && !this.heldQueues.has(key)
        && !(this.options.isThreadActive?.(entry) ?? false)
      ) {
        const started = await this.startEntry(entry);
        return { status: "started", entry, turnId: started.turnId };
      }
      if (current) queue[index] = entry;
      else queue.push(entry);
      const position = current ? index + 1 : queue.length;
      await this.emit({ type: "queued", entry, position, ...(current ? { inputUpdated: true } : {}) });
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
  ): Promise<ThreadTurnQueueSubmissionResult> {
    const entry: ThreadTurnQueueEntry = {
      ...input,
      id: input.id ?? `thread-turn:${randomUUID()}`,
      createdAt: input.createdAt ?? this.now(),
    };
    const key = this.keyFor(entry);

    if (!this.canStartImmediately({ backend: entry.backend, threadId: entry.threadId })) {
      const queue = this.queueFor(key);
      const holdReason = this.heldQueues.get(key);
      const queuedEntry = holdReason
        ? {
            ...entry,
            manualReleaseRequired: true,
            holdReason,
          }
        : entry;
      queue.push(queuedEntry);
      const position = queue.length;
      await this.emit({ type: "queued", entry: queuedEntry, position });
      return { status: "queued", entry: queuedEntry, position };
    }

    const started = await this.startEntry(entry);
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
      return {
        status: "queued",
        entry: existing.entry,
        position: existing.position,
      };
    }

    const key = this.keyFor(entry);
    this.heldQueues.set(key, reason);
    const queue = this.queueFor(key);
    queue.unshift(entry);
    await this.emit({ type: "queued", entry, position: 1 });
    await this.holdQueue(key, reason);
    return {
      status: "queued",
      entry: this.queueFor(key)[0] ?? entry,
      position: 1,
    };
  }

  /**
   * Atomically reject instead of queueing when the thread is busy. The
   * availability check and `startingKeys` claim happen in the same JS turn,
   * so another submit cannot slip between them and push this entry on deck.
   */
  async submitIfIdle(
    input: Omit<ThreadTurnQueueEntry, "id" | "createdAt"> &
      Partial<Pick<ThreadTurnQueueEntry, "id" | "createdAt">>,
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
      return { status: "busy" };
    }
    const started = await this.startEntry(entry);
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
      !this.startingKeys.has(key) &&
      !this.dispatchSuspensions.has(key) &&
      !this.runningEntries.has(key) &&
      !this.heldQueues.has(key) &&
      this.queueFor(key).length === 0 &&
      !(this.options.isThreadActive?.(params) ?? false)
    );
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

  cancelEntry(entryId: string, reason?: string): ThreadTurnQueueEntry | undefined {
    for (const [key, queue] of this.queuedEntries.entries()) {
      const index = queue.findIndex((entry) => entry.id === entryId);
      if (index === -1) continue;
      const [entry] = queue.splice(index, 1);
      if (queue.length === 0) {
        this.queuedEntries.delete(key);
        this.heldQueues.delete(key);
      }
      if (entry) {
        void this.emit({ type: "cancelled", entry, reason });
      }
      if (index === 0 && queue.length > 0) this.scheduleDrain(key);
      return entry;
    }
    return undefined;
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
        // An operator edit replaces the complete batch. Do not subsequently
        // rebuild it from stale per-sender input when another message arrives.
        ...(current.agentMessages ? { agentMessages: undefined } : {}),
      };
      queue[index] = updated;
      return updated;
    }
    return undefined;
  }

  replaceQueuedAgentInput(
    entryId: string,
    input: AppServerTurnInputItem[],
    sender: NonNullable<AppServerThreadMessageOrigin["sourceThread"]>,
  ): ThreadTurnQueueEntry | undefined {
    const found = this.findQueuedEntry(entryId);
    if (!found?.entry.agentMessages) return undefined;
    let replaced = false;
    const messages = found.entry.agentMessages.flatMap((message) => {
      const source = message.origin?.sourceThread;
      if (!source || source.backend !== sender.backend || source.threadId !== sender.threadId
        || source.instanceId !== sender.instanceId) return [message];
      if (replaced) return [];
      replaced = true;
      return [{ ...message, input }];
    });
    if (!replaced) return undefined;
    // The title named the input being replaced.
    const { title: _staleTitle, ...rest } = found.entry;
    const entry = { ...rest, agentMessages: messages, input: groupedAgentInput(messages) };
    this.queueFor(found.key)[found.position - 1] = entry;
    return entry;
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
      const updated = { ...current, title };
      queue[index] = updated;
      return updated;
    }
    return undefined;
  }

  /**
   * Clears a thread's hold when its reason passes `shouldRelease`, and drains
   * the queue once the thread is idle. Returns whether a hold was cleared.
   */
  async releaseHold(
    params: { backend: AppServerBackendKind; threadId: string },
    shouldRelease: (reason: string) => boolean,
  ): Promise<boolean> {
    const key = this.keyFor(params);
    const reason = this.heldQueues.get(key);
    if (!reason || !shouldRelease(reason)) return false;
    await this.clearQueueHold(key);
    this.scheduleDrain(key);
    return true;
  }

  async releaseEntryWithDisposition(
    entryId: string,
  ): Promise<ThreadTurnQueueReleaseResult> {
    const found = this.findQueuedEntry(entryId);
    if (!found) {
      return { disposition: "not_found", entryId };
    }
    if (found.position !== 1) {
      return { disposition: "not_head", entryId };
    }
    if (!this.heldQueues.has(found.key)) {
      return { disposition: "not_held", entryId };
    }
    if (
      this.startingKeys.has(found.key)
      || this.dispatchSuspensions.has(found.key)
      || this.runningEntries.has(found.key)
      || (this.options.isThreadActive?.(found.entry) ?? false)
    ) {
      return { disposition: "busy", entryId };
    }

    await this.withDispatchSuspended(found.entry, async () => await this.clearQueueHold(found.key));
    const result = await this.startNext(found.key);
    if (result === "started") {
      const running = this.runningEntries.get(found.key);
      if (running?.entry.id === entryId && running.turnId) {
        return {
          disposition: "started",
          entryId,
          turnId: running.turnId,
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

  async releaseThread(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
    turnId?: string;
    status?: string;
    errorMessage?: string;
  }): Promise<void> {
    const key = this.keyFor(params);
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
      const running = this.runningEntries.get(key);
      if (
        running &&
        (params.turnId === undefined ||
          running.turnId === undefined ||
          running.turnId === params.turnId)
      ) {
        this.runningEntries.delete(key);
        await this.emit({
          type: "terminal",
          entry: running.entry,
          turnId: params.turnId,
          status: params.status,
        });
      }
      if (params.status === "turn/failed") {
        await this.holdQueue(
          key,
          params.errorMessage
            ?? "The previous turn failed. Review the error before retrying queued messages.",
        );
      }
      if (!this.heldQueues.has(key)) {
        startResult = await this.startNext(key);
      }
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

  private async startNext(key: string): Promise<StartNextResult> {
    if (this.startingKeys.has(key) || this.dispatchSuspensions.has(key)
      || this.heldQueues.has(key)) return "none";
    const queue = this.queueFor(key);
    const head = queue[0];
    if (!head) return "none";
    const steer = head.delivery === "queued-steer" && this.options.canSteerThread?.(head);
    if (!steer && (this.runningEntries.has(key)
      || (this.options.isThreadActive?.(head) ?? false))) return "none";
    const next = queue.shift();
    if (!next) return "none";
    if (queue.length === 0) {
      this.queuedEntries.delete(key);
    }
    try {
      if (steer && this.options.steerTurn) {
        // Shift and claim synchronously. The backend now owns this immutable
        // batch; new senders can only append to the next queued steer.
        this.startingKeys.add(key);
        this.rememberAdmittedEntry({ entryId: next.id });
        let delivered = false;
        try {
          const result = await this.options.steerTurn(next);
          if (!result || result === "retry") {
            this.recentlyAdmittedEntries.delete(next.id);
            this.queueFor(key).unshift(next);
            if (result === "retry") this.scheduleDrain(key);
            return "none";
          }
          this.rememberAdmittedEntry({ entryId: next.id, turnId: result.turnId });
          delivered = true;
          await this.emit({ type: "started", entry: next, turnId: result.turnId });
          return "started";
        } finally {
          this.startingKeys.delete(key);
          if (delivered || !(this.options.isThreadActive?.(next) ?? false)) this.scheduleDrain(key);
        }
      }
      await this.startEntry(next, { deferFailureEvent: true });
      return "started";
    } catch (error) {
      this.recentlyAdmittedEntries.delete(next.id);
      // A rejected start says nothing about whether this thread can safely
      // accept a different queued request. Keep this entry at the FIFO head
      // and require an explicit retry instead of looping on idle signals.
      this.queueFor(key).unshift(next);
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.heldQueues.set(key, normalized.message);
      await this.emit({
        type: "blocked",
        entry: next,
        error: normalized,
      });
      await this.holdQueue(key, normalized.message);
      return "blocked";
    }
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
    this.startingKeys.add(key);
    this.rememberAdmittedEntry({ entryId: entry.id });
    try {
      const result = await this.options.startTurn(entry);
      const running = {
        entry,
        turnId: result.turnId,
      };
      this.runningEntries.set(key, running);
      this.rememberAdmittedEntry({
        entryId: entry.id,
        turnId: result.turnId,
      });
      await this.emit({ type: "started", entry, turnId: result.turnId });
      return result;
    } catch (error) {
      this.recentlyAdmittedEntries.delete(entry.id);
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (!options?.deferFailureEvent) {
        await this.emit({ type: "failed", entry, error: normalized });
      }
      throw normalized;
    } finally {
      this.startingKeys.delete(key);
      this.scheduleDrain(key);
    }
  }

  private queueFor(key: string): ThreadTurnQueueEntry[] {
    const queue = this.queuedEntries.get(key);
    if (queue) return queue;
    const nextQueue: ThreadTurnQueueEntry[] = [];
    this.queuedEntries.set(key, nextQueue);
    return nextQueue;
  }

  private findQueuedEntry(entryId: string): {
    entry: ThreadTurnQueueEntry;
    key: string;
    position: number;
  } | undefined {
    for (const [key, queue] of this.queuedEntries) {
      const index = queue.findIndex((entry) => entry.id === entryId);
      const entry = queue[index];
      if (index >= 0 && entry) {
        return { entry, key, position: index + 1 };
      }
    }
    return undefined;
  }

  private async holdQueue(key: string, reason: string): Promise<void> {
    const queue = this.queuedEntries.get(key);
    if (!queue?.length) return;
    this.heldQueues.set(key, reason);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!current) continue;
      const held = {
        ...current,
        manualReleaseRequired: true,
        holdReason: reason,
      };
      queue[index] = held;
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
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!current) continue;
      const released = {
        ...current,
        manualReleaseRequired: undefined,
        holdReason: undefined,
      };
      queue[index] = released;
      await this.emit({ type: "queued", entry: released, position: index + 1 });
    }
  }

  private lastHoldError(key: string): Error | undefined {
    const reason = this.heldQueues.get(key);
    return reason ? new Error(reason) : undefined;
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
