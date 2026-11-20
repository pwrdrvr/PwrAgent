import { correspondenceNotice } from "./messaging-thread-notifications";
import { rememberBoundedMap } from "../../bounded-map";
import { readCodexAsyncQuestionRepliesFromNotification, readCodexAsyncQuestionsFromNotification, readProviderResponseBlockNotification } from "@pwragent/shared";
import type { AgentEvent, ThreadIncomingWorkSummary, AppServerThreadPlanEntry, AppServerThreadReviewEntry } from "@pwragent/shared";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import { buildErrorIntent } from "./messaging-renderer.js";
import { artifactFromPlanEntry, artifactFromReviewEntry } from "./messaging-artifact-renderer.js";
import { artifactFromMarkdownFileSelection, MessagingMarkdownFileAttachmentSelector } from "./messaging-markdown-file-attachment-selector.js";
import { resolveMessagingToolUpdateMode } from "./messaging-status-card.js";
import { threadKeyForBinding } from "./messaging-turn-admission.js";
import {
  threadIdForBackendEvent,
  isPrivateTaskMonitorEvent,
  taskMonitorLifecycleActivityForBackendEvent,
  turnIdForBackendEvent,
  scheduledActionForBackendEvent,
  bindingMatchesFederationTarget,
  bindingMatchesScheduledActionOrigin,
  turnQueueUpdateForBackendEvent,
  threadKeyForBackendEvent,
  artifactTurnKey,
  isReviewTurnMarkerEvent,
  rememberBoundedKey,
  MAX_TRACKED_REVIEW_TURNS,
  reviewArtifactForBackendEvent,
  assistantTextForBackendEvent,
  isNonFinalAssistantTextForBackendEvent,
  turnLifecycleForBackendEvent,
  isTerminalTurnLifecycle,
  readExecutionModeQueuedParams,
  readExecutionModeQueueClearedParams,
  reviewStartOutcomeForBackendEvent,
  automationRunUpdateForBackendEvent,
  planEntryForBackendEvent,
  isThreadStatusIdleEvent,
  assistantDeltaForBackendEvent,
  isUnphasedAssistantMessageEvent,
  agentMessagingTurnKey,
  isFinalAssistantImageResolutionEvent,
  errorTextForBackendEvent,
  isThreadNameUpdatedEvent,
  shouldRenderStatusForTurnStateChange,
  isTurnWorkActivityEvent,
  typingActivityRefreshMsForBackendEvent,
} from "./messaging-backend-event-helpers";
import type { MessagingBackendEventContext } from "./messaging-backend-event-context";

export class MessagingBackendEventRouter {
  private readonly reviewTurnKeys = new Set<string>();
  private readonly completedReviewTurnKeys = new Set<string>();
  // Codex emits a review result twice on the live protocol: first as an
  // exitedReviewMode artifact, then as the turn's final agentMessage. Hold the
  // pair by turn so messaging providers receive one enriched artifact intent.
  private readonly pendingReviewArtifactsByTurnKey = new Map<
    string,
    AppServerThreadReviewEntry
  >();
  private readonly pendingReviewAssistantTextByTurnKey = new Map<string, string>();
  private readonly planArtifactsByTurnKey = new Map<string, AppServerThreadPlanEntry>();
  private readonly markdownFileAttachmentSelector =
    new MessagingMarkdownFileAttachmentSelector();
  private readonly pendingTurnFailureHandlersByThreadKey = new Map<
    string,
    Set<Promise<void>>
  >();

  constructor(private readonly context: MessagingBackendEventContext) {}

  handleBackendEvent(event: AgentEvent): Promise<void> {
    const handling = this.handleBackendEventNow(event);
    const threadId = threadIdForBackendEvent(event);
    if (!threadId || event.notification.method !== "turn/failed") {
      return handling;
    }
    const threadKey = threadKeyForBackendEvent(event, threadId);
    let pending = this.pendingTurnFailureHandlersByThreadKey.get(threadKey);
    if (!pending) {
      pending = new Set();
      this.pendingTurnFailureHandlersByThreadKey.set(threadKey, pending);
    }
    pending.add(handling);
    const removePending = (): void => {
      pending.delete(handling);
      if (pending.size === 0) {
        this.pendingTurnFailureHandlersByThreadKey.delete(threadKey);
      }
    };
    void handling.then(removePending, removePending);
    return handling;
  }

  async waitForPendingTurnFailureHandlers(
    binding: MessagingBindingRecord,
  ): Promise<void> {
    const pending = this.pendingTurnFailureHandlersByThreadKey.get(
      threadKeyForBinding(binding),
    );
    if (pending?.size) {
      await Promise.allSettled([...pending]);
    }
  }

