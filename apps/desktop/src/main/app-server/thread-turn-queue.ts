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
  createdAt: number;
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

export type ThreadTurnQueueLifecycleEvent =
  | {
      type: "queued";
      entry: ThreadTurnQueueEntry;
      position: number;
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

const RECENT_ADMITTED_ENTRY_LIMIT = 1_000;

export class ThreadTurnQueue {
  private readonly queuedEntries = new Map<string, ThreadTurnQueueEntry[]>();
  private readonly startingKeys = new Set<string>();
  private readonly runningEntries = new Map<string, RunningEntry>();
  private readonly recentlyAdmittedEntries = new Map<string, AdmittedEntry>();
  private readonly releasingKeys = new Set<string>();

  constructor(private readonly options: ThreadTurnQueueOptions) {}

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
      queue.push(entry);
      const position = queue.length;
      await this.emit({ type: "queued", entry, position });
      return { status: "queued", entry, position };
    }

    const started = await this.startEntry(entry);
    return {
      status: "started",
      entry,
      turnId: started.turnId,
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
      !this.runningEntries.has(key) &&
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
      }
      if (entry) {
        void this.emit({ type: "cancelled", entry, reason });
      }
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
      const updated = {
        ...current,
        input,
      };
      queue[index] = updated;
      return updated;
    }
    return undefined;
  }

  async releaseThread(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
    turnId?: string;
    status?: string;
  }): Promise<void> {
    const key = this.keyFor(params);
    if (this.releasingKeys.has(key)) return;
    this.releasingKeys.add(key);
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
      if (!(this.options.isThreadActive?.(params) ?? false)) {
        await this.startNext(key);
      }
    } finally {
      this.releasingKeys.delete(key);
    }
  }

  private async startNext(key: string): Promise<void> {
    if (this.startingKeys.has(key) || this.runningEntries.has(key)) return;
    const queue = this.queueFor(key);
    const next = queue.shift();
    if (!next) return;
    if (queue.length === 0) {
      this.queuedEntries.delete(key);
    }
    try {
      await this.startEntry(next);
    } catch {
      await this.startNext(key);
    }
  }

  private async startEntry(entry: ThreadTurnQueueEntry): Promise<ThreadTurnQueueStartResult> {
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
      await this.emit({ type: "failed", entry, error: normalized });
      throw normalized;
    } finally {
      this.startingKeys.delete(key);
    }
  }

  private queueFor(key: string): ThreadTurnQueueEntry[] {
    const queue = this.queuedEntries.get(key);
    if (queue) return queue;
    const nextQueue: ThreadTurnQueueEntry[] = [];
    this.queuedEntries.set(key, nextQueue);
    return nextQueue;
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
