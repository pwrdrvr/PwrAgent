import { buildQueuedInputPreview, directoryForProjectSelection, newThreadOptionsForSession, normalizeNewThreadSessionForBackend, findThreadForBinding, type PreparedInputStartResult, type PendingNewThreadPromptWindow, type PendingNewThreadPromptBundle } from "./messaging-callback-helpers";
import { messageOriginForInboundEvent } from "./messaging-command-helpers";
import { federationTargetForBinding, isTerminalTurnLifecycle, type ActiveAgentMessagingOrigin } from "./messaging-backend-event-helpers";
import { readMessagingLaunchpadContext, type MessagingNewThreadNavigation } from "./messaging-launchpad-context";
import { rememberBoundedMap } from "../../bounded-map";
import { buildFederatedThreadRef, buildThreadIdentityKey, isAcpBackendId, parseCodexTurnErrorMessage } from "@pwragent/shared";
import type { AppServerTurnInputItem, CodexEnvironmentSetupProgressEvent, BackendSummary, MaterializedDirectoryLaunchpadThread } from "@pwragent/shared";
import type { MessagingBindingRecord, MessagingBrowseSessionRecord, MessagingActiveTurnSummary, MessagingChannelRef, MessagingDefaultAgentAssignmentRecord, MessagingInboundEvent, MessagingInboundMediaEvent, MessagingInboundTextEvent, MessagingResponseMode } from "@pwragent/messaging-interface";
import { buildMessagingConversationKey } from "./messaging-store.js";
import { defaultAgentBackendSupport } from "./messaging-default-agent.js";
import type { MessagingBackendBridge, MessagingThreadAdmissionState } from "./messaging-adapter.js";
import { buildConfirmationIntent, buildErrorIntent } from "./messaging-renderer.js";
import { isNewAgentThreadLaunchAction, isNewThreadLaunchAction } from "./messaging-resume-browser.js";
import { resolveMessagingResponseMode } from "./messaging-status-card.js";
import { formatSkillInputPrefix, isSkillSelectionNoticeIntent, isSkillsSearchIntent } from "./messaging-skills-browser.js";
import { type MessagingNavigationContext, type MessagingThreadContext } from "./messaging-thread-state.js";
import { DEFAULT_MESSAGING_ATTACHMENT_POLICY, formatOriginalAttachmentGuidance, processMessagingAttachments, type MessagingAttachmentRejection } from "./messaging-attachment-processor.js";
import { type OriginalAttachmentInput } from "./messaging-original-attachment-store.js";
import { type PendingPdfAttachment } from "../../pdf/pdf-attachment-store.js";
import { type MessagingQueuedTurnEntry, type MessagingTurnAdmissionBundle, type MessagingTurnInputEvent } from "./messaging-turn-admission.js";
import { threadContextForAdmissionState, isDefaultAgentRouteBinding } from "./messaging-binding-helpers";
import { parseTextCommand, parseTextCommandArgs, parseMentionCommand, bindingWithInboundRoutingState, isToolsFallbackText, isStreamFallbackText, type MessagingHandledToRoutedSubspan, type MessagingAdmissionTimingRecord, type MessagingAdmissionStage, type MessagingInputPreparationSpan, ADMISSION_STAGE_MARK_LIMIT, bindingWithoutPendingSkillSelection, DEFAULT_INPUT_DEBOUNCE_MS, PRIVATE_REPLY_COMPLETION_INSTRUCTION, requestsExplicitPrivateResponse, PRIVATE_RESPONSE_FALLBACK_INSTRUCTION, originalAttachmentActorKey, formatAttachmentRejections, agentMessagingThreadKey, resolveExecutionModeForThread, turnSettingsForThread, isPromiseLike, isTurnInProgressStartError, isMissingTurnTargetStartError, buildMessagingStartedThreadContext, agentForNewThreadSession, launchpadForMessagingProject, messagingLaunchpadMaterializationKey, buildMessagingEnvironmentSetupProgressBody, isTerminalCodexEnvironmentSetupProgress, MESSAGING_ENVIRONMENT_SETUP_PROGRESS_INTERVAL_MS, buildMessagingEnvironmentSetupFailureBody, buildMessagingEnvironmentSetupSuccessBody } from "./messaging-inbound-helpers";
import type { MessagingInboundContext, MessagingInboundHost } from "./messaging-inbound-context";

export class MessagingInboundTurns {
  constructor(private readonly context: MessagingInboundContext) {}

  readonly admissionStageMarks = new Map<
    string,
    MessagingAdmissionTimingRecord
  >();

  readonly pendingNewThreadPrompts = new Map<string, PendingNewThreadPromptWindow>();

  readonly pendingFullAccessNewThreadPrompts = new Map<
    string,
    PendingNewThreadPromptBundle
  >();

