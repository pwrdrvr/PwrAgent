import type {
  MessagingBindingRecord,
  MessagingInboundMediaEvent,
  MessagingInboundTextEvent,
} from "@pwragent/messaging-interface";
import { scopeMessagingRoutingKey } from "@pwragent/messaging-interface";
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
  onSettled?: (accepted: boolean) => void;
};

export class MessagingTurnAdmission {
  private readonly pendingByRoute = new Map<string, PendingWindow>();
  private readonly startingThreadKeys = new Set<string>();
  private sequence = 0;

  constructor(
    private readonly options: {
      debounceMs: number;
      onBundleReady: (bundle: MessagingTurnAdmissionBundle) => boolean | void | Promise<boolean | void>;
    },
  ) {}

  async append(params: {
    binding: MessagingBindingRecord;
    event: MessagingTurnInputEvent;
    immediate?: boolean;
    onSettled?: (accepted: boolean) => void;
  }): Promise<void> {
    const threadKey = threadKeyForBinding(params.binding);
    const { channel, connectionId, conversation } = params.event.channel;
    const pendingKey = scopeMessagingRoutingKey(connectionId, JSON.stringify([
      threadKey,
      params.binding.id,
      channel,
      conversation.kind,
      conversation.id,
      conversation.parentId,
      conversation.workspaceId,
      params.event.actor.platformUserId,
      params.binding.privateReplyContinuation?.requestId,
    ]));
    const flushNow = params.immediate || this.options.debounceMs <= 0;
    const existing = this.pendingByRoute.get(pendingKey);
    if (existing) {
      existing.events.push(params.event);
      if (flushNow) {
        await this.flush(pendingKey);
        return;
      }
      if (existing.timer) {
        clearTimeout(existing.timer);
      }
      existing.timer = this.schedule(pendingKey);
      return;
    }

    this.pendingByRoute.set(pendingKey, {
      binding: params.binding,
      events: [params.event],
      threadKey,
      timer: flushNow ? undefined : this.schedule(pendingKey),
      onSettled: params.onSettled,
    });
    if (flushNow) {
      await this.flush(pendingKey);
    }
  }

  dispose(): void {
    for (const pending of this.pendingByRoute.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.onSettled?.(false);
    }
    this.pendingByRoute.clear();
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
    const pending = this.pendingByRoute.get(pendingKey);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingByRoute.delete(pendingKey);
    let accepted = false;
    try {
      accepted = await this.options.onBundleReady({
        binding: pending.binding,
        events: pending.events,
        id: `bundle:${++this.sequence}`,
        threadKey: pending.threadKey,
      }) === true;
    } finally {
      pending.onSettled?.(accepted);
    }
  }
}

export function threadKeyForBinding(binding: MessagingBindingRecord): string {
  return binding.federatedThread &&
    isRemoteFederationTarget(binding.federatedThread.target)
    ? federatedThreadIdentityKey(binding.federatedThread)
    : buildThreadIdentityKey(binding.backend, binding.threadId);
}
