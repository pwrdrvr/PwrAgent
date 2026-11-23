import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "@pwragent/shared/contracts/normalized-app-server";
import { evictStaleStreamAnchors, type MessagingBindingRecord, type MessagingDeliveryResult, type MessagingImagePart, type MessagingInboundEvent, type MessagingStreamUpdateIntent, type MessagingSurfaceIntent, type MessagingSurfaceRef } from "@pwragent/messaging-interface";
import { assistantItemIdForBackendEvent, assistantStreamKey, messagingSurfaceKey, turnIdForBackendEvent, type AssistantMessageDeliveryIdentity, type AssistantStreamDelta, type MessagingCancellationSignal, type MessagingDeliveryGuard } from "./messaging-backend-event-helpers";
import { isSameMessagingSurface } from "./messaging-callback-helpers";
import { coalesceBackoffMs } from "./messaging-coalesce-backoff.js";
import { isVisibleAssistantStreamDelivery } from "./messaging-agent-tool-helpers";
import { messagingStreamingResponsesEnabled, resolveMessagingStreamingResponseMode } from "./messaging-status-card.js";
import type { MessagingReplyReceiptRequest } from "./messaging-outbound-delivery";
import { replyReceiptSettlement } from "./messaging-reply-receipts";

export interface MessagingAssistantStreamHost {
  readonly isTerminalPrivateResponseTurn: (backend: AppServerBackendKind, threadId: ThreadIdentifier, turnId: string | undefined) => boolean;
  readonly turnProseKey: (bindingId: string, turnId: string) => string;
  readonly deliverAssistantMessage: (text: string, event: AgentEvent, binding: MessagingBindingRecord, images?: MessagingImagePart[], identity?: AssistantMessageDeliveryIdentity, deliveryClaimed?: boolean, finalReply?: boolean) => Promise<void>;
  readonly responseAttributionForBinding: (binding: MessagingBindingRecord) => Promise<{ label: string }>;
  readonly newIntentId: (prefix: string) => string;
  readonly deliver: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, guard?: MessagingDeliveryGuard, receipt?: MessagingReplyReceiptRequest) => Promise<MessagingDeliveryResult>;
  readonly dismissTerminalPrivateResponseSurface: (binding: MessagingBindingRecord, turnId: string, surface: MessagingSurfaceRef) => Promise<boolean>;
}

export interface MessagingAssistantStreamContext {
  readonly now: () => number;
  readonly streamingResponsesDefault: boolean;
  readonly host: MessagingAssistantStreamHost;
}

type AssistantStreamBuffer = AssistantStreamDelta & {
  // Earliest time a non-final `stream_update` may be emitted for this message.
  // Deltas arriving before it are coalesced into `text`; see
  // {@link coalesceBackoffMs}. The final flush ignores this and emits at once.
  nextReleaseAt: number;
  // Count of non-final edits already emitted for this message, driving the
  // exponential backoff between successive coalesced releases.
  releaseCount: number;
  sequence: number;
  surface?: MessagingSurfaceRef;
  text: string;
};

export class MessagingAssistantStreams {
  private readonly assistantStreamBuffers = new Map<string, AssistantStreamBuffer>();
  private readonly assistantStreamDeliveryQueues = new Map<
    string,
    Promise<MessagingDeliveryResult>
  >();
  private readonly assistantStreamCancellationFailures = new Set<string>();
  private readonly assistantStreamCancellationSignals = new Map<
    string,
    MessagingCancellationSignal
  >();

  constructor(private readonly context: MessagingAssistantStreamContext) {}

  dispose(): void {
    this.assistantStreamCancellationFailures.clear();
    for (const cancellation of this.assistantStreamCancellationSignals.values()) {
      cancellation.cancel();
    }
    this.assistantStreamCancellationSignals.clear();
  }