  dispose(): void {
    this.pendingTurnFailureHandlersByThreadKey.clear();
  }

  private async handleBackendEventNow(event: AgentEvent): Promise<void> {
    const threadId = threadIdForBackendEvent(event);
    if (!threadId && event.notification.method === "account/updated") {
      await this.context.host().refreshStatusSurfacesForBackend(
        event.backend,
        event.notification.method,
        event.federationTarget,
      );
      return;
    }
    if (!threadId && event.notification.method === "account/rateLimits/updated") {
      this.context.logger.debug?.("messaging skipped bound status refresh for backend rate limits", {
        backend: event.backend,
        method: event.notification.method,
      });
      return;
    }
    if (!threadId) {
      return;
    }
    if (
      event.notification.method === "item/transientMessage/updated"
      || event.notification.method === "thread/subAgents/updated"
      || isPrivateTaskMonitorEvent(event)
    ) {
      // Private monitor/sub-agent activity and transient transcript text
      // belong to desktop surfaces, not the parent messaging transcript.
      // It is intentionally not translated into a messaging intent: remote
      // delivery would give it durable-message queueing, retry, and budget
      // semantics that it must never inherit.
      return;
    }
    const asyncQuestionReplies = readCodexAsyncQuestionRepliesFromNotification(event.notification);
    if (asyncQuestionReplies) {
      await this.context.host().retireAnsweredAsyncQuestionnaires(
        event,
        threadId,
        asyncQuestionReplies,
      );
    }
    const scheduledAction = scheduledActionForBackendEvent(event);
    if (
      scheduledAction?.origin === "messaging"
      && scheduledAction.status === "failed"
    ) {
      const bindings = this.context.host().filterBindingsForChannel(
        await this.context.store.findActiveBindingsForThread({
          backend: event.backend,
          threadId,
        }),
      ).filter((binding) =>
        bindingMatchesFederationTarget(binding, event.federationTarget)
        && bindingMatchesScheduledActionOrigin(binding, scheduledAction)
      );
      for (const binding of bindings) {
        await this.context.host().deliver(
          buildErrorIntent({
            id: this.context.host().newIntentId("scheduled-message-dispatch-failed"),
            createdAt: this.context.now(),
            title: "Scheduled message could not be sent",
            body: [
              scheduledAction.displayText,
              scheduledAction.errorMessage
                ?? "The backend rejected the scheduled message.",
            ].filter(Boolean).join("\n\n"),
            recoverable: true,
          }),
          binding,
        );
      }
      return;
    }
    const eventTurnId = turnIdForBackendEvent(event);
    const turnQueueUpdate = turnQueueUpdateForBackendEvent(event);
    if (turnQueueUpdate) {
      if (turnQueueUpdate.queueEntryId && (turnQueueUpdate.status === "started" || turnQueueUpdate.status === "cancelled" || turnQueueUpdate.status === "failed")) {
        const key = `${threadKeyForBackendEvent(event, threadId)}:${turnQueueUpdate.queueEntryId}`;
        await this.context.host().applySharedQueueNoticeEvent(key, {
          type: "ownerOutcome", outcome: { status: turnQueueUpdate.status, turnId: turnQueueUpdate.turnId },
        });
      }
      await this.context.host().reconcileQueuedAgentMessagingOrigin({
        backend: event.backend,
        threadId,
        update: turnQueueUpdate,
      });
    }
    const eventTurnKey = eventTurnId
      ? artifactTurnKey(event.backend, threadId, eventTurnId)
      : undefined;
    if (eventTurnKey && isReviewTurnMarkerEvent(event)) {
      rememberBoundedKey(
        this.reviewTurnKeys,
        eventTurnKey,
        MAX_TRACKED_REVIEW_TURNS,
      );
    }
    const reviewTurnEvent = Boolean(
      eventTurnKey && this.reviewTurnKeys.has(eventTurnKey),
    );
    const reviewTurnCompleted = Boolean(
      eventTurnKey && this.completedReviewTurnKeys.has(eventTurnKey),
    );
    const reviewArtifact = reviewArtifactForBackendEvent(event, this.context.now());
    if (eventTurnKey && reviewArtifact && !reviewTurnCompleted) {
      rememberBoundedMap(
        this.pendingReviewArtifactsByTurnKey,
        eventTurnKey,
        reviewArtifact,
        MAX_TRACKED_REVIEW_TURNS,
      );
    }
    const rawAssistantText = assistantTextForBackendEvent(event);
    const isFinalReviewAssistant = Boolean(
      eventTurnKey
      && reviewTurnEvent
      && rawAssistantText
      && !isNonFinalAssistantTextForBackendEvent(event),
    );
    if (
      eventTurnKey
      && rawAssistantText
      && isFinalReviewAssistant
      && !reviewTurnCompleted
    ) {
      rememberBoundedMap(
        this.pendingReviewAssistantTextByTurnKey,
        eventTurnKey,
        rawAssistantText,
        MAX_TRACKED_REVIEW_TURNS,
      );
    }
    const lifecycle = turnLifecycleForBackendEvent(event, this.context.now());
    const pendingReviewArtifact = eventTurnKey
      ? this.pendingReviewArtifactsByTurnKey.get(eventTurnKey)
      : undefined;
    const pendingReviewAssistantText = eventTurnKey
      ? this.pendingReviewAssistantTextByTurnKey.get(eventTurnKey)
      : undefined;
    const reviewCompletionReady = Boolean(
      eventTurnKey
      && reviewTurnEvent
      && lifecycle?.status === "completed",
    );
    const reviewCompletionDiscarded = Boolean(
      eventTurnKey
      && reviewTurnEvent
      && isTerminalTurnLifecycle(lifecycle)
      && lifecycle?.status !== "completed",
    );
    const completedReviewArtifact = !eventTurnKey
      ? reviewArtifact
      : reviewCompletionReady && pendingReviewArtifact
        ? {
            ...pendingReviewArtifact,
            ...(pendingReviewAssistantText
              ? { review: pendingReviewAssistantText }
              : {}),
          }
        : undefined;
    const standaloneReviewAssistantText =
      reviewCompletionReady && !pendingReviewArtifact
        ? pendingReviewAssistantText
        : undefined;
    if ((reviewCompletionReady || reviewCompletionDiscarded) && eventTurnKey) {
      this.pendingReviewArtifactsByTurnKey.delete(eventTurnKey);
      this.pendingReviewAssistantTextByTurnKey.delete(eventTurnKey);
      rememberBoundedKey(
        this.completedReviewTurnKeys,
        eventTurnKey,
        MAX_TRACKED_REVIEW_TURNS,
      );
    }
    if (completedReviewArtifact && pendingReviewAssistantText) {
      this.context.logger.debug?.(
        "messaging grouped review artifact with final assistant text",
        {
          backend: event.backend,
          method: event.notification.method,
          threadId,
          turnId: eventTurnId,
        },
      );
    }
    if (event.notification.method === "thread/archived") {
      await this.context.store.revokeDefaultAgentAssignmentsForTarget({
        backend: event.backend,
        threadId,
        revokedAt: this.context.now(),
      });
    }
    if (event.notification.method === "thread/tokenUsage/updated") {
      this.context.host().rememberContextUsageSummary(event);
      return;
    }
    if (event.notification.method === "serverRequest/resolved") {
      await this.context.host().handleBackendRequestResolved(event);
      return;
    }
    const queuedParams = readExecutionModeQueuedParams(event.notification);
    if (queuedParams) {
      await this.context.host().handleExecutionModeQueued(event.backend, queuedParams);
      await this.context.host().refreshStatusSurfacesForThread(
        event.backend,
        threadId,
        event.notification.method,
        event.federationTarget,
      );
      return;
    }
    const queueClearedParams = readExecutionModeQueueClearedParams(event.notification);
    if (queueClearedParams) {
      await this.context.host().handleExecutionModeQueueCleared(event.backend, queueClearedParams);
      await this.context.host().refreshStatusSurfacesForThread(
        event.backend,
        threadId,
        event.notification.method,
        event.federationTarget,
      );
      return;
    }
    // Status surfaces show nothing about a hibernated checkout. A send from
    // a conversation restores it on the owner like any other send.
    if (event.notification.method === "thread/checkoutHibernation/updated") return;
    if (
      event.notification.method === "thread/executionMode/updated" ||
      event.notification.method === "thread/modelSettings/updated" ||
      event.notification.method === "thread/lock/updated" ||
      event.notification.method === "thread/rewound" ||
      event.notification.method === "thread/prAutoDispatch/updated" ||
      event.notification.method === "thread/prAutoDispatch/pendingUpdated" ||
      event.notification.method === "thread/codexEnvironment/updated" ||
      event.notification.method === "thread/parent/set" ||
      event.notification.method === "thread/parent/cleared" ||
      event.notification.method === "thread/subthreadOrder/updated" ||
      event.notification.method === "thread/subthreadsCollapsed/updated"
    ) {
      await this.context.host().refreshStatusSurfacesForThread(
        event.backend,
        threadId,
        event.notification.method,
        event.federationTarget,
      );
      return;
    }

    const persistentBindings = this.context.host().filterBindingsForChannel(
      await this.context.store.findActiveBindingsForThread({
        backend: event.backend,
        threadId,
      }),
    ).filter((binding) =>
      bindingMatchesFederationTarget(binding, event.federationTarget)
    );
    const bindings = this.context.host().bindingsForAgentTurn(
      event.backend,
      threadId,
      eventTurnId,
      persistentBindings,
    );
    // Supplemental delivery receipts are status, not final assistant answers.
    // Their full body and attachments remain available in the desktop transcript.
    const receipt = correspondenceNotice(event);
    if (receipt) {
      for (const binding of bindings) {
        const turnId = eventTurnId ?? this.context.host().getActiveTurn(binding)?.turnId;
        if (
          this.context.host().isTerminalPrivateResponseTurn(event.backend, threadId, turnId)
          || this.context.host().isPrivateResponseFallbackTurn(event.backend, threadId, turnId)
          || this.context.host().isPrivateReplyCompletionTurn(event.backend, threadId, turnId)
          || this.context.host().isAutomationTurn(event.backend, threadId, turnId)
        ) continue;
        const key = `${binding.id}\0${receipt.id}\0${receipt.state}`;
        if (this.context.host().deliveredThreadNoticeKeys.has(key)) continue;
        rememberBoundedKey(this.context.host().deliveredThreadNoticeKeys, key);
        if (receipt.state === "failed" || receipt.state === "held") {
          await this.context.host().deliver({
            id: this.context.host().newIntentId("thread-delivery"),
            kind: "message",
            bindingId: binding.id,
            createdAt: this.context.now(),
            role: "system",
            parts: [{ type: "text", text: receipt.text, markdown: "plain" }],
          }, binding);
          continue;
        }
        const mode = resolveMessagingToolUpdateMode(
          binding,
          await this.context.host().resolveToolUpdateDefaultMode(binding.targetKind ?? "thread"),
        );
        const activeTurn = this.context.host().getActiveTurn(binding);
        const sourceTurnActive = activeTurn?.turnId === turnId
          && (activeTurn?.status === "working" || activeTurn?.status === "waiting");
        const deliveries = this.context.host().toolUpdatePolicy.processActivity({
          ...(sourceTurnActive ? {} : { lifecycle: "window" as const }),
          activity: { id: key, kind: "tool", status: "completed", title: receipt.text },
          bindingId: binding.id,
          mode,
          turnId: turnId ?? receipt.id,
        });
        for (const delivery of deliveries) await this.context.host().deliverToolUpdateDelivery(delivery, binding);
      }
      return;
    }
    if (event.notification.method === "thread/incomingWork") {
      const params = event.notification.params as { deliveryId: string; incomingWork: ThreadIncomingWorkSummary };
      for (const binding of bindings) await this.context.host().deliverIncomingWork(binding, params.deliveryId, params.incomingWork);
      return;
    }
    // Monitor lifecycle notices are working activity, never parent turn
    // completions. Sharing the active turn also shares its Some allowance.
    const monitorLifecycle = taskMonitorLifecycleActivityForBackendEvent(event);
    if (monitorLifecycle) {
      // Remember suppression even without bindings: a monitor may complete
      // after its parent's private/automation tracking has been cleared.
      if (this.context.host().suppressTaskMonitorLifecycle(event, threadId, monitorLifecycle)) {
        return;
      }
      for (const binding of bindings) {
        const activeTurn = this.context.host().getActiveTurn(binding);
        if (this.context.host().suppressTaskMonitorLifecycle(
          event,
          threadId,
          monitorLifecycle,
          activeTurn?.turnId,
        )) {
          continue;
        }
        const turnId = activeTurn?.status === "working"
          ? activeTurn.turnId
          : `monitor-lifecycle:${threadId}`;
        const mode = resolveMessagingToolUpdateMode(
          binding,
          await this.context.host().resolveToolUpdateDefaultMode(binding.targetKind ?? "thread"),
        );
        const deliveries = this.context.host().toolUpdatePolicy.processActivity({
          activity: monitorLifecycle.activity,
          bindingId: binding.id,
          mode,
          turnId,
        });
        for (const delivery of deliveries) {
          await this.context.host().deliverToolUpdateDelivery(delivery, binding);
        }
      }
      return;
    }
    const reviewStartOutcome = reviewStartOutcomeForBackendEvent(event);
    if (reviewStartOutcome) {
      if (
        reviewStartOutcome.status === "failed"
        || reviewStartOutcome.status === "cancelled"
      ) {
        for (const binding of bindings) {
          await this.context.host().deliver(
            buildErrorIntent({
              id: this.context.host().newIntentId("queued-review-terminal"),
              createdAt: this.context.now(),
              title:
                reviewStartOutcome.status === "failed"
                  ? "Queued review could not start"
                  : "Queued review cancelled",
              body:
                reviewStartOutcome.error
                ?? (
                  reviewStartOutcome.status === "failed"
                    ? "The queued review failed to start."
                    : "The active turn did not complete successfully, so the queued review was cancelled."
                ),
              recoverable: reviewStartOutcome.status === "failed",
            }),
            binding,
          );
        }
      }
      return;
    }
    const automationRunUpdate = automationRunUpdateForBackendEvent(event);
    if (automationRunUpdate) {
      await this.context.host().handleAutomationRunUpdated({
        automationName: automationRunUpdate.automationName,
        bindings,
        errorMessage: automationRunUpdate.errorMessage,
        event,
        failureReason: automationRunUpdate.failureReason,
        runId: automationRunUpdate.runId,
        finalText: automationRunUpdate.finalText,
        outputDecision: automationRunUpdate.outputDecision,
        status: automationRunUpdate.status,
        suppressBindingBroadcast: automationRunUpdate.suppressBindingBroadcast,
      });
      return;
    }
    if (turnQueueUpdate) {
      const incomingWork = turnQueueUpdate.incomingWork ?? (turnQueueUpdate.messageOrigin?.kind === "agent"
        ? { messages: [{ origin: turnQueueUpdate.messageOrigin, preview: "Full instructions are in the thread." }], omittedMessageCount: 0 }
        : undefined);
      if (turnQueueUpdate.status === "started" && incomingWork) {
        for (const binding of bindings) await this.context.host().deliverIncomingWork(binding,
          turnQueueUpdate.queueEntryId ?? turnQueueUpdate.turnId ?? "incoming-work", incomingWork);
      }
      if (
        turnQueueUpdate.origin === "automation" &&
        turnQueueUpdate.messageOrigin?.kind !== "agent" &&
        turnQueueUpdate.status === "started" &&
        turnQueueUpdate.turnId
      ) {
        await this.context.host().handleAutomationTurnStarted({
          messageOrigin: turnQueueUpdate.messageOrigin,
          automationName: turnQueueUpdate.automationName,
          automationRunId: turnQueueUpdate.automationRunId,
          backend: event.backend,
          bindings,
          threadId,
          turnId: turnQueueUpdate.turnId,
          suppressBindingBroadcast: turnQueueUpdate.suppressBindingBroadcast,
        });
      }
      if (
        turnQueueUpdate.origin === "automation" &&
        turnQueueUpdate.messageOrigin?.kind !== "agent" &&
        turnQueueUpdate.status === "terminal" &&
        turnQueueUpdate.turnId
      ) {
        await this.context.host().handleAutomationTurnTerminal({
          automationRunId: turnQueueUpdate.automationRunId,
          backend: event.backend,
          bindings,
          event,
          finalText: turnQueueUpdate.finalText,
          threadId,
          turnId: turnQueueUpdate.turnId,
          suppressBindingBroadcast: turnQueueUpdate.suppressBindingBroadcast,
        });
      }
      return;
    }
    const planUpdate = planEntryForBackendEvent(event, this.context.now());
    if (planUpdate) {
      this.planArtifactsByTurnKey.set(
        artifactTurnKey(event.backend, threadId, planUpdate.turn?.id ?? planUpdate.id),
        planUpdate,
      );
    }
    const markdownFileArtifactSelection =
      this.markdownFileAttachmentSelector.selectFromBackendEvent(event);
    const completedPlan = lifecycle && isTerminalTurnLifecycle(lifecycle)
      ? this.planArtifactsByTurnKey.get(artifactTurnKey(event.backend, threadId, lifecycle.turnId))
      : undefined;
    for (const binding of bindings) {
      let activeTurn = this.context.host().getActiveTurn(binding);
      let turnStateChanged = false;
      const automationTurnEvent = this.context.host().isAutomationTurnEvent(
        event,
        binding,
        eventTurnId ?? lifecycle?.turnId ?? activeTurn?.turnId,
      );
      const observation = this.context.host().observeBackendTurn(binding, {
        type: "backend",
        lifecycle,
        automation: automationTurnEvent,
        idle: isThreadStatusIdleEvent(event),
        now: isThreadStatusIdleEvent(event) && activeTurn && (!lifecycle || automationTurnEvent)
          ? this.context.now() : 0,
      });
      activeTurn = observation.activeTurn;
      turnStateChanged = observation.changed;
      if (turnStateChanged) {
        this.context.host().logBindingTurnStateChange(
          binding,
          observation.previous,
          activeTurn,
          event.notification.method,
        );
      }

      const terminalPrivateResponse = this.context.host().isTerminalPrivateResponseTurn(
        event.backend,
        binding.threadId,
        eventTurnId ?? activeTurn?.turnId,
      );
      const privateResponseFallback = this.context.host().isPrivateResponseFallbackTurn(
        event.backend,
        binding.threadId,
        eventTurnId ?? activeTurn?.turnId,
      );
      const privateReplyCompletion = this.context.host().isPrivateReplyCompletionTurn(
        event.backend,
        binding.threadId,
        eventTurnId ?? activeTurn?.turnId,
      );
      const suppressSourceResponse =
        terminalPrivateResponse || privateResponseFallback;
      if (!suppressSourceResponse && !privateReplyCompletion) {
        await this.context.host().deliverToolActivityForBackendEvent(
          event,
          binding,
          activeTurn?.turnId,
        );
      }
      if (
        turnStateChanged &&
        (isTerminalTurnLifecycle(lifecycle) ||
          (isThreadStatusIdleEvent(event) && activeTurn))
      ) {
        const terminalTurnId = turnIdForBackendEvent(event) ?? activeTurn?.turnId;
        if (suppressSourceResponse && terminalTurnId) {
          this.context.host().toolUpdatePolicy.flush({
            bindingId: binding.id,
            clear: true,
            turnId: terminalTurnId,
          });
        } else {
          await this.context.host().flushToolUpdatesForBinding(binding, {
            clear: true,
            turnId: terminalTurnId,
          });
        }
        if (terminalTurnId) {
          await this.context.host().finalizeWorkingCard(
            binding,
            terminalTurnId,
            lifecycle?.status === "failed" || lifecycle?.status === "interrupted"
              ? "failed"
              : "completed",
          );
          this.context.host().clearTurnProse(binding.id, terminalTurnId);
          if (!privateResponseFallback) {
            const workingUpdateKey = this.context.host().turnProseKey(
              binding.id,
              terminalTurnId,
            );
            this.context.host().workingUpdateCancellationSignals.delete(workingUpdateKey);
            this.context.host().workingUpdateDeliveries.delete(workingUpdateKey);
            this.context.host().workingUpdateSurfaces.delete(workingUpdateKey);
            this.context.host().workingUpdateCancellationFailures.delete(workingUpdateKey);
          }
        }
      }

      if (isNonFinalAssistantTextForBackendEvent(event)) {
        // A provider may reveal the phase only at item completion. Keep the
        // legacy unphased live path, but do not flush its interim accumulator
        // as an answer on a later terminal event.
        const itemId = (event.notification.params as { item?: { id?: string } }).item?.id;
        await this.context.host().waitForAssistantStreamDeliveriesForEvent(event, binding);
        this.context.host().discardAssistantStreamItemForEvent(event, binding, itemId);
      }

      const assistantDelta = assistantDeltaForBackendEvent(event);
      if (
        assistantDelta
        && !reviewTurnEvent
        && !terminalPrivateResponse
        && !privateReplyCompletion
      ) {
        if (!automationTurnEvent) {
          await this.context.host().deliverAssistantStreamUpdate(assistantDelta, binding, {
            bufferOnly: privateResponseFallback,
          });
        }
      }

      const assistantText = standaloneReviewAssistantText ?? (
        isFinalReviewAssistant ? undefined : rawAssistantText
      );
      // A question waits on the operator, so it is delivered like a final
      // reply whatever its phase, never through the Working Updates dial.
      const asyncQuestions = readCodexAsyncQuestionsFromNotification(event.notification);
      const deliversAsReply =
        Boolean(asyncQuestions)
        || !isNonFinalAssistantTextForBackendEvent(event);
      if (
        assistantText
        && privateResponseFallback
        && !terminalPrivateResponse
        && !isNonFinalAssistantTextForBackendEvent(event)
      ) {
        const fallbackTurnId = eventTurnId ?? activeTurn?.turnId;
        if (fallbackTurnId && isUnphasedAssistantMessageEvent(event)) {
          // Only the first fallback is sent, and an unphased message can be a
          // progress note: Claude reports every message this way. Hold the
          // latest one until the turn ends.
          this.context.host().privateResponses.hold(
            agentMessagingTurnKey(event.backend, binding.threadId, fallbackTurnId),
            assistantText,
          );
        } else if (fallbackTurnId) {
          await this.context.host().deliverPrivateResponseFallback({
            binding,
            event,
            text: assistantText,
            turnId: fallbackTurnId,
          });
        }
      } else if (
        privateResponseFallback
        && !terminalPrivateResponse
        && isTerminalTurnLifecycle(activeTurn)
        && !assistantDelta
      ) {
        await this.context.host().waitForAssistantStreamDeliveriesForEvent(event, binding);
        const bufferedText = this.context.host().takeBufferedAssistantTextForTerminalEvent(
          event,
          binding,
        );
        const fallbackTurnId = eventTurnId ?? activeTurn?.turnId;
        const fallbackText = fallbackTurnId
          ? this.context.host().privateResponses.heldText(
              agentMessagingTurnKey(event.backend, binding.threadId, fallbackTurnId),
            ) ?? bufferedText
          : undefined;
        if (fallbackText && fallbackTurnId) {
          await this.context.host().deliverPrivateResponseFallback({
            binding,
            event,
            text: fallbackText,
            turnId: fallbackTurnId,
          });
        }
      } else if (
        assistantText
        && !suppressSourceResponse
        && (!privateReplyCompletion || deliversAsReply)
      ) {
        if (deliversAsReply) {
          // Claim the stable backend item before image resolution yields. A
          // nearly-simultaneous idle/terminal event may flush the same buffered
          // deltas while this lookup is in flight; both paths must contend for
          // one item identity before either can create a provider message.
          const assistantMessageClaimed = this.context.host().markAssistantMessageDelivered(
            event,
            binding,
            assistantText,
          );
          const assistantImages = await this.context.host().resolveAssistantMessageImages(
            assistantText,
            event,
            binding,
          );
          if (!assistantMessageClaimed) {
            await this.context.host().deliverAssistantImages(assistantImages, event, binding);
          } else if (asyncQuestions) {
            // Codex writes the questions into the message text as well; the
            // questionnaire presents the same content with answer controls.
            await this.context.host().deliverAsyncQuestionnaire(
              asyncQuestions,
              event,
              binding,
              eventTurnId ?? activeTurn?.turnId,
            );
            await this.context.host().deliverAssistantImages(assistantImages, event, binding);
          } else {
            const deliveredFinalStream = await this.context.host().flushAssistantStreamForEvent(
              event,
              binding,
              assistantText,
            );
            if (deliveredFinalStream) {
              await this.context.host().deliverAssistantImages(
                assistantImages,
                event,
                binding,
                undefined,
                true,
              );
            } else {
              await this.context.host().deliverAssistantMessage(
                assistantText,
                event,
                binding,
                assistantImages,
                undefined,
                true,
                true,
              );
            }
          }
        } else if (!automationTurnEvent) {
          // NON-final agentMessage completions (commentary and partial answers
          // the agent emits while thinking) are the agent's in-turn prose. They
          // flow through the Working Updates dial: suppressed at None, coalesced
          // into batches at Less/Some/More, sent individually at All — the same
          // policy that governs tool activity. This replaces the old outright
          // drop that was added to stop the "pinged a dozen times" flood; the
          // coalescing preserves that anti-flood intent at low dial settings.
          await this.context.host().deliverAssistantProseForBackendEvent(
            event,
            binding,
            assistantText,
            activeTurn?.turnId,
          );
        }
      } else {
        if (
          !suppressSourceResponse &&
          isFinalAssistantImageResolutionEvent(event)
          && !reviewTurnEvent
        ) {
          const assistantImages = await this.context.host().resolveAssistantMessageImages(
            "",
            event,
            binding,
          );
          await this.context.host().deliverAssistantImages(assistantImages, event, binding);
        }
        if (
          !suppressSourceResponse &&
          isTerminalTurnLifecycle(activeTurn)
          && !assistantDelta
          && !reviewTurnEvent
        ) {
          // Only flush buffered stream text on a genuine terminal event (e.g.
          // turn/completed, idle) — never on an assistant delta. Deltas are
          // mid-stream content owned by deliverAssistantStreamUpdate's buffer;
          // when the turn lifecycle is already terminal but the backend keeps
          // emitting deltas, letting each delta run the terminal flush re-posts
          // the (growing) buffer as a brand-new message every time — the
          // multi-message channel flood (and the budget starvation it caused).
          await this.context.host().waitForAssistantStreamDeliveriesForEvent(event, binding);
          await this.context.host().flushBufferedAssistantStreamsForTerminalEvent(event, binding);
        }
      }

      // Automation turns surface their own terminal output (incl. errors) via
      // handleAutomationTurnTerminal, so skip them here to avoid a double post.
      if (
        !suppressSourceResponse
        && !automationTurnEvent
        && activeTurn?.status === "failed"
      ) {
        const turnFailureText = errorTextForBackendEvent(event);
        if (turnFailureText) {
          await this.context.host().deliverTurnFailureMessage(turnFailureText, event, binding);
        }
      }

      // A recovered content-filter block changes what the agent answers, so
      // say why. A block that ends the turn is reported as the turn failure.
      const responseBlock = readProviderResponseBlockNotification(event.notification);
      if (
        responseBlock
        && !responseBlock.turnEnded
        && !suppressSourceResponse
        && !automationTurnEvent
      ) {
        await this.context.host().deliverResponseBlockedNotice(responseBlock, event, binding);
      }

      if (completedPlan && !automationTurnEvent && !suppressSourceResponse) {
        await this.context.host().deliverArtifactForBinding({
          artifact: artifactFromPlanEntry(completedPlan),
          binding,
          intentId: `artifact:plan:${completedPlan.turn?.id ?? completedPlan.id}:${binding.id}`,
        });
      }

      if (
        completedReviewArtifact
        && !automationTurnEvent
        && !suppressSourceResponse
      ) {
        await this.context.host().deliverArtifactForBinding({
          artifact: artifactFromReviewEntry(completedReviewArtifact),
          binding,
          intentId: `artifact:review:${completedReviewArtifact.id}:${binding.id}`,
        });
      }

      if (
        markdownFileArtifactSelection
        && !automationTurnEvent
        && !suppressSourceResponse
      ) {
        await this.context.host().deliverArtifactForBinding({
          artifact: artifactFromMarkdownFileSelection(markdownFileArtifactSelection),
          binding,
          intentId: `artifact:markdown-file:${markdownFileArtifactSelection.path}:${binding.id}`,
        });
      }

      if (isThreadNameUpdatedEvent(event)) {
        await this.context.host().renderAutomaticBindingStatus(
          binding,
          undefined,
          await this.context.host().threadContextWithNameFromEvent(binding, event),
        );
        continue;
      }

      // A terminal private response owns the visible completion for this turn.
      // Backend work events may continue after the tool returns, but must not
      // re-arm provider typing/activity on either the source binding or the
      // newly-created private continuation. Terminal lifecycle still flows
      // through below so any existing activity lease is explicitly cleared.
      if (suppressSourceResponse && activeTurn?.status === "working") {
        continue;
      }

      if (turnStateChanged && (lifecycle || (isThreadStatusIdleEvent(event) && activeTurn))) {
        await this.context.host().signalTurnActivity(binding, activeTurn!, {
          reason: event.notification.method,
          force: true,
        });
        if (shouldRenderStatusForTurnStateChange(event, lifecycle)) {
          await this.context.host().renderAutomaticBindingStatus(binding);
        }
      } else if (activeTurn?.status === "waiting" && isTurnWorkActivityEvent(event, activeTurn)) {
        const previousTurn = activeTurn;
        activeTurn = {
          ...activeTurn,
          status: "working",
          updatedAt: this.context.now(),
        };
        this.context.host().setActiveTurn(binding, activeTurn);
        this.context.host().logBindingTurnStateChange(
          binding,
          previousTurn,
          activeTurn,
          event.notification.method,
        );
        await this.context.host().signalTurnActivity(binding, activeTurn, {
          reason: event.notification.method,
          force: true,
        });
      } else {
        const latestActiveTurn = this.context.host().getActiveTurn(binding);
        if (latestActiveTurn?.status !== "working") {
          continue;
        }
        if (eventTurnId && latestActiveTurn.turnId !== eventTurnId) {
          continue;
        }
        await this.context.host().signalTurnActivity(binding, latestActiveTurn, {
          reason: event.notification.method,
          refreshMs: typingActivityRefreshMsForBackendEvent(event),
        });
      }
    }
    if (lifecycle && isTerminalTurnLifecycle(lifecycle)) {
      const turnKey = agentMessagingTurnKey(
        event.backend,
        threadId,
        lifecycle.turnId,
      );
      const origin = this.context.host().activeAgentMessagingOriginsByTurnKey.get(turnKey);
      if (origin?.privateReplyContinuationBindingId) {
        await this.context.host().completePrivateReplyContinuation(
          origin.privateReplyContinuationBindingId,
        );
      }
      this.context.host().privateResponses.completeReply(turnKey);
      this.context.host().forgetAutomationTurn(event.backend, threadId, lifecycle.turnId);
      this.context.host().forgetAgentMessagingOrigin(event.backend, threadId, lifecycle.turnId);
      this.planArtifactsByTurnKey.delete(artifactTurnKey(event.backend, threadId, lifecycle.turnId));
    }
  }
}
