import type { MessagingPendingRequestContext } from "./messaging-pending-request-context";
import { isMessagingInteractivePendingRequest } from "./messaging-pending-request";
import { messageOriginForInboundEvent } from "./messaging-command-helpers";
import { threadIdForBackendEvent, bindingMatchesFederationTarget, federationTargetForBinding, isTerminalTurnLifecycle } from "./messaging-backend-event-helpers";
import {
  codexAsyncQuestionItemId,
  formatCodexAsyncQuestionReply,
  isCodexAsyncQuestionAnswered,
  summarizeCodexAsyncQuestionReply,
  type CodexAsyncQuestion,
  type CodexAsyncQuestionReply,
} from "@pwragent/shared/codex-async-questions";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  AppServerTurnInputItem,
  AppServerBackendKind,
  AppServerPendingRequestNotification,
  AppServerToolRequestUserInputNotification,
  ThreadIdentifier,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { MessagingBindingRecord, MessagingActiveTurnSummary, MessagingApprovalDecision, MessagingDeliveryResult, MessagingInboundCallbackEvent, MessagingInboundTextEvent, MessagingPendingIntentRecord, MessagingQuestionnaireAnswer, MessagingQuestionnaireIntent, MessagingSurfaceAction, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { messagingQuestionnaireAnswerComplete, normalizeMessagingQuestionnaireIntent } from "@pwragent/messaging-interface";
import type { MessagingThreadAdmissionState } from "./messaging-adapter.js";
import { buildApprovalIntent, buildAsyncQuestionnaireIntent, buildConfirmationIntent, buildErrorIntent, buildQuestionnaireIntent } from "./messaging-renderer.js";
import { buildMessagingAuditContext } from "./messaging-audit.js";
import { threadKeyForBinding } from "./messaging-turn-admission.js";
import { questionnaireAnswerValue, approvalBodyWithResponse } from "./messaging-pending-request-helpers";

export class MessagingPendingRequestWorkflow {
  private readonly pendingRequestPresentations = new Map<string, Promise<void>>();

  constructor(private readonly context: MessagingPendingRequestContext) {}

  async handleBackendPendingRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
    federationTarget?: FederationTarget,
  ): Promise<void> {
    const key = JSON.stringify([
      backend,
      request.params.threadId,
      request.params.requestId,
      federationTarget?.scope === "remote" ? federationTarget.instanceId : undefined,
    ]);
    const existing = this.pendingRequestPresentations.get(key);
    if (existing) {
      await existing;
      return;
    }
    // Reserve before the first store read completes so overlapping redisplays
    // cannot both create an intent for the same backend request.
    const presentation = this.presentBackendPendingRequest(backend, request, federationTarget);
    this.pendingRequestPresentations.set(key, presentation);
    try {
      await presentation;
    } finally {
      this.pendingRequestPresentations.delete(key);
    }
  }

  async presentBackendPendingRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
    federationTarget?: FederationTarget,
  ): Promise<void> {
    const persistentBindings = this.context.host().filterBindingsForChannel(
      await this.context.store.findActiveBindingsForThread({
        backend,
        threadId: request.params.threadId,
      }),
    ).filter((binding) =>
      bindingMatchesFederationTarget(binding, federationTarget)
    );
    const bindings = this.context.host().bindingsForAgentTurn(
      backend,
      request.params.threadId,
      request.params.turnId ?? undefined,
      persistentBindings,
    );

    const existingIntents = await this.context.store.findActivePendingIntentsForRequest({
      backend,
      threadId: request.params.threadId,
      requestId: request.params.requestId,
      now: this.context.now(),
    });
    for (const binding of bindings) {
      // Desktop transcript recovery also reaches messaging. Keep the existing
      // actionable message and any questionnaire answers for this binding.
      if (existingIntents.some((intent) => intent.bindingId === binding.id)) {
        continue;
      }
      const intent = this.intentForPendingRequest(request);
      if (!intent) {
        continue;
      }
      intent.bindingId = binding.id;
      intent.requestContext = {
        backend,
        method: request.method,
        requestId: request.params.requestId,
        threadId: request.params.threadId,
        turnId: request.params.turnId ?? undefined,
      };
      intent.audit = buildMessagingAuditContext({
        action: "pending_request.presented",
        actor: {
          platformUserId: binding.authorizedActorIds[0] ?? "unknown",
        },
        backend,
        bindingId: binding.id,
        channel: binding.channel,
        now: this.context.now(),
        threadId: request.params.threadId,
      });
      if (request.params.turnId) {
        const threadStatus = await this.context.host().readBackendThreadStatus(binding);
        if (threadStatus === "idle") {
          await this.context.host().reconcileIdleTurn(binding, "pending_request");
          continue;
        }
      }
      const pendingIntent = await this.context.host().storePendingIntent(intent, binding);
      await this.context.host().flushPendingTurnProseBeforeElicitation(
        binding,
        request.params.turnId,
      );
      // An approval card keeps a delivery receipt, so one the adapter could
      // not send is presented again while the approval is still pending.
      const delivery = await this.context.host().deliver(
        intent,
        binding,
        undefined,
        undefined,
        intent.kind === "approval"
          ? {
              identity: {
                kind: "approval",
                backend,
                bindingId: binding.id,
                pendingIntentId: pendingIntent.id,
                threadId: request.params.threadId,
                ...(request.params.turnId ? { turnId: request.params.turnId } : {}),
              },
            }
          : undefined,
      );
      let deliveredPendingIntent = pendingIntent;
      if (delivery.surface) {
        deliveredPendingIntent = {
          ...pendingIntent,
          surface: delivery.surface,
        };
        await this.context.store.upsertPendingIntent(deliveredPendingIntent);
      }
      if (request.params.turnId) {
        const reconciledTurn = await this.context.host().reconcileActiveTurnFromBackendStatus(
          binding,
          "pending_request",
        );
        if (isTerminalTurnLifecycle(reconciledTurn)) {
          await this.retireStalePendingIntent(deliveredPendingIntent);
          continue;
        }
        const threadStatus = await this.context.host().readBackendThreadStatus(binding);
        if (threadStatus === "idle") {
          await this.retireStalePendingIntent(deliveredPendingIntent);
          await this.context.host().reconcileIdleTurn(binding, "pending_request");
          continue;
        }
        const activeTurn: MessagingActiveTurnSummary = {
          turnId: request.params.turnId,
          status: "waiting",
          updatedAt: this.context.now(),
        };
        this.context.host().setActiveTurn(binding, activeTurn);
        await this.context.host().signalTurnActivity(binding, activeTurn, {
          force: true,
        });
        await this.context.host().renderAutomaticBindingStatus(binding);
      }
    }
  }

  async handleQuestionnaireTextAnswer(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundTextEvent,
  ): Promise<boolean> {
    if (pendingIntent.intent.kind !== "questionnaire") {
      return false;
    }

    const intent = normalizeMessagingQuestionnaireIntent(pendingIntent.intent);
    const question = intent.questions[intent.currentIndex];
    const value = event.text.trim();
    if (intent.phase !== "answering" || !question?.allowFreeform || !value) {
      return false;
    }
    const binding = pendingIntent.bindingId ? await this.context.store.getBinding(pendingIntent.bindingId) : undefined;
    if (binding && !await this.context.host().admitBoundAgentTrust(event, binding)) return true;

    const updated = this.questionnaireWithRecordedAnswer(intent, {
      kind: "custom",
      value,
    });
    if (this.questionnaireReadyToSubmit(updated)) {
      await this.submitAndRetireQuestionnaire(pendingIntent, updated, event);
      return true;
    }

    await this.updateQuestionnairePendingIntent(pendingIntent, updated, event);
    return true;
  }

  async handleQuestionnaireAction(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundCallbackEvent,
    action: MessagingSurfaceAction,
  ): Promise<void> {
    if (pendingIntent.intent.kind !== "questionnaire") {
      return;
    }
    const binding = pendingIntent.bindingId ? await this.context.store.getBinding(pendingIntent.bindingId) : undefined;
    if (binding && !await this.context.host().admitBoundAgentTrust(event, binding)) return;

    const intent = normalizeMessagingQuestionnaireIntent(pendingIntent.intent);
    if (action.id === "questionnaire:skip") {
      if (intent.asyncReply) {
        await this.context.store.deletePendingIntent(pendingIntent.id);
        await this.deliverQuestionnaireIntent(
          pendingIntent,
          { ...intent, phase: "skipped" },
          event,
        );
      }
      return;
    }

    if (action.id === "questionnaire:back") {
      await this.updateQuestionnairePendingIntent(
        pendingIntent,
        this.questionnaireWithPreviousQuestion(intent),
        event,
      );
      return;
    }

    if (action.id === "questionnaire:next") {
      await this.updateQuestionnairePendingIntent(
        pendingIntent,
        this.questionnaireWithNextQuestion(intent),
        event,
      );
      return;
    }

    if (action.id === "questionnaire:submit") {
      if (!this.questionnaireReadyToSubmit(intent)) {
        await this.context.host().deliver(
          buildConfirmationIntent({
            id: this.context.host().newIntentId("questionnaire-incomplete"),
            capabilityProfile: this.context.capabilityProfile,
            createdAt: this.context.now(),
            title: "Answer each question",
            body: "Review the input request and answer every question before submitting.",
            fallbackText: "Answer each question before submitting.",
          }),
          undefined,
          event,
        );
        return;
      }

      await this.submitAndRetireQuestionnaire(pendingIntent, intent, event);
      return;
    }

    const updated = this.questionnaireWithOptionAnswer(intent, action.id);
    if (updated !== intent) {
      if (this.questionnaireReadyToSubmit(updated)) {
        await this.submitAndRetireQuestionnaire(pendingIntent, updated, event);
        return;
      }

      await this.updateQuestionnairePendingIntent(pendingIntent, updated, event);
    }
  }

  questionnaireWithOptionAnswer(
    intent: MessagingQuestionnaireIntent,
    optionId: string,
  ): MessagingQuestionnaireIntent {
    if (intent.phase !== "answering") {
      return intent;
    }

    const question = intent.questions[intent.currentIndex];
    const option = question?.options.find((candidate) => candidate.id === optionId);
    if (!option) {
      return intent;
    }

    return this.questionnaireWithRecordedAnswer(intent, {
      kind: "option",
      optionId: option.id,
      value: typeof option.value === "string" ? option.value : option.label,
    });
  }

  questionnaireWithRecordedAnswer(
    intent: MessagingQuestionnaireIntent,
    answer: MessagingQuestionnaireAnswer,
  ): MessagingQuestionnaireIntent {
    const answers = [...intent.answers];
    answers[intent.currentIndex] = answer;

    const nextIndex = intent.currentIndex + 1;
    if (nextIndex < intent.questions.length) {
      return {
        ...intent,
        answers,
        currentIndex: nextIndex,
        phase: "answering",
      };
    }

    return {
      ...intent,
      answers,
      phase: "answering",
    };
  }

  questionnaireWithNextQuestion(
    intent: MessagingQuestionnaireIntent,
  ): MessagingQuestionnaireIntent {
    if (intent.phase !== "answering") {
      return intent;
    }
    if (!messagingQuestionnaireAnswerComplete(intent.answers[intent.currentIndex])) {
      return intent;
    }
    if (intent.currentIndex >= intent.questions.length - 1) {
      return intent;
    }
    return {
      ...intent,
      currentIndex: intent.currentIndex + 1,
    };
  }

  questionnaireReadyToSubmit(intent: MessagingQuestionnaireIntent): boolean {
    return (
      intent.currentIndex >= intent.questions.length - 1 &&
      intent.answers.every(messagingQuestionnaireAnswerComplete)
    );
  }

  async submitAndRetireQuestionnaire(
    pendingIntent: MessagingPendingIntentRecord,
    intent: MessagingQuestionnaireIntent,
    event: MessagingInboundCallbackEvent | MessagingInboundTextEvent,
  ): Promise<void> {
    if (intent.asyncReply) {
      await this.submitAsyncQuestionnaire(pendingIntent, intent, event);
      return;
    }
    const submittedIntent: MessagingQuestionnaireIntent = {
      ...intent,
      phase: "submitted",
    };
    await this.submitQuestionnaireIntent(submittedIntent);
    await this.deliverQuestionnaireIntent(pendingIntent, submittedIntent, event);
    await this.context.store.deletePendingIntent(pendingIntent.id);
    await this.resumeBindingForPendingIntent(
      pendingIntent,
      "pending_request.submitted",
    );
  }

  questionnaireWithPreviousQuestion(
    intent: MessagingQuestionnaireIntent,
  ): MessagingQuestionnaireIntent {
    if (intent.phase === "review") {
      return {
        ...intent,
        currentIndex: Math.max(0, intent.questions.length - 1),
        phase: "answering",
      };
    }
    if (intent.phase !== "answering" || intent.currentIndex <= 0) {
      return intent;
    }
    return {
      ...intent,
      currentIndex: intent.currentIndex - 1,
    };
  }

  async updateQuestionnairePendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
    intent: MessagingQuestionnaireIntent,
    event: MessagingInboundCallbackEvent | MessagingInboundTextEvent,
  ): Promise<void> {
    const result = await this.deliverQuestionnaireIntent(pendingIntent, intent, event);
    await this.context.store.upsertPendingIntent({
      ...pendingIntent,
      intent,
      surface: result.surface ?? pendingIntent.surface,
    });
  }

  async deliverQuestionnaireIntent(
    pendingIntent: MessagingPendingIntentRecord,
    intent: MessagingQuestionnaireIntent,
    event?: MessagingInboundCallbackEvent | MessagingInboundTextEvent,
  ): Promise<MessagingDeliveryResult> {
    const binding = pendingIntent.bindingId
      ? await this.context.store.getBinding(pendingIntent.bindingId)
      : undefined;
    const targetSurface = pendingIntent.surface ?? (
      event?.kind === "callback" ? event.interaction : undefined
    );
    const deliveryIntent: MessagingQuestionnaireIntent = targetSurface
      ? {
          ...intent,
          delivery: {
            mode: "update",
            replaceMarkup: true,
            fallback: "present_new",
          },
          targetSurface,
        }
      : intent;
    return await this.context.host().deliver(deliveryIntent, binding, event);
  }

  /**
   * Presents the questions a Codex async question message asked. Nothing is
   * waiting on the answer, so the turn keeps its working state.
   */
  async deliverAsyncQuestionnaire(
    asyncQuestions: { itemId: string; questions: CodexAsyncQuestion[] },
    event: AgentEvent,
    binding: MessagingBindingRecord,
    turnId: string | undefined,
  ): Promise<void> {
    const threadId = threadIdForBackendEvent(event) ?? binding.threadId;
    const intent = buildAsyncQuestionnaireIntent({
      asyncReply: {
        backend: event.backend,
        itemId: asyncQuestions.itemId,
        threadId,
      },
      capabilityProfile: this.context.capabilityProfile,
      createdAt: this.context.now(),
      id: this.context.host().newIntentId("async-question"),
      questions: asyncQuestions.questions,
    });
    intent.bindingId = binding.id;
    intent.audit = buildMessagingAuditContext({
      action: "async_question.presented",
      actor: {
        platformUserId: binding.authorizedActorIds[0] ?? "unknown",
      },
      backend: event.backend,
      bindingId: binding.id,
      channel: binding.channel,
      now: this.context.now(),
      threadId,
    });
    const pendingIntent = await this.context.host().storePendingIntent(intent, binding);
    await this.context.host().flushPendingTurnProseBeforeElicitation(binding, turnId);
    const delivery = await this.context.host().deliver(intent, binding);
    if (delivery.outcome === "failed") {
      // No turn end retires an async card, so one nobody can see would take
      // the operator's next message as its answer.
      await this.context.store.deletePendingIntent(pendingIntent.id);
      return;
    }
    if (delivery.surface) {
      await this.context.store.upsertPendingIntent({
        ...pendingIntent,
        surface: delivery.surface,
      });
    }
  }

  /**
   * A Codex async question has no pending request to answer. The answers go
   * back as one message in Codex's reply envelope: steered into the turn when
   * one is running, as Codex expects, and otherwise as a new turn.
   */
  async submitAsyncQuestionnaire(
    pendingIntent: MessagingPendingIntentRecord,
    intent: MessagingQuestionnaireIntent,
    event: MessagingInboundCallbackEvent | MessagingInboundTextEvent,
  ): Promise<void> {
    const asyncReply = intent.asyncReply;
    if (!asyncReply) {
      return;
    }
    const binding = pendingIntent.bindingId
      ? await this.context.store.getBinding(pendingIntent.bindingId)
      : undefined;
    const text = formatCodexAsyncQuestionReply(
      intent.questions.map((question, index) => ({
        questionItemId: codexAsyncQuestionItemId(asyncReply.itemId, index),
        question: question.question,
        answer: intent.answers[index]?.value ?? "",
      })),
    );
    if (!text) {
      return;
    }
    if (!binding || binding.revokedAt) {
      await this.context.store.deletePendingIntent(pendingIntent.id);
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("async-question-unavailable"),
          createdAt: this.context.now(),
          title: "Question unavailable",
          body: "This conversation is no longer bound to the thread that asked.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }
    if (
      !(await this.context.host().requirePermission(
        event,
        "message.reply",
        "questionnaire:async-reply",
      ))
      || !(await this.context.host().requireRemoteScopeForBinding(
        event,
        binding,
        "questionnaire:async-reply:remote-instance",
      ))
    ) {
      return;
    }

    // Retire the card before sending: the reply's own echo would otherwise
    // find it still pending and close it a second time.
    await this.context.store.deletePendingIntent(pendingIntent.id);
    const sent = await this.sendAsyncQuestionReply({
      binding,
      event,
      preview: summarizeCodexAsyncQuestionReply(
        intent.answers.map((answer) => ({ answer: answer?.value ?? "" })),
      ),
      text,
    });
    if (!sent) {
      await this.updateQuestionnairePendingIntent(pendingIntent, intent, event);
      return;
    }
    await this.deliverQuestionnaireIntent(
      pendingIntent,
      { ...intent, phase: "submitted" },
      event,
    );
  }

  async sendAsyncQuestionReply(params: {
    binding: MessagingBindingRecord;
    event: MessagingInboundCallbackEvent | MessagingInboundTextEvent;
    preview: string;
    text: string;
  }): Promise<boolean> {
    const { binding, event } = params;
    const input: AppServerTurnInputItem[] = [{ type: "text", text: params.text }];
    const threadKey = threadKeyForBinding(binding);
    let admissionState: MessagingThreadAdmissionState;
    try {
      admissionState = await this.context.backend.getThreadAdmissionState({
        backend: binding.backend,
        federationTarget: federationTargetForBinding(binding),
        threadId: binding.threadId,
      });
    } catch (error) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("async-question-reply-failed"),
          createdAt: this.context.now(),
          title: "Answer could not be sent",
          body: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
        binding,
        event,
      );
      return false;
    }

    if (await this.context.host().isTurnOccupied(binding, threadKey, admissionState)) {
      const activeTurn = await this.context.host().resolveSteerableActiveTurn(
        binding,
        "async_question_reply",
      );
      if (
        this.context.backend.steerTurn
        && activeTurn
        && ["working", "waiting"].includes(activeTurn.status)
      ) {
        try {
          await this.context.backend.steerTurn({
            backend: binding.backend,
            federationTarget: federationTargetForBinding(binding),
            threadId: binding.threadId,
            expectedTurnId: activeTurn.turnId,
            input,
            requestId: this.context.host().newIntentId("async-question-reply"),
            messageOrigin: messageOriginForInboundEvent(event, this.context.host().rememberHumanMessagingSource(binding, event)?.ref),
          });
          return true;
        } catch (error) {
          this.context.logger.warn?.("messaging async question reply could not steer", {
            bindingId: binding.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const started = await this.context.host().startPreparedInput({
      admissionState,
      binding,
      event,
      input,
      preview: params.preview,
      threadKey,
    });
    return started !== "failed";
  }

  /**
   * An async question answered anywhere closes its card here, so a later
   * chat message is not captured as a second answer.
   */
  async retireAnsweredAsyncQuestionnaires(
    event: AgentEvent,
    threadId: ThreadIdentifier,
    replies: readonly CodexAsyncQuestionReply[],
  ): Promise<void> {
    const answers = new Map(
      replies.map((reply) => [reply.questionItemId, reply.answer]),
    );
    const answeredIds = new Set(answers.keys());
    const pendingIntents =
      await this.context.store.findActivePendingAsyncQuestionnaires({
        backend: event.backend,
        threadId,
        now: this.context.now(),
      });
    for (const pendingIntent of pendingIntents) {
      if (
        pendingIntent.intent.kind !== "questionnaire"
        || !this.context.host().isChannelInScope(pendingIntent.channel)
      ) {
        continue;
      }
      const intent = normalizeMessagingQuestionnaireIntent(pendingIntent.intent);
      const itemId = intent.asyncReply?.itemId;
      if (
        !itemId
        || !intent.questions.some((_, index) =>
          isCodexAsyncQuestionAnswered(answeredIds, itemId, index)
        )
      ) {
        continue;
      }
      const binding = pendingIntent.bindingId
        ? await this.context.store.getBinding(pendingIntent.bindingId)
        : undefined;
      if (binding && !bindingMatchesFederationTarget(binding, event.federationTarget)) {
        continue;
      }
      const answered: MessagingQuestionnaireIntent = {
        ...intent,
        answers: intent.questions.map((question, index) => {
          const value = answers.get(codexAsyncQuestionItemId(itemId, index))
            ?? answers.get(itemId);
          if (!value) {
            return intent.answers[index] ?? null;
          }
          const option = question.options.find((candidate) => candidate.value === value);
          return option
            ? { kind: "option", optionId: option.id, value }
            : { kind: "custom", value };
        }),
        phase: "submitted",
      };
      await this.context.store.deletePendingIntent(pendingIntent.id);
      await this.deliverQuestionnaireIntent(pendingIntent, answered);
    }
  }

  async submitQuestionnaireIntent(
    intent: MessagingQuestionnaireIntent,
  ): Promise<void> {
    const requestContext = intent.requestContext;
    if (!requestContext || !this.context.backend.submitServerRequest) {
      return;
    }
    const binding = intent.bindingId
      ? await this.context.store.getBinding(intent.bindingId)
      : undefined;

    await this.context.backend.submitServerRequest({
      backend: requestContext.backend,
      federationTarget: binding
        ? federationTargetForBinding(binding)
        : undefined,
      threadId: requestContext.threadId,
      turnId: requestContext.turnId,
      requestId: requestContext.requestId,
      response: {
        answers: Object.fromEntries(
          intent.questions.map((question, index) => [
            question.id,
            {
              answers: questionnaireAnswerValue(intent.answers[index]),
            },
          ]),
        ),
      },
    });
  }

  async submitApprovalAction(
    intent: Extract<MessagingSurfaceIntent, { kind: "approval" }>,
    actionId: string,
  ): Promise<MessagingApprovalDecision | undefined> {
    const requestContext = intent.requestContext;
    const action = intent.decisions.find((candidate) => candidate.id === actionId);
    const decision = action?.decision;
    if (!requestContext || !action || !this.context.backend.submitServerRequest) {
      return decision;
    }
    const binding = intent.bindingId
      ? await this.context.store.getBinding(intent.bindingId)
      : undefined;

    await this.context.backend.submitServerRequest({
      backend: requestContext.backend,
      federationTarget: binding
        ? federationTargetForBinding(binding)
        : undefined,
      threadId: requestContext.threadId,
      turnId: requestContext.turnId,
      requestId: requestContext.requestId,
      response: action.response ?? { decision },
    });
    return decision;
  }

  async handleBackendRequestResolved(event: AgentEvent): Promise<void> {
    if (event.notification.method !== "serverRequest/resolved") {
      return;
    }

    const pendingIntents =
      await this.context.store.findActivePendingIntentsForRequest({
        backend: event.backend,
        threadId: event.notification.params.threadId,
        requestId: event.notification.params.requestId,
        now: this.context.now(),
      });

    for (const pendingIntent of pendingIntents.filter((intent) =>
      this.context.host().isChannelInScope(intent.channel),
    )) {
      const binding = pendingIntent.bindingId
        ? await this.context.store.getBinding(pendingIntent.bindingId)
        : undefined;
      if (
        binding &&
        !bindingMatchesFederationTarget(binding, event.federationTarget)
      ) {
        continue;
      }
      await this.retireApprovalIntent(pendingIntent, undefined, "Resolved");
      await this.context.store.deletePendingIntent(pendingIntent.id);
      await this.resumeBindingForPendingIntent(
        pendingIntent,
        event.notification.method,
      );
    }
  }

  async retireApprovalIntent(
    pendingIntent: MessagingPendingIntentRecord,
    event?: MessagingInboundCallbackEvent,
    responseLabel = "Resolved",
  ): Promise<void> {
    if (pendingIntent.intent.kind !== "approval") {
      return;
    }

    const targetSurface = pendingIntent.surface ?? event?.interaction;
    if (!targetSurface) {
      return;
    }

    try {
      await this.context.host().deliver(
        {
          ...pendingIntent.intent,
          body: approvalBodyWithResponse(pendingIntent.intent.body, responseLabel),
          decisions: [],
          delivery: {
            mode: "update",
            replaceMarkup: true,
            fallback: "fail",
          },
          fallbackText: `Approval response received: ${responseLabel}.`,
          targetSurface,
        },
        undefined,
        event,
      );
    } catch (error) {
      this.context.logger.debug?.("messaging approval retirement update failed", {
        error: error instanceof Error ? error.message : String(error),
        intentId: pendingIntent.intent.id,
      });
    }
  }

  async resumeBindingForPendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
    reason: string,
  ): Promise<MessagingBindingRecord | undefined> {
    const bindingId = pendingIntent.bindingId;
    const turnId = pendingIntent.intent.requestContext?.turnId;
    if (!bindingId || !turnId) {
      return undefined;
    }

    const origin = this.context.host().agentMessagingOriginForPendingIntent(pendingIntent);
    const binding = await this.context.store.getBinding(bindingId)
      ?? origin?.deliveryBinding
      ?? origin?.binding;
    const activeTurn = binding ? this.context.host().getActiveTurn(binding) : undefined;
    if (
      !binding ||
      binding.revokedAt ||
      !activeTurn ||
      activeTurn.turnId !== turnId ||
      activeTurn.status !== "waiting"
    ) {
      return undefined;
    }

    const resumedTurn: MessagingActiveTurnSummary = {
      ...activeTurn,
      status: "working",
      updatedAt: this.context.now(),
    };
    this.context.host().setActiveTurn(binding, resumedTurn);
    this.context.host().logBindingTurnStateChange(binding, activeTurn, resumedTurn, reason);
    await this.context.host().signalTurnActivity(binding, resumedTurn, {
      force: true,
      reason,
    });
    return binding;
  }

  async retireStalePendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
  ): Promise<void> {
    await this.context.store.deletePendingIntent(pendingIntent.id);
    await this.retireApprovalIntent(pendingIntent, undefined, "Resolved");
  }

  intentForPendingRequest(
    request: AppServerPendingRequestNotification,
  ): MessagingSurfaceIntent | undefined {
    if (request.method === "item/tool/requestUserInput") {
      return buildQuestionnaireIntent({
        id: this.context.host().newIntentId("questionnaire"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        request: request as AppServerToolRequestUserInputNotification,
      });
    }

    if (isMessagingInteractivePendingRequest(request)) {
      return buildApprovalIntent({
        id: this.context.host().newIntentId("approval"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        request,
      });
    }

    return undefined;
  }
}