  discardAssistantStreamItemForEvent(event: AgentEvent, binding: MessagingBindingRecord, itemId: string | undefined): void {
    for (const key of this.assistantStreamBufferKeysForEvent(event, binding)) {
      const buffer = this.assistantStreamBuffers.get(key);
      if (itemId && buffer?.itemId === itemId) {
        this.assistantStreamBuffers.delete(key);
        this.assistantStreamDeliveryQueues.delete(key);
        this.assistantStreamCancellationSignals.delete(
          this.context.host.turnProseKey(binding.id, buffer.turnId),
        );
      }
    }
  }

  private isStreamingResponsesEnabledForBinding(
    binding: MessagingBindingRecord,
  ): boolean {
    return messagingStreamingResponsesEnabled(
      resolveMessagingStreamingResponseMode(binding),
      this.context.streamingResponsesDefault,
    );
  }

  async deliverAssistantStreamUpdate(
    delta: AssistantStreamDelta,
    binding: MessagingBindingRecord,
    options?: { bufferOnly?: boolean },
  ): Promise<void> {
    if (
      this.context.host.isTerminalPrivateResponseTurn(
        binding.backend,
        binding.threadId,
        delta.turnId,
      )
    ) {
      return;
    }
    const bufferKey = this.assistantStreamBufferKey(delta.streamKey, binding);
    const now = this.context.now();
    const existing = this.assistantStreamBuffers.get(bufferKey);
    const buffer: AssistantStreamBuffer = existing
      ? {
          ...existing,
          delta: delta.delta,
          sequence: existing.sequence + 1,
          text: `${existing.text}${delta.delta}`,
        }
      : {
          ...delta,
          // First receipt: hold the first coalesced block for the initial
          // window so a burst of opening tokens becomes one edit, not many.
          nextReleaseAt: now + coalesceBackoffMs(0),
          releaseCount: 0,
          sequence: 1,
          text: delta.delta,
        };
    this.assistantStreamBuffers.set(bufferKey, buffer);
    // Bound the buffer map: a turn whose late deltas arrive after its terminal
    // flush re-creates an entry that no later terminal event clears. Cap it so
    // those orphans are reclaimed rather than accumulating for the process life.
    evictStaleStreamAnchors(this.assistantStreamBuffers);

    if (options?.bufferOnly) {
      return;
    }

    // Streaming off: keep accumulating deltas (the terminal flush still needs
    // the buffered text — e.g. ACP turns whose only output arrives as deltas)
    // but never emit a partial `stream_update`. Those intents would be
    // discarded downstream yet still consume a budget-admission check, and the
    // surface churn is what floods the channel with many separate messages.
    if (!this.isStreamingResponsesEnabledForBinding(binding)) {
      return;
    }

    // Coalesce: buffer this delta into `text` (already done above) and emit
    // nothing until the stored release time passes. Each release then schedules
    // the next one exponentially further out (~400ms → 1s → 2s → 4s → 8s → 16s
    // cap) so a long stream settles to at most one edit every ~16s instead of
    // one edit per delta. The final flush bypasses this timer entirely.
    if (buffer.text.trim().length === 0 || now < buffer.nextReleaseAt) {
      return;
    }

    const releaseCount = buffer.releaseCount + 1;
    this.assistantStreamBuffers.set(bufferKey, {
      ...buffer,
      releaseCount,
      nextReleaseAt: now + coalesceBackoffMs(releaseCount),
    });
    await this.enqueueAssistantStreamBufferDelivery(bufferKey, binding, false);
  }

