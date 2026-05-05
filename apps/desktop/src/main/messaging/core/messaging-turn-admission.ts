import type {
  AppServerTurnInputItem,
} from "@pwragent/shared";
import type {
  MessagingBindingRecord,
  MessagingInboundMediaEvent,
  MessagingInboundTextEvent,
  MessagingSurfaceRef,
} from "@pwragent/messaging-interface";
import { buildThreadIdentityKey } from "@pwragent/shared";

export type MessagingTurnInputEvent =
  | MessagingInboundTextEvent
  | MessagingInboundMediaEvent;

export type MessagingTurnAdmissionBundle = {
  binding: MessagingBindingRecord;
  events: MessagingTurnInputEvent[];
  id: string;
  threadKey: string;
};

export type MessagingQueuedTurnEntry = {
  binding: MessagingBindingRecord;
  createdAt: number;
  id: string;
  input: AppServerTurnInputItem[];
  preview: string;
  status: "queued" | "steered" | "cancelled" | "submitted" | "failed";
  surface?: MessagingSurfaceRef;
  threadKey: string;
  updatedAt: number;
};

type PendingWindow = {
  binding: MessagingBindingRecord;
  events: MessagingTurnInputEvent[];
  timer?: ReturnType<typeof setTimeout>;
};

export class MessagingTurnAdmission {
  private readonly pendingByThreadKey = new Map<string, PendingWindow>();
  private readonly queuedByThreadKey = new Map<string, MessagingQueuedTurnEntry[]>();
  private readonly startingThreadKeys = new Set<string>();
  private sequence = 0;

  constructor(
    private readonly options: {
      debounceMs: number;
      now: () => number;
      onBundleReady: (bundle: MessagingTurnAdmissionBundle) => void | Promise<void>;
    },
  ) {}

  async append(params: {
    binding: MessagingBindingRecord;
    event: MessagingTurnInputEvent;
  }): Promise<void> {
    const threadKey = threadKeyForBinding(params.binding);
    const existing = this.pendingByThreadKey.get(threadKey);
    if (existing) {
      existing.events.push(params.event);
      if (this.options.debounceMs <= 0) {
        await this.flush(threadKey);
        return;
      }
      if (existing.timer) {
        clearTimeout(existing.timer);
      }
      existing.timer = this.schedule(threadKey);
      return;
    }

    this.pendingByThreadKey.set(threadKey, {
      binding: params.binding,
      events: [params.event],
      timer: this.options.debounceMs > 0 ? this.schedule(threadKey) : undefined,
    });
    if (this.options.debounceMs <= 0) {
      await this.flush(threadKey);
    }
  }

  dispose(): void {
    for (const pending of this.pendingByThreadKey.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    this.pendingByThreadKey.clear();
  }

  isStarting(threadKey: string): boolean {
    return this.startingThreadKeys.has(threadKey);
  }

  markStarting(threadKey: string): void {
    this.startingThreadKeys.add(threadKey);
  }

  clearStarting(threadKey: string): void {
    this.startingThreadKeys.delete(threadKey);
  }

  enqueue(
    entry: Omit<MessagingQueuedTurnEntry, "createdAt" | "id" | "status" | "updatedAt">,
  ): MessagingQueuedTurnEntry {
    const now = this.options.now();
    const queued: MessagingQueuedTurnEntry = {
      ...entry,
      createdAt: now,
      id: `queued:${++this.sequence}`,
      status: "queued",
      updatedAt: now,
    };
    const queue = this.queuedByThreadKey.get(queued.threadKey) ?? [];
    queue.push(queued);
    this.queuedByThreadKey.set(queued.threadKey, queue);
    return queued;
  }

  updateQueuedEntry(
    entry: MessagingQueuedTurnEntry,
    patch: Partial<MessagingQueuedTurnEntry>,
  ): MessagingQueuedTurnEntry {
    const queue = this.queuedByThreadKey.get(entry.threadKey) ?? [];
    const index = queue.findIndex((candidate) => candidate.id === entry.id);
    const updated = {
      ...entry,
      ...patch,
      updatedAt: this.options.now(),
    };
    if (index >= 0) {
      queue[index] = updated;
      this.queuedByThreadKey.set(entry.threadKey, queue);
    }
    return updated;
  }

  findQueuedEntry(id: string): MessagingQueuedTurnEntry | undefined {
    for (const queue of this.queuedByThreadKey.values()) {
      const entry = queue.find((candidate) => candidate.id === id);
      if (entry) {
        return entry;
      }
    }
    return undefined;
  }

  peekNextQueued(threadKey: string): MessagingQueuedTurnEntry | undefined {
    const queue = this.queuedByThreadKey.get(threadKey);
    if (!queue) {
      return undefined;
    }

    while (queue.length > 0) {
      const entry = queue[0];
      if (entry?.status === "queued") {
        return entry;
      }
      queue.shift();
    }

    this.queuedByThreadKey.delete(threadKey);
    return undefined;
  }

  removeQueuedEntry(entry: MessagingQueuedTurnEntry): void {
    const queue = this.queuedByThreadKey.get(entry.threadKey);
    if (!queue) {
      return;
    }

    const index = queue.findIndex((candidate) => candidate.id === entry.id);
    if (index >= 0) {
      queue.splice(index, 1);
    }

    if (queue.length === 0) {
      this.queuedByThreadKey.delete(entry.threadKey);
    }
  }

  shiftNextQueued(threadKey: string): MessagingQueuedTurnEntry | undefined {
    const queue = this.queuedByThreadKey.get(threadKey);
    if (!queue) {
      return undefined;
    }

    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry?.status === "queued") {
        if (queue.length === 0) {
          this.queuedByThreadKey.delete(threadKey);
        }
        return entry;
      }
    }

    this.queuedByThreadKey.delete(threadKey);
    return undefined;
  }

  private schedule(threadKey: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      void this.flush(threadKey);
    }, this.options.debounceMs);
  }

  private async flush(threadKey: string): Promise<void> {
    const pending = this.pendingByThreadKey.get(threadKey);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingByThreadKey.delete(threadKey);
    await this.options.onBundleReady({
      binding: pending.binding,
      events: pending.events,
      id: `bundle:${++this.sequence}`,
      threadKey,
    });
  }
}

export function threadKeyForBinding(binding: MessagingBindingRecord): string {
  return buildThreadIdentityKey(binding.backend, binding.threadId);
}
