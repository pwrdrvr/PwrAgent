import { randomUUID } from "node:crypto";
import type {
  AppServerTurnInputItem,
} from "@pwragent/shared";
import type {
  MessagingBindingRecord,
  MessagingInboundEvent,
  MessagingInboundMediaEvent,
  MessagingInboundTextEvent,
  MessagingSurfaceRef,
} from "@pwragent/messaging-interface";
import {
  buildThreadIdentityKey,
  federatedThreadIdentityKey,
  isRemoteFederationTarget,
} from "@pwragent/shared";
import type { PendingPdfAttachment } from "../../pdf/pdf-attachment-store";

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
  event?: MessagingInboundEvent;
  id: string;
  input: AppServerTurnInputItem[];
  pdfAttachments?: PendingPdfAttachment[];
  privateResponseRequested?: boolean;
  preview: string;
  status: "queued" | "steered" | "cancelled" | "submitted" | "failed";
  surface?: MessagingSurfaceRef;
  threadKey: string;
  updatedAt: number;
};

type PendingWindow = {
  binding: MessagingBindingRecord;
  events: MessagingTurnInputEvent[];
  threadKey: string;
  timer?: ReturnType<typeof setTimeout>;
};

export class MessagingTurnAdmission {
  private readonly pendingByThreadActorKey = new Map<string, PendingWindow>();
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
    const pendingKey = pendingKeyForActor(
      threadKey,
      params.event.actor.platformUserId,
    );
    const existing = this.pendingByThreadActorKey.get(pendingKey);
    if (existing) {
      existing.events.push(params.event);
      if (this.options.debounceMs <= 0) {
        await this.flush(pendingKey);
        return;
      }
      if (existing.timer) {
        clearTimeout(existing.timer);
      }
      existing.timer = this.schedule(pendingKey);
      return;
    }

    this.pendingByThreadActorKey.set(pendingKey, {
      binding: params.binding,
      events: [params.event],
      threadKey,
      timer: this.options.debounceMs > 0 ? this.schedule(pendingKey) : undefined,
    });
    if (this.options.debounceMs <= 0) {
      await this.flush(pendingKey);
    }
  }

  dispose(): void {
    for (const pending of this.pendingByThreadActorKey.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    this.pendingByThreadActorKey.clear();
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
      id: `queued:${randomUUID()}`,
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

  private schedule(pendingKey: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      void this.flush(pendingKey);
    }, this.options.debounceMs);
  }

  private async flush(pendingKey: string): Promise<void> {
    const pending = this.pendingByThreadActorKey.get(pendingKey);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingByThreadActorKey.delete(pendingKey);
    await this.options.onBundleReady({
      binding: pending.binding,
      events: pending.events,
      id: `bundle:${++this.sequence}`,
      threadKey: pending.threadKey,
    });
  }
}

function pendingKeyForActor(threadKey: string, platformUserId: string): string {
  return JSON.stringify([threadKey, platformUserId]);
}

export function threadKeyForBinding(binding: MessagingBindingRecord): string {
  return binding.federatedThread &&
    isRemoteFederationTarget(binding.federatedThread.target)
    ? federatedThreadIdentityKey(binding.federatedThread)
    : buildThreadIdentityKey(binding.backend, binding.threadId);
}