  async flushAssistantStreamForEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
    finalText: string,
  ): Promise<boolean> {
    const streamingEnabled = this.isStreamingResponsesEnabledForBinding(binding);
    let deliveredFinalStream = false;
    const completedTurnIds = new Set<string>();
    for (const bufferKey of this.assistantStreamBufferKeysForEvent(event, binding)) {
      const buffer = this.assistantStreamBuffers.get(bufferKey);
      if (!buffer) {
        continue;
      }
      completedTurnIds.add(buffer.turnId);
      // Streaming off: drop the accumulator without emitting a final
      // `stream_update`. Returning `false` routes the caller to
      // `deliverAssistantMessage`, so the turn lands as a single message
      // instead of a discarded stream edit followed by that same message.
      if (!streamingEnabled) {
        this.assistantStreamBuffers.delete(bufferKey);
        this.assistantStreamDeliveryQueues.delete(bufferKey);
        continue;
      }
      this.assistantStreamBuffers.set(bufferKey, {
        ...buffer,
        delta: "",
        sequence: buffer.sequence + 1,
        text: finalText,
      });
      // The receipt names the event's turn and item, as the caller's message
      // fallback does, so an edit and its fallback settle one receipt.
      const receipt = finalReplyReceipt(
        binding,
        turnIdForBackendEvent(event),
        assistantItemIdForBackendEvent(event),
      );
      const result = await this.enqueueAssistantStreamBufferDelivery(bufferKey, binding, true, receipt);
      deliveredFinalStream ||= !finalStreamNeedsMessage(result, receipt);
      this.assistantStreamBuffers.delete(bufferKey);
      this.assistantStreamDeliveryQueues.delete(bufferKey);
    }
    for (const turnId of completedTurnIds) {
      this.assistantStreamCancellationSignals.delete(
        this.context.host.turnProseKey(binding.id, turnId),
      );
    }
    return deliveredFinalStream;
  }

  async flushBufferedAssistantStreamsForTerminalEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): Promise<void> {
    const streamingEnabled = this.isStreamingResponsesEnabledForBinding(binding);
    const fallbackMessages: Array<{
      identity: AssistantMessageDeliveryIdentity;
      text: string;
    }> = [];
    const completedTurnIds = new Set<string>();
    for (const bufferKey of this.assistantStreamBufferKeysForEvent(event, binding)) {
      const buffer = this.assistantStreamBuffers.get(bufferKey);
      if (!buffer) {
        continue;
      }
      completedTurnIds.add(buffer.turnId);
      const text = buffer.text.trim();
      if (!text) {
        this.assistantStreamBuffers.delete(bufferKey);
        this.assistantStreamDeliveryQueues.delete(bufferKey);
        continue;
      }
      // Streaming off: post the buffered text as a plain message rather than an
      // (immediately discarded) final `stream_update`. Same single-message
      // outcome, without churning the delivery budget on a doomed stream edit.
      if (!streamingEnabled) {
        fallbackMessages.push({
          identity: {
            itemId: buffer.itemId,
            threadId: buffer.threadId,
            turnId: buffer.turnId,
          },
          text,
        });
        this.assistantStreamBuffers.delete(bufferKey);
        this.assistantStreamDeliveryQueues.delete(bufferKey);
        continue;
      }
      this.assistantStreamBuffers.set(bufferKey, {
        ...buffer,
        delta: "",
        sequence: buffer.sequence + 1,
        text,
      });
      const receipt = finalReplyReceipt(binding, buffer.turnId, buffer.itemId);
      const result = await this.enqueueAssistantStreamBufferDelivery(bufferKey, binding, true, receipt);
      if (finalStreamNeedsMessage(result, receipt)) {
        fallbackMessages.push({
          identity: {
            itemId: buffer.itemId,
            threadId: buffer.threadId,
            turnId: buffer.turnId,
          },
          text,
        });
      }
      this.assistantStreamBuffers.delete(bufferKey);
      this.assistantStreamDeliveryQueues.delete(bufferKey);
    }

    for (const turnId of completedTurnIds) {
      this.assistantStreamCancellationSignals.delete(
        this.context.host.turnProseKey(binding.id, turnId),
      );
    }

    for (const fallback of fallbackMessages) {
      await this.context.host.deliverAssistantMessage(
        fallback.text,
        event,
        binding,
        [],
        fallback.identity,
        false,
        true,
      );
    }
  }

  takeBufferedAssistantTextForTerminalEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): string | undefined {
    const completedTurnIds = new Set<string>();
    const messages: string[] = [];
    for (const bufferKey of this.assistantStreamBufferKeysForEvent(event, binding)) {
      const buffer = this.assistantStreamBuffers.get(bufferKey);
      if (!buffer) {
        continue;
      }
      completedTurnIds.add(buffer.turnId);
      const text = buffer.text.trim();
      if (text) {
        messages.push(text);
      }
      this.assistantStreamBuffers.delete(bufferKey);
      this.assistantStreamDeliveryQueues.delete(bufferKey);
    }
    for (const turnId of completedTurnIds) {
      this.assistantStreamCancellationSignals.delete(
        this.context.host.turnProseKey(binding.id, turnId),
      );
    }
    const text = messages.join("\n\n").trim();
    return text || undefined;
  }

  async waitForAssistantStreamDeliveriesForEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): Promise<void> {
    const deliveries = this.assistantStreamBufferKeysForEvent(event, binding)
      .map((bufferKey) => this.assistantStreamDeliveryQueues.get(bufferKey))
      .filter(
        (delivery): delivery is Promise<MessagingDeliveryResult> => Boolean(delivery),
      );
    if (deliveries.length === 0) {
      return;
    }
    await Promise.allSettled(deliveries);
  }

  private assistantStreamBufferKeysForEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): string[] {
    const keys = new Set(
      assistantStreamKeysForBackendEvent(event).map((streamKey) =>
        this.assistantStreamBufferKey(streamKey, binding),
      ),
    );
    const filter = assistantStreamFilterForBackendEvent(event);
    if (!filter) {
      return [...keys];
    }
    for (const [bufferKey, buffer] of this.assistantStreamBuffers) {
      if (
        bufferKey.startsWith(`${binding.id}\0`) &&
        buffer.streamKey.startsWith(`${event.backend}:`) &&
        buffer.threadId === filter.threadId &&
        (!filter.turnId || buffer.turnId === filter.turnId)
      ) {
        keys.add(bufferKey);
      }
    }
    return [...keys];
  }

  private async enqueueAssistantStreamBufferDelivery(
    bufferKey: string,
    binding: MessagingBindingRecord,
    isFinal: boolean,
    receipt?: MessagingReplyReceiptRequest,
  ): Promise<MessagingDeliveryResult> {
    const previous = this.assistantStreamDeliveryQueues.get(bufferKey) ?? Promise.resolve();
    const delivery = previous
      .catch(() => undefined)
      .then(async (): Promise<MessagingDeliveryResult> => {
        const latest = this.assistantStreamBuffers.get(bufferKey);
        if (!latest) {
          return {
            channel: binding.channel.channel,
            deliveredAt: this.context.now(),
            outcome: "discarded",
          };
        }
        return await this.deliverAssistantStreamBuffer(latest, binding, isFinal, receipt);
      });
    this.assistantStreamDeliveryQueues.set(bufferKey, delivery);
    try {
      return await delivery;
    } finally {
      if (this.assistantStreamDeliveryQueues.get(bufferKey) === delivery) {
        this.assistantStreamDeliveryQueues.delete(bufferKey);
      }
    }
  }

  private async deliverAssistantStreamBuffer(
    buffer: AssistantStreamBuffer,
    binding: MessagingBindingRecord,
    isFinal: boolean,
    receipt: MessagingReplyReceiptRequest | undefined,
  ): Promise<MessagingDeliveryResult> {
    const cancellationKey = this.context.host.turnProseKey(binding.id, buffer.turnId);
    const cancellation = this.ensureAssistantStreamCancellationSignal(
      binding,
      buffer.turnId,
    );
    const now = this.context.now();
    const attribution = isFinal
      ? await this.context.host.responseAttributionForBinding(binding)
      : undefined;
    const intent: MessagingStreamUpdateIntent = {
      id: this.context.host.newIntentId(isFinal ? "assistant-stream-final" : "assistant-stream"),
      kind: "stream_update",
      bindingId: binding.id,
      createdAt: now,
      ...(buffer.surface
        ? {
            delivery: {
              mode: "update",
              fallback: "fail",
            },
            targetSurface: buffer.surface,
          }
        : {}),
      role: "assistant",
      ...(attribution ? { attribution } : {}),
      markdown: isFinal ? "markdown" : "plain",
      policy: binding.preferences?.streamingResponses ?? "inherit",
      delta: buffer.delta,
      text: buffer.text,
      stream: {
        key: buffer.streamKey,
        turnId: buffer.turnId,
        itemId: buffer.itemId,
        sequence: buffer.sequence,
        isFinal,
      },
    };
    const result = await this.context.host.deliver(intent, binding, undefined, {
      isCancelled: cancellation.isCancelled,
      whenCancelled: cancellation.whenCancelled,
      onCancelledDelivery: async (cancelledResult) => {
        if (
          cancelledResult.surface
          && isVisibleAssistantStreamDelivery(cancelledResult)
          && !isSameMessagingSurface(cancelledResult.surface, buffer.surface)
        ) {
          const dismissed = await this.context.host.dismissTerminalPrivateResponseSurface(
            binding,
            buffer.turnId,
            cancelledResult.surface,
          );
          if (!dismissed) {
            this.assistantStreamCancellationFailures.add(cancellationKey);
          }
        }
      },
    }, receipt);
    if (cancellation.isCancelled()) {
      const bufferKey = this.assistantStreamBufferKey(buffer.streamKey, binding);
      this.assistantStreamBuffers.delete(bufferKey);
      return result;
    }
    const surface =
      result.surface && isVisibleAssistantStreamDelivery(result)
        ? result.surface
        : buffer.surface;
    const bufferKey = this.assistantStreamBufferKey(buffer.streamKey, binding);
    const current = this.assistantStreamBuffers.get(bufferKey);
    this.assistantStreamBuffers.set(bufferKey, {
      ...(current && current.sequence >= buffer.sequence ? current : buffer),
      surface,
    });
    return result;
  }

  private assistantStreamBufferKey(
    streamKey: string,
    binding: MessagingBindingRecord,
  ): string {
    return `${binding.id}\0${streamKey}`;
  }

  private ensureAssistantStreamCancellationSignal(
    binding: MessagingBindingRecord,
    turnId: string,
  ): MessagingCancellationSignal {
    const key = this.context.host.turnProseKey(binding.id, turnId);
    const existing = this.assistantStreamCancellationSignals.get(key);
    if (existing) {
      return existing;
    }
    let cancelled = this.context.host.isTerminalPrivateResponseTurn(
      binding.backend,
      binding.threadId,
      turnId,
    );
    let resolveCancellation!: () => void;
    const whenCancelled = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const cancellation: MessagingCancellationSignal = {
      cancel: () => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        resolveCancellation();
      },
      isCancelled: () =>
        cancelled
        || this.context.host.isTerminalPrivateResponseTurn(
          binding.backend,
          binding.threadId,
          turnId,
        ),
      whenCancelled,
    };
    if (cancelled) {
      resolveCancellation();
    }
    this.assistantStreamCancellationSignals.set(key, cancellation);
    return cancellation;
  }

  async cancelAssistantStreamsForTurn(
    binding: MessagingBindingRecord,
    turnId: string,
  ): Promise<boolean> {
    const cancellationKey = this.context.host.turnProseKey(binding.id, turnId);
    const deliveries = new Set<Promise<MessagingDeliveryResult>>();
    const surfaces = new Map<string, MessagingSurfaceRef>();
    this.assistantStreamCancellationFailures.delete(cancellationKey);
    this.assistantStreamCancellationSignals.get(cancellationKey)?.cancel();
    for (const [bufferKey, buffer] of this.assistantStreamBuffers) {
      if (
        bufferKey.startsWith(`${binding.id}\0`)
        && buffer.turnId === turnId
      ) {
        if (buffer.surface) {
          surfaces.set(messagingSurfaceKey(buffer.surface), buffer.surface);
        }
        const delivery = this.assistantStreamDeliveryQueues.get(bufferKey);
        if (delivery) {
          deliveries.add(delivery);
        }
        this.assistantStreamBuffers.delete(bufferKey);
      }
    }
    const deliveryResults = await Promise.allSettled(deliveries);
    for (const deliveryResult of deliveryResults) {
      if (
        deliveryResult.status === "fulfilled"
        && deliveryResult.value.surface
        && isVisibleAssistantStreamDelivery(deliveryResult.value)
      ) {
        surfaces.set(
          messagingSurfaceKey(deliveryResult.value.surface),
          deliveryResult.value.surface,
        );
      }
    }

    // A delivery already awaiting its adapter can finish after the buffers are
    // cleared. Retain the settled delivery result above so the cancellation
    // path owns a surface created between the delivery guard's post-adapter
    // check and the caller recording it, then make one final sweep for existing
    // surfaces.
    for (const [bufferKey, buffer] of this.assistantStreamBuffers) {
      if (
        bufferKey.startsWith(`${binding.id}\0`)
        && buffer.turnId === turnId
      ) {
        if (buffer.surface) {
          surfaces.set(messagingSurfaceKey(buffer.surface), buffer.surface);
        }
        this.assistantStreamBuffers.delete(bufferKey);
        this.assistantStreamDeliveryQueues.delete(bufferKey);
      }
    }
    for (const surface of surfaces.values()) {
      const dismissed = await this.context.host.dismissTerminalPrivateResponseSurface(
        binding,
        turnId,
        surface,
      );
      if (!dismissed) {
        this.assistantStreamCancellationFailures.add(cancellationKey);
      }
    }
    const cancelledCleanly = !this.assistantStreamCancellationFailures.has(
      cancellationKey,
    );
    this.assistantStreamCancellationFailures.delete(cancellationKey);
    this.assistantStreamCancellationSignals.delete(cancellationKey);
    return cancelledCleanly;
  }
}

