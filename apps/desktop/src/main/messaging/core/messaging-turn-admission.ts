import type {
  MessagingBindingRecord,
  MessagingInboundMediaEvent,
  MessagingInboundTextEvent,
} from "@pwragent/messaging-interface";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { federatedThreadIdentityKey, isRemoteFederationTarget } from "@pwragent/shared/contracts/federation";

export type MessagingTurnInputEvent =
  | MessagingInboundTextEvent
  | MessagingInboundMediaEvent;

export type MessagingTurnAdmissionBundle = {
  binding: MessagingBindingRecord;
  events: MessagingTurnInputEvent[];
  id: string;
  threadKey: string;
};

type PendingWindow = {
  binding: MessagingBindingRecord;
  events: MessagingTurnInputEvent[];
  threadKey: string;
  timer?: ReturnType<typeof setTimeout>;
};

export class MessagingTurnAdmission {
  private readonly pendingByThreadActorKey = new Map<string, PendingWindow>();
  private readonly startingThreadKeys = new Set<string>();
  private sequence = 0;

  constructor(
    private readonly options: {
      debounceMs: number;
      onBundleReady: (bundle: MessagingTurnAdmissionBundle) => void | Promise<void>;
    },
  ) {}

  hasPendingWork(): boolean {
    return this.pendingByThreadActorKey.size > 0 || this.startingThreadKeys.size > 0;
  }

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
