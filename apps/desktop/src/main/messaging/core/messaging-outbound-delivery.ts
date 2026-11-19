import { randomUUID } from "node:crypto";
import { stripCodexGitActionDirectives } from "@pwragent/shared";
import type { AppServerBackendKind, FederationTarget, ThreadIdentifier } from "@pwragent/shared";
import type { MessagingActivityStorage } from "@pwragent/owner-core/messaging-activity-storage";
import type {
  MessagingBindingRecord,
  MessagingCapabilityProfile,
  MessagingChannelKind,
  MessagingChannelRef,
  MessagingDeliveryResult,
  MessagingDeliveryScope,
  MessagingInboundEvent,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import type { MessagingAdapter } from "./messaging-adapter.js";
import {
  buildArtifactDeliveryIntent,
  buildArtifactInlineFallbackIntent,
  type MessagingArtifact,
  type MessagingArtifactMessageIntent,
} from "./messaging-artifact-renderer.js";
import { buildMessagingAuditContext } from "./messaging-audit.js";
import type { MessagingControllerLogger, MessagingDeliveryGuard } from "./messaging-backend-event-helpers";
import { isDeferrableDeliveryPriority, type MessagingDeliveryBudget, type MessagingDeliveryPriority } from "./messaging-delivery-budget.js";
import type { MessagingDeliveryLane, MessagingDeliveryLaneTicket } from "./messaging-delivery-lane.js";
import { isPermanentMessagingTargetFailure } from "./messaging-monitor-helpers";
import type { MessagingStoreLike } from "./messaging-storage";

export type MessagingControllerDeliveryBudgetEvent = {
  at: number;
  backend?: AppServerBackendKind;
  bindingId?: string;
  federationTarget?: FederationTarget;
  channel: MessagingChannelKind;
  conversation?: MessagingChannelRef["conversation"];
  intentId: string;
  intentKind: MessagingSurfaceIntent["kind"];
  outcome: "deferred" | "dropped";
  priority: MessagingDeliveryPriority;
  reason?: "cool-off" | "slow-mode" | "budget-exhausted" | "missing-scope";
  retryAt?: number;
  scope?: MessagingDeliveryScope;
  slowMode: boolean;
  threadId?: ThreadIdentifier;
};

type DeliveryLaneState = {
  lane?: MessagingDeliveryLane;
  ticket?: MessagingDeliveryLaneTicket;
};

interface MessagingOutboundDeliveryOptions {
  readonly adapter: MessagingAdapter;
  readonly channel?: MessagingChannelKind;
  readonly store: Pick<MessagingStoreLike, "recordDelivery" | "revokeBinding">;
  readonly deliveryBudget?: MessagingDeliveryBudget;
  readonly deliveryLane?: MessagingDeliveryLane;
  readonly replacementAdapter?: {
    now(): MessagingAdapter | undefined;
    settled(): Promise<MessagingAdapter | undefined>;
  };
  readonly sleepUntil?: (retryAt: number, now: () => number) => Promise<void>;
  readonly onDeliveryBudgetEvent?: (event: MessagingControllerDeliveryBudgetEvent) => void;
}

interface MessagingOutboundDeliveryContext {
  readonly disposed: boolean;
  readonly capabilityProfile: MessagingCapabilityProfile;
  readonly logger: MessagingControllerLogger;
  /** The original clock function passed to the injected sleep hook. */
  readonly clock: () => number;
  readonly now: () => number;
  readonly flushToolUpdatesForBinding: (
    binding: MessagingBindingRecord,
    options: { clear: boolean; turnId?: string },
  ) => Promise<void>;
  readonly markWorkingCardWaiting: (binding: MessagingBindingRecord) => Promise<void>;
  readonly desktopActivityLog: () => MessagingActivityStorage | undefined;
  readonly recordBindingTransition: (action: "unbound", binding: MessagingBindingRecord) => Promise<void>;
  readonly notifyBindingChanged: (reason: string) => void;
}

/** Owns delivery admission, the adapter call, and post-delivery side effects. */
export class MessagingOutboundDelivery {
  private stoppedAdapterStub: MessagingAdapter | undefined;
  private readonly deliveryBudget?: MessagingDeliveryBudget;

  constructor(
    private readonly options: MessagingOutboundDeliveryOptions,
    private readonly context: MessagingOutboundDeliveryContext,
  ) {
    this.deliveryBudget = options.deliveryBudget;
  }

  private recordOutboundActivity(
    intent: MessagingSurfaceIntent,
    binding: MessagingBindingRecord | undefined,
    result: MessagingDeliveryResult,
  ): void {
    // Ordinary replies only update provider-visible freshness. Typing activity,
    // dismissals, and partial stream edits are control/noisy signals; the
    // Activity window stays focused on operator-facing rows. Deliberate
    // agent-initiated sends write their own `outbound` row — see
    // recordOutboundFileActivity.
    if (!shouldRecordOutboundActivity(intent, result)) {
      return;
    }
    const channel = binding?.channel.channel ?? result.channel;
    if (!channel) return;
    try {
      const log = this.context.desktopActivityLog();
      if (!log) return;
      log.recordPlatformResponseActivity({
        platform: channel,
        createdAt: result.deliveredAt,
      });
    } catch {
      // Activity log is best-effort observability; never break delivery
      // because the summary write threw.
    }
  }

  /**
   * The adapter this controller talks to. Once the controller is disposed its
   * own adapter has been stopped and must never be called again: work still
   * in progress goes to the adapter now running for the channel, or to a
   * stub that does nothing when none is running.
   */
  get adapter(): MessagingAdapter {
    if (!this.context.disposed) return this.options.adapter;
    const replacement = this.options.replacementAdapter?.now();
    if (replacement && replacement !== this.options.adapter) return replacement;
    return this.stoppedAdapter();
  }

  private stoppedAdapter(): MessagingAdapter {
    this.stoppedAdapterStub ??= {
      capabilityProfile: this.options.adapter.capabilityProfile,
      deliver: async () => ({
        channel: this.options.channel ?? "telegram",
        deliveredAt: this.context.now(),
        outcome: "discarded",
      }),
    };
    return this.stoppedAdapterStub;
  }

  /**
   * The adapter for a send. A disposed controller waits for a restart in
   * progress, then sends through the replacement, or gets undefined when
   * nothing replaced its adapter.
   */
  private async adapterForSend(): Promise<MessagingAdapter | undefined> {
    if (!this.context.disposed) return this.options.adapter;
    const replacement = this.options.replacementAdapter?.now()
      ?? await this.options.replacementAdapter?.settled();
    return replacement && replacement !== this.options.adapter
      ? replacement
      : undefined;
  }

  async deliver(
    intent: MessagingSurfaceIntent,
    binding?: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    guard?: MessagingDeliveryGuard,
  ): Promise<MessagingDeliveryResult> {
    if (binding && shouldFlushToolUpdatesBeforeIntent(intent)) {
      await this.context.flushToolUpdatesForBinding(binding, { clear: false });
      // A question asked without pausing the turn leaves the agent working.
      if (
        intent.kind === "approval"
        || (intent.kind === "questionnaire" && !intent.asyncReply)
      ) {
        await this.context.markWorkingCardWaiting(binding);
      }
    }
    const displayIntent = binding?.backend === "codex"
      ? stripCodexGitActionDirectivesFromMessagingIntent(intent)
      : intent;
    if (!displayIntent) {
      return {
        channel: binding?.channel.channel ?? this.options.channel ?? "telegram",
        deliveredAt: this.context.now(),
        outcome: "discarded",
      };
    }
    const routedIntent = this.withRoutingAudit(displayIntent, binding, event);
    const consumeDeliveryBudget = shouldConsumeDeliveryBudget(routedIntent);
    // A disposed controller budgets against the adapter that will send, not
    // the stopped-adapter stub, which has no scope and would skip cool-off.
    const scopeAdapter = this.context.disposed
      ? await this.adapterForSend()
      : this.options.adapter;
    if (!scopeAdapter) {
      return {
        channel: binding?.channel.channel ?? this.options.channel ?? "telegram",
        deliveredAt: this.context.now(),
        outcome: "discarded",
      };
    }
    const scope = scopeAdapter.resolveDeliveryScope?.(routedIntent);
    const priority = messagingDeliveryPriority(routedIntent, {
      userInitiated: isUserInitiatedDeliveryEvent(event),
    });
    const channel = binding?.channel.channel ??
      routedIntent.audit?.channel.channel ??
      this.options.channel;
    const cancelledResult = (): MessagingDeliveryResult => ({
      channel: channel ?? "telegram",
      deliveredAt: this.context.now(),
      outcome: "discarded",
    });
    // Deferrable deliveries the budget holds back wait in one line per scope,
    // so they reach the provider in the order they were requested, across
    // cool-off extensions and adapter restarts alike. The ticket is held
    // until the provider call returns, and released on every exit.
    const lane: DeliveryLaneState = {
      lane: this.deliveryBudget && isDeferrableDeliveryPriority(priority)
        ? this.options.deliveryLane
        : undefined,
    };
    try {
      return await this.deliverThroughBudget({
        binding,
        cancelledResult,
        channel,
        consumeDeliveryBudget,
        guard,
        intent,
        lane,
        priority,
        routedIntent,
        scope,
      });
    } finally {
      lane.ticket?.release();
    }
  }

  private async deliverThroughBudget(params: {
    binding: MessagingBindingRecord | undefined;
    cancelledResult: () => MessagingDeliveryResult;
    channel: MessagingChannelKind | undefined;
    consumeDeliveryBudget: boolean;
    guard: MessagingDeliveryGuard | undefined;
    intent: MessagingSurfaceIntent;
    lane: DeliveryLaneState;
    priority: MessagingDeliveryPriority;
    routedIntent: MessagingSurfaceIntent;
    scope: MessagingDeliveryScope | undefined;
  }): Promise<MessagingDeliveryResult> {
    const {
      binding,
      cancelledResult,
      channel,
      consumeDeliveryBudget,
      guard,
      intent,
      lane,
      priority,
      routedIntent,
    } = params;
    let { scope } = params;
    const waitForTurn = async (): Promise<boolean> => {
      if (lane.ticket || !lane.lane || !scope) return true;
      lane.ticket = lane.lane.enter(scope.id);
      if (guard?.whenCancelled) {
        await Promise.race([lane.ticket.ready, guard.whenCancelled]);
      } else {
        await lane.ticket.ready;
      }
      return !guard?.isCancelled();
    };
    while (true) {
      if (guard?.isCancelled()) {
        return cancelledResult();
      }
      if (this.deliveryBudget) {
        const budgetChannel = channel ?? scope?.platform ?? "telegram";
        if (scope && lane.lane?.isOccupied(scope.id) && !(await waitForTurn())) {
          return cancelledResult();
        }
        let admission = this.deliveryBudget.admit({
          consumeCapacity: consumeDeliveryBudget,
          priority,
          scope,
        });
        while (admission.outcome === "deferred") {
          const budgetEvent: MessagingControllerDeliveryBudgetEvent = {
            at: this.context.now(),
            backend: binding?.backend,
            federationTarget: binding?.federatedThread?.target,
            bindingId: binding?.id ?? intent.bindingId,
            channel: budgetChannel,
            conversation: binding?.channel.conversation,
            intentId: routedIntent.id,
            intentKind: routedIntent.kind,
            outcome: "deferred",
            priority,
            reason: admission.reason,
            retryAt: admission.retryAt,
            scope,
            slowMode: admission.slowMode,
            threadId: binding?.threadId,
          };
          this.context.logger.info?.("messaging delivery budget deferred intent", {
            bindingId: binding?.id ?? intent.bindingId,
            delayMs: Math.max(0, admission.retryAt - this.context.now()),
            intentId: routedIntent.id,
            intentKind: routedIntent.kind,
            priority,
            retryAt: admission.retryAt,
            scopeId: scope?.id,
            slowMode: admission.slowMode,
          });
          this.notifyDeliveryBudgetEvent(budgetEvent);
          if (!lane.ticket && lane.lane && scope) {
            // Take a place in line, then ask again: time may have passed.
            if (!(await waitForTurn())) {
              return cancelledResult();
            }
            admission = this.deliveryBudget.admit({
              consumeCapacity: consumeDeliveryBudget,
              priority,
              scope,
            });
            continue;
          }
          const delay = (this.options.sleepUntil ?? sleepUntil)(
            admission.retryAt,
            this.context.clock,
          );
          if (guard?.whenCancelled) {
            await Promise.race([delay, guard.whenCancelled]);
          } else {
            await delay;
          }
          if (guard?.isCancelled()) {
            return cancelledResult();
          }
          admission = this.deliveryBudget.admit({
            consumeCapacity: consumeDeliveryBudget,
            priority,
            scope,
          });
        }
        if (admission.outcome !== "admitted") {
          const budgetEvent: MessagingControllerDeliveryBudgetEvent = {
            at: this.context.now(),
            backend: binding?.backend,
            federationTarget: binding?.federatedThread?.target,
            bindingId: binding?.id ?? intent.bindingId,
            channel: budgetChannel,
            conversation: binding?.channel.conversation,
            intentId: routedIntent.id,
            intentKind: routedIntent.kind,
            outcome: "dropped",
            priority,
            reason: admission.reason,
            scope,
            slowMode: admission.slowMode,
            threadId: binding?.threadId,
          };
          this.context.logger.debug?.("messaging delivery budget skipped intent", {
            bindingId: binding?.id ?? intent.bindingId,
            intentId: routedIntent.id,
            intentKind: routedIntent.kind,
            outcome: admission.outcome,
            priority,
            reason: admission.outcome === "dropped" ? admission.reason : undefined,
            scopeId: scope?.id,
            slowMode: admission.slowMode,
          });
          this.notifyDeliveryBudgetEvent(budgetEvent);
          return {
            channel: channel ?? "telegram",
            deliveredAt: this.context.now(),
            outcome: "discarded",
          };
        }
      }
      if (guard?.isCancelled()) {
        return cancelledResult();
      }
      const adapter = await this.adapterForSend();
      if (!adapter) {
        this.context.logger.info?.("messaging delivery discarded: adapter stopped and nothing replaced it", {
          bindingId: binding?.id ?? intent.bindingId,
          intentId: routedIntent.id,
          intentKind: routedIntent.kind,
        });
        return cancelledResult();
      }
      if (guard?.isCancelled()) {
        return cancelledResult();
      }
      const result = await adapter.deliver(routedIntent);
      if (guard?.isCancelled()) {
        await guard.onCancelledDelivery?.(result);
        return cancelledResult();
      }
      this.logDeliveryResult(routedIntent, binding, result);
      if (this.deliveryBudget && result.rateLimit) {
        if (lane.ticket && result.rateLimit.scope.id !== scope?.id) {
          // The retry belongs in the new scope's line, not the old one's.
          lane.ticket.release();
          lane.ticket = undefined;
        }
        scope = result.rateLimit.scope;
        this.deliveryBudget.recordRateLimit(result.rateLimit);
        if (result.rateLimit.retryable === true) {
          this.context.logger.debug?.("messaging delivery rate-limited; rechecking budget", {
            bindingId: binding?.id ?? intent.bindingId,
            intentId: routedIntent.id,
            intentKind: routedIntent.kind,
            priority,
            retryAfterMs: result.rateLimit.retryAfterMs,
            scopeId: result.rateLimit.scope.id,
          });
          continue;
        }
        this.context.logger.debug?.("messaging delivery rate-limited; not retrying non-replayable attempt", {
          bindingId: binding?.id ?? intent.bindingId,
          intentId: routedIntent.id,
          intentKind: routedIntent.kind,
          priority,
          retryAfterMs: result.rateLimit.retryAfterMs,
          scopeId: result.rateLimit.scope.id,
        });
      }
      await this.options.store.recordDelivery({
        ...result,
        id: `delivery:${routedIntent.id}:${randomUUID()}`,
        bindingId: binding?.id ?? intent.bindingId,
        intentId: routedIntent.id,
      });
      this.recordOutboundActivity(routedIntent, binding, result);
      if (
        binding &&
        result.channel === binding.channel.channel &&
        !guard?.isCancelled() &&
        isPermanentMessagingTargetFailure(result)
      ) {
        await this.options.store.revokeBinding({
          bindingId: binding.id,
          revokedAt: this.context.now(),
        });
        await this.context.recordBindingTransition("unbound", binding);
        this.context.notifyBindingChanged("permanent-delivery-failure");
        this.context.logger.debug?.("messaging binding revoked after permanent delivery failure", {
          bindingId: binding.id,
          channel: binding.channel.channel,
          conversationId: binding.channel.conversation.id,
          errorMessage: result.errorMessage,
          outcome: result.outcome,
          threadId: binding.threadId,
        });
      }
      return result;
    }
  }

  async deliverArtifactForBinding(params: {
    artifact: MessagingArtifact;
    binding: MessagingBindingRecord;
    intentId: string;
  }): Promise<void> {
    const intent = buildArtifactDeliveryIntent({
      artifact: params.artifact,
      bindingId: params.binding.id,
      capabilityProfile: this.context.capabilityProfile,
      createdAt: this.context.now(),
      id: params.intentId,
    });
    const result = await this.deliver(intent, params.binding);
    if (!shouldRetryArtifactInline(intent, result)) {
      return;
    }
    this.context.logger.debug?.("messaging artifact attachment delivery failed; retrying inline fallback", {
      bindingId: params.binding.id,
      errorMessage: result.errorMessage,
      intentId: intent.id,
      kind: params.artifact.kind,
      outcome: result.outcome,
      threadId: params.binding.threadId,
    });
    await this.deliver(
      buildArtifactInlineFallbackIntent({
        artifact: params.artifact,
        bindingId: params.binding.id,
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        id: `${params.intentId}:inline-fallback`,
      }),
      params.binding,
    );
  }

  private logDeliveryResult(
    intent: MessagingSurfaceIntent,
    binding: MessagingBindingRecord | undefined,
    result: MessagingDeliveryResult,
  ): void {
    const logContext = {
      bindingId: binding?.id ?? intent.bindingId,
      channel: result.channel,
      errorMessage: result.errorMessage,
      intentId: intent.id,
      intentKind: intent.kind,
      outcome: result.outcome,
      surfaceId: result.surface?.id,
      threadId: binding?.threadId,
    };
    if (result.outcome === "failed") {
      this.context.logger.warn?.("messaging delivery failed", logContext);
    } else if (intent.kind === "stream_update" && !intent.stream.isFinal) {
      // A streaming turn edits its message roughly once a second for its whole
      // duration; logging every partial at info drowns the log. Keep the
      // per-partial deliveries at debug — the final stream + message stay info.
      this.context.logger.debug?.("messaging delivery completed", logContext);
    } else {
      this.context.logger.info?.("messaging delivery completed", logContext);
    }
  }

  private notifyDeliveryBudgetEvent(
    event: MessagingControllerDeliveryBudgetEvent,
  ): void {
    if (!this.options.onDeliveryBudgetEvent) return;
    try {
      this.options.onDeliveryBudgetEvent(event);
    } catch (error) {
      this.context.logger.debug?.("messaging delivery-budget listener threw", {
        error: error instanceof Error ? error.message : String(error),
        intentId: event.intentId,
        outcome: event.outcome,
      });
    }
  }

  private withRoutingAudit(
    intent: MessagingSurfaceIntent,
    binding?: MessagingBindingRecord,
    event?: MessagingInboundEvent,
  ): MessagingSurfaceIntent {
    const allowedActorIds = binding?.authorizedActorIds ?? (
      event ? [event.actor.platformUserId] : undefined
    );

    if (intent.audit || (!binding && !event)) {
      return allowedActorIds && !intent.allowedActorIds
        ? { ...intent, allowedActorIds }
        : intent;
    }

    const channel = binding?.channel ?? event?.channel;
    if (!channel) {
      return intent;
    }
    const targetRoutingState =
      event?.routingState ??
      (intent.kind === "activity" ? binding?.routingState : undefined);

    return {
      ...intent,
      audit: buildMessagingAuditContext({
        actor: event?.actor ?? {
          platformUserId: binding?.authorizedActorIds[0] ?? "unknown",
        },
        action: "intent.deliver",
        backend: binding?.backend,
        bindingId: binding?.id ?? intent.bindingId,
        channel,
        now: this.context.now(),
        threadId: binding?.threadId,
      }),
      ...(intent.targetSurface
        ? { targetSurface: intent.targetSurface }
        : targetRoutingState
          ? {
              targetSurface: {
                channel: channel.channel,
                id: event?.id ?? binding?.id ?? intent.id,
                state: targetRoutingState,
              },
            }
          : {}),
      ...(allowedActorIds ? { allowedActorIds } : {}),
    };
  }
}

function shouldFlushToolUpdatesBeforeIntent(intent: MessagingSurfaceIntent): boolean {
  if (intent.kind === "activity" || intent.kind === "dismiss") {
    return false;
  }
  if (
    intent.kind === "message" &&
    intent.role === "system" &&
    intent.id.startsWith("tool-update")
  ) {
    return false;
  }
  return true;
}

function stripCodexGitActionDirectivesFromMessagingIntent(
  intent: MessagingSurfaceIntent,
): MessagingSurfaceIntent | undefined {
  if (intent.kind === "message" && intent.role === "assistant") {
    let changed = false;
    const parts = intent.parts.map((part) => {
      if (part.type !== "text") {
        return part;
      }
      const text = stripCodexGitActionDirectives(part.text);
      if (text === part.text) {
        return part;
      }
      changed = true;
      return { ...part, text };
    });
    if (!changed) {
      return intent;
    }
    const hasDeliverablePart = parts.some(
      (part) => part.type !== "text" || part.text.trim().length > 0,
    );
    return hasDeliverablePart ? { ...intent, parts } : undefined;
  }

  if (intent.kind === "stream_update" && intent.role === "assistant") {
    const text = stripCodexGitActionDirectives(intent.text);
    if (text === intent.text) {
      return intent;
    }
    if (text.trim().length === 0) {
      return undefined;
    }
    return {
      ...intent,
      delta: undefined,
      text,
    };
  }

  return intent;
}

export function shouldConsumeDeliveryBudget(intent: MessagingSurfaceIntent): boolean {
  if (intent.kind === "stream_update" && !intent.stream.isFinal) {
    return false;
  }
  return intent.kind !== "activity";
}

export function messagingDeliveryPriority(
  intent: MessagingSurfaceIntent,
  context?: { userInitiated?: boolean },
): MessagingDeliveryPriority {
  switch (intent.kind) {
    case "approval":
      if (intent.decisions.length === 0) {
        return "routine_status";
      }
      return "critical_interactive";
    case "questionnaire":
    case "review":
      return "critical_interactive";
    case "stream_update":
      return intent.stream.isFinal ? "final_turn" : "stream_partial";
    case "working_card":
      return intent.card.isFinal ? "final_turn" : "tool_progress";
    case "message":
      if (intent.id.startsWith("assistant-resume-repost-important")) {
        return "user_command";
      }
      if (intent.id.startsWith("assistant-resume-repost")) {
        return "routine_status";
      }
      if (intent.role === "assistant") {
        return "final_turn";
      }
      if (intent.role === "system" && intent.id.startsWith("tool-update")) {
        return "tool_progress";
      }
      return "user_command";
    case "status":
      if (context?.userInitiated) {
        return "user_command";
      }
      if (intent.delivery?.mode === "present" && intent.delivery.pin === true) {
        return "user_command";
      }
      return "routine_status";
    case "activity":
    case "progress":
    case "dismiss":
      return "routine_status";
    case "thread_picker":
    case "project_picker":
    case "single_select":
    case "multi_select":
    case "confirmation":
    case "error":
      return "user_command";
  }
}

function isUserInitiatedDeliveryEvent(
  event: MessagingInboundEvent | undefined,
): boolean {
  return Boolean(
    event &&
      (event.kind === "callback" ||
        event.kind === "command" ||
        event.kind === "media" ||
        event.kind === "text"),
  );
}

function sleepUntil(
  retryAt: number,
  now: () => number,
): Promise<void> {
  const delayMs = Math.max(0, retryAt - now());
  if (delayMs === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function shouldRetryArtifactInline(
  intent: MessagingArtifactMessageIntent,
  result: MessagingDeliveryResult,
): boolean {
  return (
    intent.artifactDelivery.mode === "attachment_summary" &&
    (result.outcome === "failed" || result.outcome === "unsupported")
  );
}

function shouldRecordOutboundActivity(
  intent: MessagingSurfaceIntent,
  result: MessagingDeliveryResult,
): boolean {
  if (
    result.outcome === "discarded" ||
    result.outcome === "failed" ||
    result.outcome === "unsupported" ||
    result.outcome === "dismissed"
  ) {
    return false;
  }
  if (intent.kind === "stream_update" && !intent.stream.isFinal) {
    return false;
  }
  return intent.kind !== "activity" && intent.kind !== "dismiss";
}