/**
 * The receipt a final stream edit keeps; partials keep none and write
 * nothing. It names the turn and item the message fallback names, so the
 * fallback and a resend after a restart settle the same receipt.
 */
function finalReplyReceipt(
  binding: MessagingBindingRecord,
  turnId: string | undefined,
  itemId: string | undefined,
): MessagingReplyReceiptRequest | undefined {
  if (!turnId || !itemId) return undefined;
  return {
    identity: {
      kind: "assistant-final",
      backend: binding.backend,
      bindingId: binding.id,
      threadId: binding.threadId,
      turnId,
      itemId,
    },
  };
}

/**
 * Whether a final stream edit leaves the reply to a new message. An edit
 * falls back only when the provider has not ruled out a replay. A kept
 * receipt further requires evidence that the edit did not land.
 */
function finalStreamNeedsMessage(
  result: MessagingDeliveryResult,
  receipt: MessagingReplyReceiptRequest | undefined,
): boolean {
  if (isVisibleAssistantStreamDelivery(result)) return false;
  if (result.fallbackUnsafe) return false;
  if (!receipt?.kept) return true;
  return replyReceiptSettlement("stream_update", result).state === "owed";
}

function assistantStreamKeysForBackendEvent(event: AgentEvent): string[] {
  const params = event.notification.params as {
    threadId?: unknown;
    turn?: { id?: unknown };
    turnId?: unknown;
  };
  if (typeof params.threadId !== "string") {
    return [];
  }
  const turnId =
    typeof params.turnId === "string"
      ? params.turnId
      : typeof params.turn?.id === "string"
        ? params.turn.id
        : undefined;
  return [
    assistantStreamKey({
      backend: event.backend,
      threadId: params.threadId,
      turnId,
    }),
  ];
}

function assistantStreamFilterForBackendEvent(
  event: AgentEvent,
): { threadId: ThreadIdentifier; turnId?: string } | undefined {
  const params = event.notification.params as {
    threadId?: unknown;
    turn?: { id?: unknown };
    turnId?: unknown;
  };
  if (typeof params.threadId !== "string") {
    return undefined;
  }
  return {
    threadId: params.threadId,
    turnId: typeof params.turnId === "string"
      ? params.turnId
      : typeof params.turn?.id === "string"
        ? params.turn.id
        : undefined,
  };
}