  async refreshInboundMetadata(event: MessagingInboundEvent): Promise<void> {
    const startedAt = this.context.now();
    let refreshBindingFromInboundMs = 0;
    let observeManagedTopicFromInboundMs = 0;
    try {
      const refreshStartedAt = this.context.now();
      await this.context.host().bindingService.refreshBindingFromInbound(event);
      refreshBindingFromInboundMs = this.context.now() - refreshStartedAt;

      const observeStartedAt = this.context.now();
      await this.context.host().observeManagedTopicFromInbound(event);
      observeManagedTopicFromInboundMs = this.context.now() - observeStartedAt;
    } catch (error) {
      this.context.logger.debug?.("messaging inbound metadata refresh failed", {
        eventId: event.id,
        platform: event.channel.channel,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.context.logger.debug?.("messaging off-path inbound metadata timing", {
        eventId: event.id,
        platform: event.channel.channel,
        refreshBindingFromInboundMs,
        observeManagedTopicFromInboundMs,
        totalMs: this.context.now() - startedAt,
      });
    }
  }

  async handleText(event: MessagingInboundTextEvent): Promise<void> {
    const command = this.measureHandledToRoutedSyncSubspan(
      event,
      "handledTextParsingMs",
      () => parseTextCommand(event.text),
    );
    if (command) {
      await this.context.host().commandHandlers.handleCommand({
        ...event,
        kind: "command",
        command,
        args: parseTextCommandArgs(event.text),
        rawText: event.text,
      });
      return;
    }

    const mentionCommand = this.measureHandledToRoutedSyncSubspan(
      event,
      "handledTextParsingMs",
      () => event.botMention ? parseMentionCommand(event.text) : undefined,
    );
    if (mentionCommand) {
      await this.context.host().commandHandlers.handleCommand({
        ...event,
        kind: "command",
        command: mentionCommand.command,
        args: mentionCommand.args,
        rawText: `/${[mentionCommand.command, ...mentionCommand.args].join(" ")}`,
      });
      return;
    }

    const [pendingNewThread, pendingIntent] = await Promise.all([
      this.measureHandledToRoutedSubspan(
        event,
        "handledPendingNewThreadReadMs",
        async () => await this.findPendingNewThreadSession(event),
      ),
      this.measureHandledToRoutedSubspan(
        event,
        "handledPendingIntentReadMs",
        async () =>
          await this.context.store.findActivePendingIntentForChannel({
            actorId: event.actor.platformUserId,
            channel: event.channel,
            now: this.context.now(),
          }),
      ),
    ]);
    if (pendingIntent) {
      if (isSkillsSearchIntent(pendingIntent.intent)) {
        const mapped = await this.context.host().interactionMapper.mapText({
          intent: pendingIntent.intent,
          text: event.text,
        });
        if (mapped.kind === "matched") {
          await this.context.host().callbackHandlers.handleCallback({
            ...event,
            kind: "callback",
            interaction: {
              channel: event.channel.channel,
              id: mapped.action.id,
            },
            sourceSurface: pendingIntent.surface,
            actionId: mapped.action.id,
            value: mapped.action.value,
          });
          return;
        }

        const binding = pendingIntent.bindingId
          ? await this.context.store.getBinding(pendingIntent.bindingId)
          : undefined;
        await this.context.store.deletePendingIntent(pendingIntent.id);
        if (binding && !binding.revokedAt) {
          await this.context.host().presentSkillsBrowser(binding, event, {
            pageIndex: 0,
            query: event.text,
            targetSurface: pendingIntent.surface,
          });
          return;
        }
      } else {
        const mapped = await this.context.host().interactionMapper.mapText({
          intent: pendingIntent.intent,
          text: event.text,
        });
        if (mapped.kind === "matched") {
          await this.context.host().callbackHandlers.handleCallback({
            ...event,
            kind: "callback",
            interaction: {
              channel: event.channel.channel,
              id: mapped.action.id,
            },
            sourceSurface: pendingIntent.surface,
            actionId: mapped.action.id,
            value: mapped.action.value,
          });
          return;
        }
        if (
          pendingIntent.intent.kind === "review" &&
          await this.context.host().handleReviewTextAnswer(pendingIntent, event)
        ) {
          return;
        }
        if (
          pendingIntent.intent.kind === "questionnaire" &&
          await this.context.host().handleQuestionnaireTextAnswer(pendingIntent, event)
        ) {
          return;
        }
        if (pendingNewThread) {
          await this.appendPendingNewThreadPrompt(pendingNewThread, event);
          return;
        }
        if (isSkillSelectionNoticeIntent(pendingIntent.intent)) {
          await this.context.store.deletePendingIntent(pendingIntent.id);
        } else if (mapped.kind === "ambiguous") {
          await this.context.host().deliver(
            buildConfirmationIntent({
              id: this.context.host().newIntentId("ambiguous-reply"),
              capabilityProfile: this.context.capabilityProfile,
              createdAt: this.context.now(),
              title: "Choose an option",
              body: pendingIntent.intent.fallbackText ?? "Reply with one of the shown options.",
              fallbackText: pendingIntent.intent.fallbackText,
            }),
            undefined,
            event,
          );
          return;
        }
      }
    }

    if (pendingNewThread) {
      await this.appendPendingNewThreadPrompt(pendingNewThread, event);
      return;
    }

    let binding = await this.measureHandledToRoutedSubspan(
      event,
      "handledBindingLookupMs",
      async () => await this.context.store.findActiveBindingForChannel(event.channel),
    );
    binding = await this.measureHandledToRoutedSubspan(
      event,
      "handledPrivateContinuationExpirationMs",
      async () => await this.revokeExpiredPrivateReplyContinuation(binding),
    );
    binding = bindingWithInboundRoutingState(binding, event.routingState);
    if (!binding) {
      if (!await this.measureHandledToRoutedSubspan(
        event,
        "handledSharedMessagePolicyMs",
        async () => await this.shouldHandleAmbientSharedMessage(event),
      )) {
        return;
      }
      if (await this.bootstrapDefaultAgentForAcceptedMessage(event)) {
        return;
      }
      await this.context.host().commandHandlers.presentHelp(event);
      return;
    }

    if (!await this.measureHandledToRoutedSubspan(
      event,
      "handledSharedMessagePolicyMs",
      async () => await this.shouldHandleAmbientSharedMessage(event, binding),
    )) {
      return;
    }

    if (isToolsFallbackText(event.text)) {
      await this.context.host().cycleToolUpdateMode(binding, event);
      return;
    }
    if (isStreamFallbackText(event.text)) {
      await this.context.host().cycleStreamingResponseMode(binding, event);
      return;
    }

    // RBAC floor: sending a turn to the agent needs `message.reply`. Silent
    // drop (no reply) so an under-permissioned sender can't be spammed with
    // rejections in a shared channel.
    if (!(await this.measureHandledToRoutedSubspan(
      event,
      "handledRequirePermissionMs",
      async () =>
        await this.context.host().requirePermission(
          event,
          "message.reply",
          "message:reply",
          { notify: false },
        ),
    ))) {
      return;
    }
    // A turn into a remote-bound thread runs on the peer's machine.
    if (
      !(await this.measureHandledToRoutedSubspan(
        event,
        "handledRemoteScopeMs",
        async () =>
          await this.context.host().requireRemoteScopeForBinding(
            event,
            binding,
            "message:reply:remote-instance",
            { notify: false },
          ),
      ))
    ) {
      return;
    }

    await this.admitTurnInput({ binding, event });
  }

  async bootstrapDefaultAgentForAcceptedMessage(
    event: MessagingInboundTextEvent | MessagingInboundMediaEvent,
  ): Promise<boolean> {
    const assignments =
      await this.measureHandledToRoutedSubspan(
        event,
        "handledDefaultAgentAssignmentsMs",
        async () =>
          await this.context.store.findActiveDefaultAgentAssignmentsForChannel(
            event.channel,
          ),
      );
    if (assignments.length === 0) {
      return false;
    }
    if (
      !(await this.measureHandledToRoutedSubspan(
        event,
        "handledRequirePermissionMs",
        async () =>
          await this.context.host().requirePermission(
            event,
            "message.reply",
            event.kind === "media" ? "media:reply" : "message:reply",
            { notify: false },
          ),
      ))
    ) {
      return true;
    }

    let selected:
      | {
          assignment: MessagingDefaultAgentAssignmentRecord;
        }
      | undefined;
    let backendSummaries: BackendSummary[] | undefined;
    let backendSummariesLoaded = false;
    // Revocations are buffered, not applied as they are decided. Every
    // iteration reads backend state that can fail, and a failure part-way
    // through used to leave the channel half-revoked: the assignments already
    // rejected were gone, the ones not yet examined survived, and the operator
    // saw only "Default Agent unavailable". Deciding first and writing after
    // makes the pass all-or-nothing.
    const revocations: MessagingDefaultAgentAssignmentRecord[] = [];
    for (const assignment of assignments) {
      let targetIsAgentThread: boolean;
      try {
        targetIsAgentThread =
          await this.measureHandledToRoutedSubspan(
            event,
            "handledDefaultAgentTargetValidationMs",
            async () =>
              await this.defaultAgentTargetIsAgentThread(assignment.target),
          );
      } catch (error) {
        await this.deliverDefaultAgentBootstrapError(
          event,
          "Default Agent unavailable",
          error instanceof Error ? error.message : String(error),
        );
        return true;
      }
      if (
        isAcpBackendId(assignment.target.backend)
        && !backendSummariesLoaded
      ) {
        backendSummaries = await this.measureHandledToRoutedSubspan(
          event,
          "handledDefaultAgentBackendValidationMs",
          async () => await this.loadDefaultAgentBackendSummaries(),
        );
        backendSummariesLoaded = true;
      }
      const backendSupport = defaultAgentBackendSupport(
        assignment.target.backend,
        backendSummaries,
      );
      if (
        assignment.target.kind === "agent"
        && targetIsAgentThread
        && backendSupport === "supported"
      ) {
        selected = { assignment };
        break;
      }
      if (targetIsAgentThread && backendSupport === "unknown") {
        await this.deliverDefaultAgentBootstrapError(
          event,
          "Default Agent unavailable",
          "PwrAgent could not confirm that this Agent backend currently exposes the required tools. The default assignment was preserved.",
        );
        return true;
      }
      revocations.push(assignment);
    }
    await this.measureHandledToRoutedSubspan(
      event,
      "handledDefaultAgentRevocationsMs",
      async () => {
        for (const assignment of revocations) {
          await this.context.store.revokeDefaultAgentAssignment({
            assignmentId: assignment.id,
            revokedAt: this.context.now(),
          });
          this.context.host().bindingService.notifyBindingChanged("default-agent-cleared");
        }
      },
    );
    if (!selected) {
      return false;
    }

    const binding = this.context.host().defaultAgentRouteBinding(event, {
      backend: selected.assignment.target.backend,
      threadId: selected.assignment.target.threadId,
      toolUpdateMode: selected.assignment.toolUpdateMode,
    });
    await this.admitTurnInput({
      binding,
      event,
    });
    return true;
  }

  /**
   * Does this assignment still point at an agent thread?
   *
   * Answered from what this process already knows about the one thread whose
   * id the assignment carries. Deciding to start or queue a turn needs the
   * target's identity, settings and occupancy; it does not need Git state,
   * pull-request status, launchpads or the rest of the fleet.
   *
   * This used to call `getNavigationSnapshot({ backend: "all" })` on every
   * accepted message, which enumerates every thread on every backend and then
   * hydrates overlays, canonicalizes pull requests, probes Git working state,
   * refreshes directory status and hydrates launchpads — all to answer one
   * yes-or-no question about one thread. Opening the same thread in the app
   * does none of that.
   *
   * ## What the listing proved, and what replaces it
   *
   * The listing proved two things at once: the thread still has an agent, and
   * the provider still serves it. Only the first survives here, and the
   * difference is deliberate rather than overlooked.
   *
   * `agent` is desktop-owned state that lives in the thread's overlay row, and
   * a navigation row reads it from that same row — so the targeted answer and
   * the listing's answer are the same answer.
   *
   * Existence is the one this cannot prove. `admission.thread` is built from
   * the overlay when no listing row is remembered, and nothing deletes an
   * overlay, so an agent thread deleted at the provider still presents a row
   * here. Proving otherwise costs a provider round trip on every accepted
   * message, and the two ways a target legitimately goes away are already
   * covered more cheaply: archival revokes these assignments from the
   * `thread/archived` handler, and a thread this machine has no record of at
   * all fails the check below. What remains — an out-of-band deletion whose
   * overlay outlives it — surfaces as a failed `startTurn` with a recoverable
   * error rather than as a fleet walk charged to every message.
   */
  async defaultAgentTargetIsAgentThread(
    target: MessagingDefaultAgentAssignmentRecord["target"],
  ): Promise<boolean> {
    const admission = await this.context.backend.getThreadAdmissionState({
      backend: target.backend,
      threadId: target.threadId,
    });
    return Boolean(admission.thread?.agent);
  }

  async deliverDefaultAgentBootstrapError(
    event: MessagingInboundEvent,
    title: string,
    body: string,
  ): Promise<void> {
    await this.context.host().deliver(
      buildErrorIntent({
        id: this.context.host().newIntentId("default-agent-bootstrap"),
        createdAt: this.context.now(),
        title,
        body,
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  async handleMedia(event: MessagingInboundMediaEvent): Promise<void> {
    const command = this.measureHandledToRoutedSyncSubspan(
      event,
      "handledTextParsingMs",
      () => event.text ? parseTextCommand(event.text) : undefined,
    );
    if (command) {
      await this.context.host().commandHandlers.handleCommand({
        ...event,
        kind: "command",
        command,
        args: parseTextCommandArgs(event.text ?? ""),
        rawText: event.text ?? "",
      });
      return;
    }
    const mentionCommand = this.measureHandledToRoutedSyncSubspan(
      event,
      "handledTextParsingMs",
      () => event.botMention && event.text
        ? parseMentionCommand(event.text)
        : undefined,
    );
    if (mentionCommand) {
      await this.context.host().commandHandlers.handleCommand({
        ...event,
        kind: "command",
        command: mentionCommand.command,
        args: mentionCommand.args,
        rawText: `/${[mentionCommand.command, ...mentionCommand.args].join(" ")}`,
      });
      return;
    }

    const pendingNewThread = await this.measureHandledToRoutedSubspan(
      event,
      "handledPendingNewThreadReadMs",
      async () => await this.findPendingNewThreadSession(event),
    );
    if (pendingNewThread) {
      await this.appendPendingNewThreadPrompt(pendingNewThread, event);
      return;
    }

    let binding = await this.measureHandledToRoutedSubspan(
      event,
      "handledBindingLookupMs",
      async () => await this.context.store.findActiveBindingForChannel(event.channel),
    );
    binding = await this.measureHandledToRoutedSubspan(
      event,
      "handledPrivateContinuationExpirationMs",
      async () => await this.revokeExpiredPrivateReplyContinuation(binding),
    );
    binding = bindingWithInboundRoutingState(binding, event.routingState);
    if (!binding) {
      if (!await this.measureHandledToRoutedSubspan(
        event,
        "handledSharedMessagePolicyMs",
        async () => await this.shouldHandleAmbientSharedMessage(event),
      )) {
        return;
      }
      if (await this.bootstrapDefaultAgentForAcceptedMessage(event)) {
        return;
      }
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("needs-binding-media"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: this.context.now(),
          title: "Choose a thread",
          body: "Bind this conversation to a PwrAgent thread before sending attachments.",
          fallbackText: "Reply /resume to choose a thread.",
          actions: [
            {
              id: "command:resume",
              label: "Resume",
              style: "primary",
              fallbackText: "/resume",
            },
          ],
        }),
        undefined,
        event,
      );
      return;
    }

    if (!await this.measureHandledToRoutedSubspan(
      event,
      "handledSharedMessagePolicyMs",
      async () => await this.shouldHandleAmbientSharedMessage(event, binding),
    )) {
      return;
    }

    if (!(await this.measureHandledToRoutedSubspan(
      event,
      "handledRequirePermissionMs",
      async () =>
        await this.context.host().requirePermission(
          event,
          "message.reply",
          "media:reply",
          { notify: false },
        ),
    ))) {
      return;
    }
    if (
      !(await this.measureHandledToRoutedSubspan(
        event,
        "handledRemoteScopeMs",
        async () =>
          await this.context.host().requireRemoteScopeForBinding(
            event,
            binding,
            "media:reply:remote-instance",
            { notify: false },
          ),
      ))
    ) {
      return;
    }

    await this.admitTurnInput({ binding, event });
  }

  async shouldHandleAmbientSharedMessage(
    event: MessagingInboundTextEvent | MessagingInboundMediaEvent,
    binding?: MessagingBindingRecord,
  ): Promise<boolean> {
    if (
      event.channel.conversation.kind === "dm"
      || event.channel.conversation.isDirectMessage === true
    ) {
      return true;
    }
    if (
      this.context.capabilityProfile.conversationInput?.reportsBotMention !== true
    ) {
      return true;
    }
    const responseMode = resolveMessagingResponseMode(
      binding,
      await this.measureHandledToRoutedSubspan(
        event,
        "handledResponseModeMs",
        async () => await this.responseModeForConversation(event.channel),
      ),
    );
    return responseMode === "every_message" || event.botMention === true;
  }

  async responseModeForConversation(
    channel: MessagingChannelRef,
  ): Promise<MessagingResponseMode> {
    return await this.context.config.responseModeForConversation?.(channel) ?? "every_message";
  }

  /**
   * Retire a Default Agent assignment whose target could not start a turn.
   *
   * Scoped to bindings this controller routed through a Default Agent: an
   * ordinary bound thread failing to start is a transient the operator can
   * retry, not evidence that the binding is wrong. A revoked assignment leaves
   * the channel unbound, so the next message falls through to normal handling
   * and the operator is told the default was cleared.
   */
  async revokeDefaultAgentRouteForFailedStart(
    binding: MessagingBindingRecord,
  ): Promise<void> {
    if (!isDefaultAgentRouteBinding(binding)) {
      return;
    }
    const revoked = await this.context.store
      .revokeDefaultAgentAssignmentsForTarget({
        backend: binding.backend,
        threadId: binding.threadId,
        revokedAt: this.context.now(),
      })
      .catch((error: unknown) => {
        this.context.logger.debug?.("messaging default agent revoke after failed start failed", {
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
        return [];
      });
    // An empty array is still truthy, and a start can fail on a channel whose
    // assignment was already retired -- announce a change only when one moved.
    if (revoked.length > 0) {
      this.context.host().bindingService.notifyBindingChanged("default-agent-cleared");
    }
  }

  /**
   * The one door into the admission queue, so every route marks the same stage.
   */
  async admitTurnInput(params: {
    binding: MessagingBindingRecord;
    event: MessagingTurnInputEvent;
  }): Promise<boolean> {
    const requestId = params.binding.privateReplyContinuation?.requestId;
    // Claim synchronously before append can yield or buffer the response. Cancel
    // uses the same claim, including for replies typed in the private thread.
    const replyClaim = requestId ? this.context.host().privateReplyClaims.claim(requestId) : undefined;
    if (requestId && !replyClaim) return false;
    this.context.host().rememberHumanMessagingSource(params.binding, params.event);
    this.markAdmissionStage(params.event, "routed");
    const startedAt = this.context.now();
    try {
      await this.context.host().turnAdmission.append(params);
      if (replyClaim) this.context.host().privateReplyClaims.complete(replyClaim);
      return true;
    } catch (error) {
      if (replyClaim) this.context.host().privateReplyClaims.release(replyClaim);
      throw error;
    } finally {
      const finalAdmissionAppendAwaitMs = this.context.now() - startedAt;
      this.recordHandledToRoutedSubspan(
        params.event,
        "finalAdmissionAppendAwaitMs",
        finalAdmissionAppendAwaitMs,
        false,
      );
      this.context.logger.debug?.("messaging admission append timing", {
        eventId: params.event.id,
        platform: params.event.channel.channel,
        finalAdmissionAppendAwaitMs,
      });
    }
  }

  async measureHandledToRoutedSubspan<T>(
    event: MessagingInboundEvent,
    subspan: MessagingHandledToRoutedSubspan,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = this.context.now();
    try {
      return await operation();
    } finally {
      this.recordHandledToRoutedSubspan(
        event,
        subspan,
        this.context.now() - startedAt,
      );
    }
  }

  measureHandledToRoutedSyncSubspan<T>(
    event: MessagingInboundEvent,
    subspan: MessagingHandledToRoutedSubspan,
    operation: () => T,
  ): T {
    const startedAt = this.context.now();
    try {
      return operation();
    } finally {
      this.recordHandledToRoutedSubspan(
        event,
        subspan,
        this.context.now() - startedAt,
      );
    }
  }

  recordHandledToRoutedSubspan(
    event: MessagingInboundEvent,
    subspan: MessagingHandledToRoutedSubspan,
    durationMs: number,
    create = true,
  ): void {
    const timing = create
      ? this.admissionTimingForEvent(event)
      : this.admissionStageMarks.get(event.id);
    if (!timing) return;
    timing.subspans[subspan] =
      (timing.subspans[subspan] ?? 0) + durationMs;
  }

  admissionTimingForEvent(
    event: MessagingInboundEvent,
  ): MessagingAdmissionTimingRecord {
    let timing = this.admissionStageMarks.get(event.id);
    if (!timing) {
      timing = { marks: {}, subspans: {} };
      rememberBoundedMap(
        this.admissionStageMarks,
        event.id,
        timing,
        ADMISSION_STAGE_MARK_LIMIT,
      );
    }
    return timing;
  }

  /**
   * Record when this message reached {@link stage}, if it has not already.
   *
   * First mark wins: a stage reached twice (an admission state resolved once
   * per bundle and again per queued release) keeps the earlier time, so a span
   * never reads as negative.
   */
  markAdmissionStage(
    event: MessagingInboundEvent | undefined,
    stage: MessagingAdmissionStage,
  ): void {
    if (!event) return;
    const timing = this.admissionTimingForEvent(event);
    timing.marks[stage] ??= this.context.now();
  }

  /**
   * Add one bounded subspan to the existing start-turn admission log.
   *
   * A bundle can contain several text or media events, so repeated spans add
   * together. The record is keyed by the provider event id and never includes
   * message content, attachment names, or actor identifiers.
   */
  addInputPreparationTiming(
    event: MessagingInboundEvent | undefined,
    span: MessagingInputPreparationSpan,
    startedAt: number,
  ): void {
    if (!event) return;
    const timing = this.admissionTimingForEvent(event);
    timing.subspans[span] =
      (timing.subspans[span] ?? 0) + (this.context.now() - startedAt);
  }

  /**
   * Consume this message's marks as span durations for the start-turn log.
   *
   * A span is emitted only when both of its ends were reached, so a path that
   * skips a stage (a queued release, which never prepares input) reports the
   * stages it did run instead of a misleading zero.
   *
   * `routedToBundleReadyMs` covers the input debounce, and for a coalesced
   * burst it also covers the operator's own typing: the bundle carries its
   * first event, but flushes {@link DEFAULT_INPUT_DEBOUNCE_MS} after the last.
   * A large value there is the operator still typing, not PwrAgent stalling.
   */
  takeAdmissionStageTiming(
    event: MessagingInboundEvent | undefined,
    startTurnIssuedAt: number,
  ): Record<string, number> {
    if (!event) return {};
    const admissionTiming = this.admissionStageMarks.get(event.id);
    if (!admissionTiming) return {};
    this.admissionStageMarks.delete(event.id);
    const marks = admissionTiming.marks;
    const spans: Array<[string, number | undefined, number | undefined]> = [
      ["receivedToHandledMs", event.receivedAt, marks.handled],
      ["handledToRoutedMs", marks.handled, marks.routed],
      ["routedToBundleReadyMs", marks.routed, marks.bundleReady],
      ["bundleReadyToInputPreparedMs", marks.bundleReady, marks.inputPrepared],
      [
        "inputPreparedToAdmissionStateMs",
        marks.inputPrepared,
        marks.admissionStateResolved,
      ],
      [
        "admissionStateToOccupancyMs",
        marks.admissionStateResolved,
        marks.occupancyResolved,
      ],
      // A turn that waited behind a busy thread reports its wait here instead.
      // Without these two the wait belonged to no span at all, so the stages
      // stopped summing to the end-to-end number with nothing saying why -- the
      // one reading that would send someone hunting for time that was never
      // lost.
      ["admissionStateToQueuedMs", marks.admissionStateResolved, marks.queued],
      ["queuedToOriginMs", marks.queued, marks.originBuilt],
      ["occupancyToOriginMs", marks.occupancyResolved, marks.originBuilt],
      ["originToPolicyMs", marks.originBuilt, marks.policyResolved],
      ["policyToStartTurnIssueMs", marks.policyResolved, startTurnIssuedAt],
    ];
    const timing: Record<string, number> = {};
    for (const [name, from, to] of spans) {
      if (from !== undefined && to !== undefined) {
        timing[name] = to - from;
      }
    }
    Object.assign(timing, admissionTiming.subspans);
    return timing;
  }

  async handleAdmittedTurnBundle(
    bundle: MessagingTurnAdmissionBundle,
  ): Promise<void> {
    this.markAdmissionStage(bundle.events[0], "bundleReady");
    // Only the first event of a bundle is carried forward to the start-turn
    // log, so the others' marks can never be consumed. Dropping them here is
    // what keeps the ceiling from evicting a turn that is still in flight --
    // eviction is oldest-first, and the oldest entry is the one still waiting.
    for (const event of bundle.events.slice(1)) {
      this.admissionStageMarks.delete(event.id);
    }
    let currentBinding = bundle.binding;
    if (bundle.binding.pendingSkillSelection) {
      const pendingSkillBindingReloadStartedAt = this.context.now();
      try {
        currentBinding =
          await this.context.store.getBinding(bundle.binding.id)
          ?? bundle.binding;
      } finally {
        this.addInputPreparationTiming(
          bundle.events[0],
          "inputPrepPendingSkillBindingReloadMs",
          pendingSkillBindingReloadStartedAt,
        );
      }
    }
    const prepared = await this.prepareTurnInput(bundle.events, currentBinding, bundle.events[0]);
    if (!prepared) {
      return;
    }
    this.markAdmissionStage(bundle.events[0], "inputPrepared");
    const preparedWithSkill = this.prependPendingSkillSelection(
      prepared,
      currentBinding,
    );
    if (currentBinding.privateReplyContinuation) {
      await this.context.host().completePrivateReplyContinuation(currentBinding.id);
    }
    const consumedSkillBinding = currentBinding.pendingSkillSelection
      ? bindingWithoutPendingSkillSelection(currentBinding)
      : currentBinding;
    let admissionState: MessagingThreadAdmissionState | undefined;
    try {
      // Completion can drain an empty local queue while media is preparing.
      // Read occupancy now so an earlier busy snapshot cannot strand this input.
      admissionState = await this.context.backend.getThreadAdmissionState({
        backend: currentBinding.backend,
        federationTarget: federationTargetForBinding(currentBinding),
        threadId: currentBinding.threadId,
      });
      this.markAdmissionStage(bundle.events[0], "admissionStateResolved");
    } catch (error) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("turn-start-failed"),
          createdAt: this.context.now(),
          title: "Turn could not start",
          body: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
        consumedSkillBinding,
        bundle.events[0],
      );
      return;
    }

    if (
      !isDefaultAgentRouteBinding(currentBinding)
      && !this.context.backend.ownsTurnQueue
      && await this.isTurnOccupied(
        currentBinding,
        bundle.threadKey,
        admissionState,
      )
    ) {
      this.markAdmissionStage(bundle.events[0], "queued");
      await this.queuePreparedInput({
        binding: consumedSkillBinding,
        event: bundle.events[0],
        input: preparedWithSkill.input,
        pdfAttachments: preparedWithSkill.pdfAttachments,
        privateResponseRequested: preparedWithSkill.privateResponseRequested,
        preview: preparedWithSkill.preview,
        threadKey: bundle.threadKey,
      });
      if (currentBinding.pendingSkillSelection) {
        await this.context.host().clearPendingSkillSelection(currentBinding);
      }
      return;
    }

    this.markAdmissionStage(bundle.events[0], "occupancyResolved");
    const startResult = await this.startPreparedInput({
      binding: consumedSkillBinding,
      input: preparedWithSkill.input,
      pdfAttachments: preparedWithSkill.pdfAttachments,
      privateResponseRequested: preparedWithSkill.privateResponseRequested,
      preview: preparedWithSkill.preview,
      threadKey: bundle.threadKey,
      event: bundle.events[0],
      admissionState,
    });
    if (startResult !== "failed" && currentBinding.pendingSkillSelection) {
      const updatedBinding = await this.context.host().clearPendingSkillSelection(currentBinding);
      await this.context.host().bindingService.renderAutomaticBindingStatus(updatedBinding, bundle.events[0]);
    }
  }

  prependPendingSkillSelection(
    prepared: {
      input: AppServerTurnInputItem[];
      pdfAttachments: PendingPdfAttachment[];
      privateResponseRequested: boolean;
      preview: string;
    },
    binding: MessagingBindingRecord,
  ): {
    input: AppServerTurnInputItem[];
    pdfAttachments: PendingPdfAttachment[];
    privateResponseRequested: boolean;
    preview: string;
  } {
    const selection = binding.pendingSkillSelection;
    if (!selection) return prepared;
    const prefix = formatSkillInputPrefix(selection);
    return {
      input: [
        {
          type: "text",
          text: prefix,
        },
        ...prepared.input,
      ],
      pdfAttachments: prepared.pdfAttachments,
      privateResponseRequested: prepared.privateResponseRequested,
      preview: `${prefix}\n${prepared.preview}`,
    };
  }

  async findPendingNewThreadSession(
    event: MessagingInboundTextEvent | MessagingInboundMediaEvent,
  ): Promise<MessagingBrowseSessionRecord | undefined> {
    const session = await this.context.store.findActiveBrowseSessionForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.context.now(),
    });
    if (
      session &&
      isNewThreadLaunchAction(session.launchAction) &&
      session.mode === "new_thread_options" &&
      session.selectedProject &&
      (session.textInputExpiresAt ?? session.expiresAt) > this.context.now()
    ) {
      return session;
    }
    return undefined;
  }

  async appendPendingNewThreadPrompt(
    session: MessagingBrowseSessionRecord,
    event: MessagingTurnInputEvent,
  ): Promise<void> {
    const key = this.pendingNewThreadPromptKey(session);
    const existing = this.pendingNewThreadPrompts.get(key);
    if (existing) {
      existing.events.push(event);
      existing.session = session;
      if ((this.context.config.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS) <= 0) {
        await this.flushPendingNewThreadPrompt(key);
        return;
      }
      if (existing.timer) {
        clearTimeout(existing.timer);
      }
      existing.timer = this.schedulePendingNewThreadPrompt(key);
      return;
    }

    this.pendingNewThreadPrompts.set(key, {
      events: [event],
      session,
      timer:
        (this.context.config.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS) > 0
          ? this.schedulePendingNewThreadPrompt(key)
          : undefined,
    });
    if ((this.context.config.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS) <= 0) {
      await this.flushPendingNewThreadPrompt(key);
    }
  }

  schedulePendingNewThreadPrompt(
    key: string,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      void this.flushPendingNewThreadPrompt(key);
    }, this.context.config.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS);
  }

