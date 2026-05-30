import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  AppServerCollaborationModeRequest,
  AppServerTurnInputItem,
  ThreadExecutionMode,
  ThreadIdentifier,
} from "@pwragent/shared";

export type ThreadTurnQueueOrigin = "manual" | "automation" | "messaging";

export type ThreadTurnQueueEntry = {
  id: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  origin: ThreadTurnQueueOrigin;
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

export class ThreadTurnQueue {
  private readonly queuedEntries = new Map<string, ThreadTurnQueueEntry[]>();
  private readonly startingKeys = new Set<string>();
  private readonly runningEntries = new Map<string, RunningEntry>();
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
    try {
      const result = await this.options.startTurn(entry);
      this.runningEntries.set(key, {
        entry,
        turnId: result.turnId,
      });
      await this.emit({ type: "started", entry, turnId: result.turnId });
      return result;
    } catch (error) {
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

  private keyFor(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
  }): string {
    return `${params.backend}:${params.threadId}`;
  }

  private async emit(event: ThreadTurnQueueLifecycleEvent): Promise<void> {
    await this.options.onLifecycle?.(event);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