  async flushPendingNewThreadPrompt(key: string): Promise<void> {
    const pending = this.pendingNewThreadPrompts.get(key);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingNewThreadPrompts.delete(key);
    try {
      await this.createNewThreadFromPromptBundle({
        events: pending.events,
        session: pending.session,
      });
    } catch (error) {
      this.context.logger.warn?.("messaging new-thread prompt failed", {
        channel: pending.session.channel.channel,
        error: error instanceof Error ? error.message : String(error),
        sessionId: pending.session.id,
      });
      await this.deliverNewThreadPromptFailure(pending, error);
    }
  }

  async deliverNewThreadPromptFailure(
    pending: PendingNewThreadPromptWindow,
    error: unknown,
  ): Promise<void> {
    const event = pending.events[0];
    if (!event) {
      return;
    }
    try {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("new-thread-start-failed"),
          createdAt: this.context.now(),
          title: "Thread could not start",
          body: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
        undefined,
        event,
      );
    } catch (deliveryError) {
      this.context.logger.debug?.("messaging new-thread failure notice failed", {
        channel: pending.session.channel.channel,
        deliveryError: deliveryError instanceof Error
          ? deliveryError.message
          : String(deliveryError),
        sessionId: pending.session.id,
      });
    }
  }

  clearPendingNewThreadPrompt(sessionId: string): void {
    for (const [key, pending] of this.pendingNewThreadPrompts.entries()) {
      if (pending.session.id !== sessionId) {
        continue;
      }
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      this.pendingNewThreadPrompts.delete(key);
    }
  }

  pendingNewThreadPromptKey(session: MessagingBrowseSessionRecord): string {
    return [
      buildMessagingConversationKey(session.channel),
      session.allowedActorIds.join(","),
      session.id,
    ].join(":");
  }

  async prepareTurnInput(
    events: MessagingTurnInputEvent[],
    binding: MessagingBindingRecord | undefined,
    event?: MessagingInboundEvent,
  ): Promise<
    | {
        input: AppServerTurnInputItem[];
        pendingOriginals: { original: OriginalAttachmentInput; event: MessagingTurnInputEvent; attachmentKey: string }[];
        pdfAttachments: PendingPdfAttachment[];
        privateResponseRequested: boolean;
        preview: string;
      }
    | undefined
  > {
    const input: AppServerTurnInputItem[] = [];
    const pendingOriginals: { original: OriginalAttachmentInput; event: MessagingTurnInputEvent; attachmentKey: string }[] = [];
    const pdfAttachments: PendingPdfAttachment[] = [];
    const previewParts: string[] = [];
    const rejections: MessagingAttachmentRejection[] = [];
    let pdfHandling:
      | "model_directed"
      | "render_initial_pages"
      | "pass_through"
      | undefined;
    const privateResponseStartedAt = this.context.now();
    const privateReplyContinuation = binding?.privateReplyContinuation;
    if (
      privateReplyContinuation
      && privateReplyContinuation.expiresAt > this.context.now()
    ) {
      input.push({
        type: "text",
        text: [
          PRIVATE_REPLY_COMPLETION_INSTRUCTION,
          "",
          "Initiating Agent instructions:",
          privateReplyContinuation.instructions,
        ].join("\n"),
      });
    }
    const privateResponseRequested = events.some(
      (turnEvent) => requestsExplicitPrivateResponse(turnEvent),
    );

    if (privateResponseRequested) {
      input.push({
        type: "text",
        text: PRIVATE_RESPONSE_FALLBACK_INSTRUCTION,
      });
    }
    this.addInputPreparationTiming(
      event,
      "inputPrepPrivateResponseMs",
      privateResponseStartedAt,
    );

    for (const turnEvent of events) {
      if (turnEvent.kind === "text") {
        const textConstructionStartedAt = this.context.now();
        const previewText = turnEvent.text.trim();
        if (previewText) {
          input.push({ type: "text", text: turnEvent.text });
          previewParts.push(previewText);
        }
        this.addInputPreparationTiming(
          event,
          "inputPrepTextConstructionMs",
          textConstructionStartedAt,
        );
        continue;
      }

      if (turnEvent.attachments.length > 0 && pdfHandling === undefined) {
        const pdfHandlingStartedAt = this.context.now();
        try {
          pdfHandling = await this.resolveMessagingPdfHandling(binding, event);
        } finally {
          this.addInputPreparationTiming(
            event,
            "inputPrepPdfHandlingResolutionMs",
            pdfHandlingStartedAt,
          );
        }
      }
      const attachmentProcessingStartedAt = this.context.now();
      const processed = await processMessagingAttachments({
        adapter: this.context.adapter,
        attachments: turnEvent.attachments,
        policy: {
          ...DEFAULT_MESSAGING_ATTACHMENT_POLICY,
          ...this.context.config.attachmentPolicy,
        },
        pdfHandling,
        deferSinglePagePdf: binding?.federatedThread?.target.scope === "remote",
        retainOriginal: this.context.config.originalAttachmentStore
          ? async (original, attachment) => {
              if (!binding) {
                // No cache identity exists until the new thread is created.
                // Keep this bounded download in memory, without a provisional
                // manifest or another provider download.
                pendingOriginals.push({ original, event: turnEvent, attachmentKey: attachment.id });
                return { pendingThread: true };
              }
              return this.context.config.originalAttachmentStore!.retain({
                ...original,
                scope: {
                  backend: binding.backend, threadId: binding.threadId, provider: this.context.config.channel,
                  ...(binding.federatedThread?.target.scope === "remote"
                    ? { instanceId: binding.federatedThread.target.instanceId } : {}),
                },
                actorKey: originalAttachmentActorKey(turnEvent),
                eventId: turnEvent.id,
                attachmentKey: attachment.id,
                receivedAt: turnEvent.receivedAt,
              });
            }
          : undefined,
        text: turnEvent.text,
      });
      this.addInputPreparationTiming(
        event,
        "inputPrepAttachmentProcessingMs",
        attachmentProcessingStartedAt,
      );

      input.push(...processed.input);
      pdfAttachments.push(...processed.pdfAttachments);
      rejections.push(...processed.rejections);
      if (turnEvent.text?.trim()) {
        previewParts.push(turnEvent.text.trim());
      }
      for (const attachment of turnEvent.attachments) {
        previewParts.push(`[${attachment.name}]`);
      }
    }

    if (input.length === 0 && pendingOriginals.length === 0) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("unsupported-media"),
          createdAt: this.context.now(),
          title: "Attachment not supported",
          body:
            rejections.length > 0
              ? formatAttachmentRejections(rejections)
              : "This attachment could not be prepared for the model.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return undefined;
    }

    if (rejections.length > 0) {
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("attachment-partial"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: this.context.now(),
          title: "Some attachments were skipped",
          body: formatAttachmentRejections(rejections),
        }),
        binding,
        event,
      );
    }

    const previewConstructionStartedAt = this.context.now();
    const preview = buildQueuedInputPreview(previewParts);
    this.addInputPreparationTiming(
      event,
      "inputPrepTextConstructionMs",
      previewConstructionStartedAt,
    );

    return {
      input,
      pendingOriginals,
      pdfAttachments,
      privateResponseRequested,
      preview,
    };
  }

  async revokeExpiredPrivateReplyContinuation(
    binding: MessagingBindingRecord | undefined,
  ): Promise<MessagingBindingRecord | undefined> {
    if (
      !binding?.privateReplyContinuation
      || binding.privateReplyContinuation.expiresAt > this.context.now()
    ) {
      return binding;
    }
    await this.context.store.revokeBinding({
      bindingId: binding.id,
      revokedAt: this.context.now(),
    });
    this.context.host().bindingService.notifyBindingChanged("private-reply-expired");
    return undefined;
  }

  async cleanupExpiredPrivateReplyContinuations(): Promise<void> {
    const now = this.context.now();
    const expired = this.context.host().filterBindingsForChannel(
      await this.context.store.findActiveBindings(),
    ).filter(
      (binding) =>
        binding.privateReplyContinuation
        && binding.privateReplyContinuation.expiresAt <= now,
    );
    for (const binding of expired) {
      await this.context.store.revokeBinding({
        bindingId: binding.id,
        revokedAt: now,
      });
    }
    if (expired.length > 0) {
      this.context.host().bindingService.notifyBindingChanged("private-reply-expired");
    }
  }

  async resolveMessagingPdfHandling(
    binding: MessagingBindingRecord | undefined,
    event?: MessagingInboundEvent,
  ): Promise<"model_directed" | "render_initial_pages" | "pass_through"> {
    if (!(await this.resolvePdfAnalysisEnabled(event))) {
      return "pass_through";
    }
    if (
      binding?.backend !== "codex" ||
      !this.context.backend.supportsMessagingPdfTools
    ) {
      return "render_initial_pages";
    }
    const pdfToolSupportStartedAt = this.context.now();
    try {
      return await this.context.backend.supportsMessagingPdfTools({
        backend: binding.backend,
        threadId: binding.threadId,
        federationTarget: federationTargetForBinding(binding),
      })
        ? "model_directed"
        : "render_initial_pages";
    } catch (error) {
      this.context.logger.warn?.("could not resolve messaging PDF tool support", {
        bindingId: binding.id,
        error: error instanceof Error ? error.message : String(error),
        threadId: binding.threadId,
      });
      return "render_initial_pages";
    } finally {
      this.addInputPreparationTiming(
        event,
        "inputPrepPdfToolSupportProbeMs",
        pdfToolSupportStartedAt,
      );
    }
  }

  async resolvePdfAnalysisEnabled(
    event?: MessagingInboundEvent,
  ): Promise<boolean> {
    const pdfAnalysisPolicyStartedAt = this.context.now();
    const configured = this.context.config.pdfAnalysisEnabled;
    try {
      if (typeof configured === "function") {
        return (await configured()) !== false;
      }
      return configured !== false;
    } finally {
      this.addInputPreparationTiming(
        event,
        "inputPrepPdfAnalysisPolicyMs",
        pdfAnalysisPolicyStartedAt,
      );
    }
  }

  async startPreparedInput(params: {
    admissionState?: MessagingThreadAdmissionState;
    binding: MessagingBindingRecord;
    event?: MessagingInboundEvent;
    input: AppServerTurnInputItem[];
    navigation?: MessagingNavigationContext;
    pdfAttachments?: PendingPdfAttachment[];
    privateResponseRequested?: boolean;
    preview: string;
    queueOnConcurrentStart?: boolean;
    threadKey: string;
  }): Promise<PreparedInputStartResult> {
    this.context.host().turnAdmission.markStarting(params.threadKey);
    let turnStarted = false;
    let startingOrigin: ActiveAgentMessagingOrigin | undefined;
    let preparingActivity: ReturnType<MessagingInboundHost["beginTurnPreparationActivity"]> | undefined;
    const startingThreadKey = agentMessagingThreadKey(
      params.binding.backend,
      params.binding.threadId,
    );

    try {
      const admissionState = params.admissionState
        ?? await this.context.backend.getThreadAdmissionState({
          backend: params.binding.backend,
          federationTarget: federationTargetForBinding(params.binding),
          threadId: params.binding.threadId,
        });
      this.markAdmissionStage(params.event, "admissionStateResolved");
      const navigation = params.navigation
        ?? threadContextForAdmissionState(params.binding, admissionState);
      startingOrigin = await this.context.host().buildAgentMessagingOrigin({
        binding: params.binding,
        event: params.event,
        navigation,
        privateResponseRequested: params.privateResponseRequested,
      });
      if (startingOrigin) {
        this.context.host().startingAgentMessagingOriginsByThreadKey.set(
          startingThreadKey,
          startingOrigin,
        );
      }
      this.markAdmissionStage(params.event, "originBuilt");
      const targetThreadLookupStartedAt = this.context.now();
      const targetThread = findThreadForBinding(navigation, params.binding);
      const targetThreadLookupCompletedAt = this.context.now();
      const executionModeResolutionStartedAt = this.context.now();
      const executionResolution = resolveExecutionModeForThread(
        params.binding,
        targetThread,
      );
      const executionModeResolutionCompletedAt = this.context.now();
      const turnSettingsResolutionStartedAt = this.context.now();
      const turnSettings = turnSettingsForThread(
        params.binding,
        targetThread,
        executionResolution,
      );
      const turnSettingsResolutionCompletedAt = this.context.now();
      if (
        turnSettings.executionMode === "full-access" &&
        targetThread?.executionMode === "full-access"
      ) {
        const fullAccessControlsLoadStartedAt = this.context.now();
        const controlsResolution = this.context.host().resolveFullAccessControls();
        const fullAccessControlsLoadAwaitCount = isPromiseLike(controlsResolution)
          ? 1
          : 0;
        const controls = isPromiseLike(controlsResolution)
          ? await controlsResolution
          : controlsResolution;
        const fullAccessControlsLoadCompletedAt = this.context.now();
        const resumeSettingCheckStartedAt = this.context.now();
        const allowed = controls.allowThreadResume;
        const resumeSettingCheckCompletedAt = this.context.now();
        const policyResolvedAt = this.context.now();
        const controlsSource = this.context.config.fullAccessControlsSource
          ?? (typeof this.context.config.fullAccessControls === "function"
            ? "dynamic"
            : "static");
        this.markAdmissionStage(params.event, "policyResolved");
        this.context.logger.info?.("messaging Full Access resume policy evaluated", {
          inboundEventId: params.event?.id,
          channel: params.binding.channel.channel,
          allowed,
          controlsSource,
          policyRevision: this.context.config.fullAccessPolicyRevision?.(),
          targetThreadFound: true,
          targetThreadLookupMs:
            targetThreadLookupCompletedAt - targetThreadLookupStartedAt,
          executionModeResolutionMs:
            executionModeResolutionCompletedAt - executionModeResolutionStartedAt,
          turnSettingsResolutionMs:
            turnSettingsResolutionCompletedAt - turnSettingsResolutionStartedAt,
          fullAccessControlsLoadMs:
            fullAccessControlsLoadCompletedAt - fullAccessControlsLoadStartedAt,
          fullAccessControlsLoadAwaitCount,
          settingsConfigReadMs:
            controlsSource === "runtime-snapshot"
              ? 0
              : fullAccessControlsLoadCompletedAt - fullAccessControlsLoadStartedAt,
          settingsConfigReadAwaitCount:
            controlsSource === "runtime-snapshot"
              ? 0
              : fullAccessControlsLoadAwaitCount,
          resumeSettingCheckMs:
            resumeSettingCheckCompletedAt - resumeSettingCheckStartedAt,
          authorizedUserPolicyCheckMs: 0,
          authorizedUserPolicyCheckAwaitCount: 0,
          allowedPathAuditPersistenceMs: 0,
          allowedPathAuditPersistenceAwaitCount: 0,
          fullAccessPolicyTotalMs: policyResolvedAt - targetThreadLookupStartedAt,
        });
        // Provider authorization already completed before turn admission.
        // An allowed Full Access resume performs no audit or persistence.
        if (!allowed) {
          await this.context.host().deliverFullAccessPolicyError(
            params.binding,
            params.event,
            "Full Access threads cannot be resumed from messaging with the current settings.",
          );
          return "failed";
        }
      } else {
        this.markAdmissionStage(params.event, "policyResolved");
      }
      // Permission and routing are settled. Backend startup may still wait on
      // MCP discovery, runtime setup or a cold provider. Request typing now;
      // neither those waits nor the activity API response may gate the other.
      preparingActivity = this.context.host().beginTurnPreparationActivity(
        startingOrigin?.deliveryBinding ?? startingOrigin?.binding ?? params.binding,
      );
      // Diagnostic for #203-class regressions: a turn that the UI shows
      // as Default Access but routes to the Full Access codex client is
      // a silent security bug — the user thinks they're sandboxed but
      // commands like `npm view` succeed because the full-access client
      // skipped the network sandbox. We log the resolved mode + where
      // it came from here at the messaging layer; with Debug log collection
      // enabled, the registry's `codex thread client routing` log shows which
      // client actually received the turn. Cross-reference both lines by
      // threadId to verify the routing matched intent. `executionModeSource` of
      // anything other than `thread` is suspicious for a thread the UI
      // claims has been explicitly toggled.
      const startTurnIssuedAt = this.context.now();
      const inboundTiming = params.event
        ? {
            inboundEventId: params.event.id,
            providerSentAt: params.event.providerSentAt,
            pwragentReceivedAt: params.event.receivedAt,
            providerSentToPwragentReceivedMs:
              params.event.providerSentAt === undefined
                ? undefined
                : params.event.receivedAt - params.event.providerSentAt,
            pwragentReceivedToStartTurnIssueMs:
              startTurnIssuedAt - params.event.receivedAt,
          }
        : {};
      const stageTiming = this.takeAdmissionStageTiming(
        params.event,
        startTurnIssuedAt,
      );
      this.context.logger.info?.("messaging starting turn", {
        backend: params.binding.backend,
        bindingId: params.binding.id,
        channel: params.binding.channel.channel,
        threadId: params.binding.threadId,
        executionMode: turnSettings.executionMode ?? "unset",
        executionModeSource: executionResolution.source,
        model: turnSettings.model,
        fastMode: turnSettings.fastMode,
        startTurnIssuedAt,
        ...inboundTiming,
        ...stageTiming,
      });
      const started = await this.context.backend.startTurn({
        backend: params.binding.backend,
        federationTarget: federationTargetForBinding(params.binding),
        threadId: params.binding.threadId,
        input: params.input,
        messageOrigin: messageOriginForInboundEvent(params.event, startingOrigin?.source?.ref),
        ...turnSettings,
      });
      const startTurnAcceptedAt = this.context.now();
      const acceptanceTiming = params.event
        ? {
            pwragentReceivedToStartTurnAcceptedMs:
              startTurnAcceptedAt - params.event.receivedAt,
            startTurnIssueToAcceptedMs: startTurnAcceptedAt - startTurnIssuedAt,
            startTurnAcceptedAt,
          }
        : {
            startTurnIssueToAcceptedMs: startTurnAcceptedAt - startTurnIssuedAt,
            startTurnAcceptedAt,
          };
      if (started.queueStatus === "queued") {
        await preparingActivity?.finish(false);
        preparingActivity = undefined;
        this.context.host().rememberQueuedAgentMessagingOrigin({
          binding: params.binding,
          event: params.event,
          navigation,
          origin: startingOrigin,
          queueEntryId: started.queueEntryId ?? started.turnId,
        });
        this.context.logger.info?.("messaging turn queued in shared thread FIFO", {
          bindingId: params.binding.id,
          threadId: params.binding.threadId,
          queueEntryId: started.queueEntryId ?? started.turnId,
          requestedExecutionMode: turnSettings.executionMode ?? "unset",
          ...acceptanceTiming,
        });
        if (this.context.backend.ownsTurnQueue) {
          const ownerQueueEntryId = started.queueEntryId ?? started.turnId;
          const entry: MessagingQueuedTurnEntry = {
            ...params, id: ownerQueueEntryId, ownerQueueEntryId, status: "queued",
            createdAt: this.context.now(), updatedAt: this.context.now(),
            pdfSourceRequest: startingOrigin?.source?.ref,
          };
          const key = `${params.threadKey}:${ownerQueueEntryId}`;
          await this.context.host().applySharedQueueNoticeEvent(key, { type: "accepted", entry });
          try {
            await this.context.host().deliverQueuedTurnNotice(entry);
          } catch (error) {
            // A provider notice cannot undo the owner's accepted input.
            this.context.logger.warn?.("messaging shared queue notice failed", {
              queueEntryId: ownerQueueEntryId,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            await this.context.host().applySharedQueueNoticeEvent(key, { type: "noticeReady" });
          }
        }
        return "queued";
      }
      turnStarted = true;
      this.context.logger.info?.("messaging turn started", {
        bindingId: params.binding.id,
        threadId: params.binding.threadId,
        turnId: started.turnId,
        requestedExecutionMode: turnSettings.executionMode ?? "unset",
        ...acceptanceTiming,
      });
      const activeTurn: MessagingActiveTurnSummary = {
        turnId: started.turnId,
        status: "working",
        startedAt: this.context.now(),
        updatedAt: this.context.now(),
      };
      this.context.host().pdfAttachmentStore.bindTurn(
        {
          backend: params.binding.backend,
          threadId: params.binding.threadId,
          turnId: started.turnId,
          sourceInstanceId: params.binding.federatedThread?.target.scope === "remote"
            ? params.binding.federatedThread.target.instanceId : undefined,
          sourceRequest: startingOrigin?.source?.ref,
        },
        params.pdfAttachments ?? [],
      );
      this.context.host().rememberAgentMessagingOrigin({
        binding: params.binding,
        event: params.event,
        navigation,
        origin: startingOrigin,
        turnId: started.turnId,
      });
      const deliveryBinding = startingOrigin?.deliveryBinding
        ?? startingOrigin?.binding
        ?? params.binding;
      this.context.host().acceptStartedTurn(deliveryBinding, activeTurn);
      // Preserve the accepted turn's normal signal (including a retry after a
      // failed preparation request). This wait is after backend acceptance.
      await preparingActivity?.settled;
      const currentTurn = this.context.host().getActiveTurn(deliveryBinding);
      if (currentTurn?.turnId === started.turnId && currentTurn.status === "working") {
        await this.context.host().signalTurnActivity(deliveryBinding, currentTurn, {
          force: true,
        });
      }
      await this.context.host().bindingService.renderAutomaticBindingStatus(
        deliveryBinding,
        undefined,
        navigation,
      );
      return "started";
    } catch (error) {
      await preparingActivity?.finish(turnStarted);
      preparingActivity = undefined;
      if (turnStarted) {
        this.context.logger.debug?.("messaging post-start update failed", {
          error: error instanceof Error ? error.message : String(error),
          threadId: params.binding.threadId,
        });
        return "started";
      }
      if (isTurnInProgressStartError(error)) {
        if (params.queueOnConcurrentStart !== false) {
          await this.queuePreparedInput({
            binding: params.binding,
            event: params.event,
            input: params.input,
            pdfAttachments: params.pdfAttachments,
            privateResponseRequested: params.privateResponseRequested,
            preview: params.preview,
            threadKey: params.threadKey,
          });
          return "queued";
        }
        return "failed";
      }
      // The durable overlay outlives its provider thread, so a targeted
      // missing-thread response is the one reliable signal that a Default
      // Agent assignment is dead. Other start failures are recoverable: a
      // disconnect, rate limit, or invalid runtime option must not destroy the
      // operator's persisted route.
      if (isMissingTurnTargetStartError(error, params.binding)) {
        await this.revokeDefaultAgentRouteForFailedStart(params.binding);
      }
      await this.waitForPendingTurnFailureHandlers(params.binding);
      const errorMessage = parseCodexTurnErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
      if (startingOrigin?.reportedStartFailureText === errorMessage) {
        return "failed";
      }
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("turn-start-failed"),
          createdAt: this.context.now(),
          title: "Turn could not start",
          body: errorMessage,
          recoverable: true,
        }),
        params.binding,
        params.event,
      );
      return "failed";
    } finally {
      await preparingActivity?.finish(turnStarted);
      this.context.host().turnAdmission.clearStarting(params.threadKey);
      if (
        startingOrigin
        && this.context.host().startingAgentMessagingOriginsByThreadKey.get(startingThreadKey)
          === startingOrigin
      ) {
        this.context.host().startingAgentMessagingOriginsByThreadKey.delete(startingThreadKey);
      }
    }
  }

  async isTurnOccupied(
    binding: MessagingBindingRecord,
    threadKey: string,
    admissionState: MessagingThreadAdmissionState,
  ): Promise<boolean> {
    if (this.context.host().turnAdmission.isStarting(threadKey)) {
      return true;
    }

    const rememberedTurn = await this.context.host().reconcileActiveTurnFromThreadStatus(
      binding,
      "turn_admission",
      admissionState.threadStatus,
    );
    if (
      rememberedTurn
      && ["working", "waiting"].includes(rememberedTurn.status)
    ) {
      return true;
    }
    return Boolean(
      admissionState.activeTurn
      || admissionState.threadStatus === "active",
    );
  }

  async waitForPendingTurnFailureHandlers(binding: MessagingBindingRecord): Promise<void> {
    await this.context.host().backendEventRouter.waitForPendingTurnFailureHandlers(binding);
  }

  async adoptStartedTurn(params: {
    binding: MessagingBindingRecord;
    event?: MessagingInboundEvent;
    navigation: MessagingNavigationContext;
    turnId: string;
  }): Promise<void> {
    const currentTurn = this.context.host().getActiveTurn(params.binding);
    if (
      currentTurn?.turnId === params.turnId &&
      isTerminalTurnLifecycle(currentTurn)
    ) {
      await this.context.host().bindingService.renderAutomaticBindingStatus(
        params.binding,
        undefined,
        params.navigation,
      );
      return;
    }
    const activeTurn: MessagingActiveTurnSummary = {
      turnId: params.turnId,
      status: "working",
      startedAt: this.context.now(),
      updatedAt: this.context.now(),
    };
    this.context.host().setActiveTurn(params.binding, activeTurn);
    this.context.host().rememberAgentMessagingOrigin({
      binding: params.binding,
      event: params.event,
      navigation: params.navigation,
      turnId: params.turnId,
    });
    await this.context.host().signalTurnActivity(params.binding, activeTurn, {
      force: true,
    });
    await this.context.host().bindingService.renderAutomaticBindingStatus(
      params.binding,
      undefined,
      params.navigation,
    );
  }

  async queuePreparedInput(params: {
    binding: MessagingBindingRecord;
    event?: MessagingInboundEvent;
    input: AppServerTurnInputItem[];
    pdfAttachments?: PendingPdfAttachment[];
    privateResponseRequested?: boolean;
    preview: string;
    threadKey: string;
  }): Promise<void> {
    const queued = this.context.host().turnAdmission.enqueue(params);
    await this.context.host().deliverQueuedTurnNotice(queued);
  }

  async createNewThreadFromPromptBundle(
    bundle: PendingNewThreadPromptBundle,
  ): Promise<void> {
    const event = bundle.events[0];
    if (!event || !bundle.session.selectedProject) {
      return;
    }

    if (!await this.context.host().requireRemoteScope(event, bundle.session.selectedProject?.federationTarget, "messaging-project-create")) return;
    const prepared = await this.prepareTurnInput(bundle.events, undefined, event);
    if (!prepared) {
      return;
    }

    if (!this.context.backend.materializeDirectoryLaunchpad && !this.context.backend.startThread) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("new-thread-unavailable"),
          createdAt: this.context.now(),
          title: "New thread unavailable",
          body: "This backend does not support starting a thread from messaging yet.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    let navigation: MessagingNewThreadNavigation = await readMessagingLaunchpadContext({
      backend: this.context.backend, project: bundle.session.selectedProject,
    });
    let selectedBackend: BackendSummary | undefined;
    if (bundle.session.backend) {
      const backendChoices = await this.context.host().loadNewThreadBackendChoices(event);
      if (!backendChoices) {
        return;
      }
      selectedBackend = backendChoices.selectable.find(
        (backend) => backend.kind === bundle.session.backend,
      );
      if (!selectedBackend) {
        await this.context.host().deliverSelectedNewThreadBackendUnavailable(event);
        return;
      }
    } else {
      selectedBackend = await this.context.host().resolveNewThreadBackendForSession(
        {
          launchpadBackend: navigation.launchpadDefaults.backend,
          session: bundle.session,
        },
        event,
      );
    }
    if (!selectedBackend) {
      return;
    }
    const session = normalizeNewThreadSessionForBackend(
      {
        ...bundle.session,
        backend: selectedBackend.kind,
      },
      selectedBackend,
      this.context.now(),
      navigation,
    );
    const project = bundle.session.selectedProject;
    const ensured = await this.context.host().ensureNewThreadProjectLaunchpad(
      session,
      navigation,
      selectedBackend.kind,
    );
    navigation = ensured.navigation;
    const directory = ensured.directory ?? directoryForProjectSelection(navigation, project);
    const preferences = {
      ...session.preferences,
      toolUpdateMode: await this.context.host().resolveNewThreadToolUpdateMode(session, directory),
      updatedAt: session.preferences?.updatedAt ?? this.context.now(),
    };
    const options = newThreadOptionsForSession(
      session,
      navigation,
      directory,
      this.context.host().streamingResponsesDefault,
      selectedBackend,
    );
    if (options.executionMode === "full-access") {
      const decision = await this.context.host().resolveFullAccessRiskForSession(
        session,
        event,
        options,
      );
      if (decision === "blocked") {
        return;
      }
      if (decision === "warning") {
        this.pendingFullAccessNewThreadPrompts.set(session.id, {
          events: bundle.events,
          session,
        });
        await this.context.host().presentFullAccessRiskWarning(
          { kind: "new-thread", session },
          event,
          { presentationMode: "message" },
        );
        return;
      }
    }
    type StartedLaunchpadThread = Pick<
      MaterializedDirectoryLaunchpadThread,
      "backend" | "threadId" | "executionMode"
    > &
      Partial<
        Pick<
          MaterializedDirectoryLaunchpadThread,
          "codexEnvironmentRuntime" | "linkedDirectory" | "workMode"
        >
      >;
    let boundThread:
      | {
          binding: MessagingBindingRecord;
          navigation: MessagingThreadContext;
        }
      | undefined;
    let browseSessionRetired = false;
    const retireBrowseSession = async (): Promise<void> => {
      if (browseSessionRetired) {
        return;
      }
      browseSessionRetired = true;
      this.pendingFullAccessNewThreadPrompts.delete(session.id);
      await this.context.store.deleteBrowseSession(session.id);
    };
    const bindStartedThread = async (
      started: StartedLaunchpadThread,
    ): Promise<{
      binding: MessagingBindingRecord;
      navigation: MessagingThreadContext;
    }> => {
      if (boundThread) {
        return boundThread;
      }
      const binding = await this.context.host().bindingService.bindChannelToThread(event, {
        backend: started.backend,
        threadId: started.threadId,
        ...(project.federationTarget?.scope === "remote" ? { federatedThread: buildFederatedThreadRef({
          backend: started.backend, threadId: started.threadId, instanceId: project.federationTarget.instanceId }) } : {}),
        targetKind: isNewAgentThreadLaunchAction(session.launchAction)
          ? "agent_thread"
          : undefined,
      });
      await retireBrowseSession();
      let updatedBinding = preferences
        ? await this.context.host().bindingService.updateBindingPreferences(binding, preferences)
        : binding;
      if (bundle.session.surface) {
        updatedBinding = await this.context.store.upsertBinding({
          ...updatedBinding,
          statusSurface: bundle.session.surface,
          updatedAt: this.context.now(),
        });
      }
      const optimisticNavigation = buildMessagingStartedThreadContext({
        backend: started.backend,
        directory,
        executionMode: started.executionMode,
        linkedDirectory: started.linkedDirectory,
        navigation,
        now: this.context.now(),
        model: options.supportsModel ? options.model : undefined,
        reasoningEffort: options.supportsReasoning ? options.reasoningEffort : undefined,
        serviceTier: options.serviceTier,
        fastMode: options.supportsFast ? options.fastMode : undefined,
        acpRuntime: options.acpRuntime,
        codexEnvironmentRuntime: started.codexEnvironmentRuntime,
        agent: agentForNewThreadSession(session),
        preferences,
        project,
        threadId: started.threadId,
        worktreePath: started.linkedDirectory?.worktreePath,
        workMode: started.workMode ?? options.workMode,
      });
      boundThread = {
        binding: updatedBinding,
        navigation: optimisticNavigation,
      };
      return boundThread;
    };
    const launchpad = launchpadForMessagingProject({
      backend: selectedBackend.kind,
      directory,
      navigation,
      preferences,
      project,
      now: this.context.now(),
      workMode: options.workMode,
      branchName: options.branchName,
      options,
      acpRuntime: options.acpRuntime,
    });
    const startFirstTurnAfterEnvironmentSetup = Boolean(
      launchpad.codexEnvironmentId,
    );
    const environmentSetupReporter = startFirstTurnAfterEnvironmentSetup
      ? this.createMessagingEnvironmentSetupReporter(event)
      : undefined;
    let materialized: Awaited<
      ReturnType<NonNullable<MessagingBackendBridge["materializeDirectoryLaunchpad"]>>
    > | undefined;
    try {
      materialized = this.context.backend.materializeDirectoryLaunchpad
        ? await this.context.backend.materializeDirectoryLaunchpad(
            {
              directoryKey: messagingLaunchpadMaterializationKey(session),
              ...(project.federationTarget ? { federationTarget: project.federationTarget } : {}),
              agent: agentForNewThreadSession(session),
              launchpad,
              ...(startFirstTurnAfterEnvironmentSetup || prepared.pendingOriginals.length > 0
                ? {}
                : { input: prepared.input }),
            },
            {
              messageOrigin: messageOriginForInboundEvent(event),
              ...(environmentSetupReporter
                ? {
                    onCodexEnvironmentSetupProgress: (
                      setupEvent: CodexEnvironmentSetupProgressEvent,
                    ) => {
                      environmentSetupReporter.record(setupEvent);
                    },
                  }
                : {}),
              onThreadMaterialized: async (started) => {
                await bindStartedThread(started);
              },
            },
          )
        : undefined;
    } finally {
      await environmentSetupReporter?.stop();
    }
    const started = materialized ?? (await this.context.backend.startThread!({
      ...(project.federationTarget ? { federationTarget: project.federationTarget } : {}),
      backend: selectedBackend.kind,
      cwd: directory?.path ?? project.path,
      directoryKey: directory?.key,
      executionMode: options.executionMode,
      fastMode: options.supportsFast ? options.fastMode : undefined,
      model: options.supportsModel ? options.model : undefined,
      reasoningEffort: options.supportsReasoning ? options.reasoningEffort : undefined,
      serviceTier: options.serviceTier,
      acpRuntime: options.acpRuntime,
      agent: agentForNewThreadSession(session),
      ...(options.workMode === "worktree"
        ? {
            workMode: "worktree" as const,
            branchName: options.branchName,
          }
        : {}),
    }));
    const {
      binding: updatedBinding,
      navigation: optimisticNavigation,
    } = await bindStartedThread(started);
    for (const pending of prepared.pendingOriginals) {
      const original = await this.context.config.originalAttachmentStore!.retain({
        ...pending.original,
        scope: {
          backend: updatedBinding.backend, threadId: updatedBinding.threadId, provider: this.context.config.channel,
          ...(updatedBinding.federatedThread?.target.scope === "remote"
            ? { instanceId: updatedBinding.federatedThread.target.instanceId } : {}),
        },
        actorKey: originalAttachmentActorKey(pending.event),
        eventId: pending.event.id,
        attachmentKey: pending.attachmentKey,
        receivedAt: pending.event.receivedAt,
      });
      prepared.input.push({ type: "text", text: formatOriginalAttachmentGuidance(original) });
    }
    await retireBrowseSession();
    if (startFirstTurnAfterEnvironmentSetup && materialized) {
      await this.deliverMessagingEnvironmentSetupFinal({
        binding: updatedBinding,
        event,
        materialized,
      });
      await this.context.host().bindingService.renderBindingStatus(updatedBinding, event, optimisticNavigation);
    }
    if (materialized?.turnStartFailure) {
      const activeTurn = this.context.host().getActiveTurn(updatedBinding);
      if (activeTurn?.status === "failed") {
        await this.context.host().bindingService.renderBindingStatus(updatedBinding, event, optimisticNavigation);
        return;
      }
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("turn-start-failed"),
          createdAt: this.context.now(),
          title: "Turn could not start",
          body: materialized.turnStartFailure.message,
          recoverable: true,
        }),
        updatedBinding,
        event,
      );
      await this.context.host().bindingService.renderBindingStatus(updatedBinding, event, optimisticNavigation);
      return;
    }
    if (materialized?.turnId) {
      this.context.logger.info?.("messaging materialized launchpad turn started", {
        bindingId: updatedBinding.id,
        threadId: started.threadId,
        turnId: materialized.turnId,
      });
      await this.adoptStartedTurn({
        binding: updatedBinding,
        event,
        navigation: optimisticNavigation,
        turnId: materialized.turnId,
      });
      return;
    }
    if (startFirstTurnAfterEnvironmentSetup) {
      await this.startPreparedInput({
        binding: updatedBinding,
        input: prepared.input,
        preview: prepared.preview,
        threadKey: buildThreadIdentityKey(started.backend, started.threadId),
        event,
        navigation: optimisticNavigation,
      });
      return;
    }
    if (materialized) {
      this.context.logger.debug?.("messaging materialized launchpad without turn id", {
        bindingId: updatedBinding.id,
        threadId: started.threadId,
      });
    }
    await this.startPreparedInput({
      binding: updatedBinding,
      input: prepared.input,
      preview: prepared.preview,
      threadKey: buildThreadIdentityKey(started.backend, started.threadId),
      event,
      navigation: optimisticNavigation,
    });
  }

  createMessagingEnvironmentSetupReporter(
    event: MessagingInboundEvent,
  ): {
    record: (setupEvent: CodexEnvironmentSetupProgressEvent) => void;
    stop: () => Promise<void>;
  } {
    let latestEvent: CodexEnvironmentSetupProgressEvent | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    let deliveryQueue: Promise<void> = Promise.resolve();
    let stopped = false;

    const deliverProgress = (setupEvent: CodexEnvironmentSetupProgressEvent) => {
      deliveryQueue = deliveryQueue.then(async () => {
        try {
          await this.context.host().deliver(
            buildConfirmationIntent({
              id: this.context.host().newIntentId("environment-setup-progress"),
              capabilityProfile: this.context.capabilityProfile,
              createdAt: this.context.now(),
              title: "Environment setup running",
              body: buildMessagingEnvironmentSetupProgressBody(setupEvent),
            }),
            undefined,
            event,
          );
        } catch (error) {
          this.context.logger.debug?.("messaging environment setup progress deliver failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    };

    const ensureInterval = () => {
      if (interval || stopped) {
        return;
      }
      interval = setInterval(() => {
        if (latestEvent && !isTerminalCodexEnvironmentSetupProgress(latestEvent)) {
          deliverProgress(latestEvent);
        }
      }, MESSAGING_ENVIRONMENT_SETUP_PROGRESS_INTERVAL_MS);
    };

    return {
      record: (setupEvent) => {
        latestEvent = setupEvent;
        if (setupEvent.phase === "started") {
          deliverProgress(setupEvent);
          ensureInterval();
          return;
        }
        if (isTerminalCodexEnvironmentSetupProgress(setupEvent)) {
          if (interval) {
            clearInterval(interval);
            interval = undefined;
          }
          return;
        }
        ensureInterval();
      },
      stop: async () => {
        stopped = true;
        if (interval) {
          clearInterval(interval);
          interval = undefined;
        }
        await deliveryQueue;
      },
    };
  }

  async deliverMessagingEnvironmentSetupFinal(params: {
    binding: MessagingBindingRecord;
    event: MessagingInboundEvent;
    materialized: MaterializedDirectoryLaunchpadThread;
  }): Promise<void> {
    const runtime = params.materialized.codexEnvironmentRuntime;
    const failure = params.materialized.codexEnvironmentStartupFailure;
    if (failure) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("environment-startup-failed"),
          createdAt: this.context.now(),
          title: failure.phase === "action"
            ? "Environment action failed"
            : "Environment setup failed",
          body: buildMessagingEnvironmentSetupFailureBody(runtime, failure.message),
          recoverable: true,
        }),
        params.binding,
        params.event,
      );
      return;
    }

    await this.context.host().deliver(
      buildConfirmationIntent({
        id: this.context.host().newIntentId("environment-startup-succeeded"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        title: runtime?.setupStatus === "skipped"
          ? "Environment setup skipped"
          : "Environment setup completed",
        body: buildMessagingEnvironmentSetupSuccessBody(runtime),
      }),
      params.binding,
      params.event,
    );
  }

  async loadDefaultAgentBackendSummaries(): Promise<
    BackendSummary[] | undefined
  > {
    if (!this.context.backend.listBackends) {
      return undefined;
    }
    try {
      return (await this.context.backend.listBackends({
        includeUnavailable: true,
      })).backends;
    } catch (error) {
      this.context.logger.debug?.("default Agent backend capability lookup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  clearAdmissionTiming(): void {
    this.admissionStageMarks.clear();
  }

  clearPendingPrompts(): void {
    for (const pending of this.pendingNewThreadPrompts.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    this.pendingNewThreadPrompts.clear();
    this.pendingFullAccessNewThreadPrompts.clear();
  }
}
