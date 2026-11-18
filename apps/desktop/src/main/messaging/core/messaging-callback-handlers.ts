import { messageOriginForInboundEvent, readStringValue } from "./messaging-command-helpers";
import { federationTargetForBinding } from "./messaging-backend-event-helpers";
import { codexSpeedOptions, codexSpeedSettings, nextCodexSpeed } from "@pwragent/shared";
import { readMessagingLaunchpadContext } from "./messaging-launchpad-context";
import { applyNavigationLaunchpadProviderSettingsPatch, buildFederatedThreadRef, isAcpBackendId, permissionForActionId } from "@pwragent/shared";
import type { MessagingCallbackHandleRecord, MessagingBrowseSessionRecord, MessagingDefaultAgentAssignmentRecord, MessagingInboundCallbackEvent, MessagingInboundEvent, MessagingInboundTextEvent, MessagingManagedConversationActionResult, MessagingPendingIntentRecord, MessagingSurfaceRef } from "@pwragent/messaging-interface";
import { defaultAgentBackendSupport } from "./messaging-default-agent.js";
import { buildConfirmationIntent, buildErrorIntent } from "./messaging-renderer.js";
import { actionsForIntent } from "./deterministic-interaction-mapper.js";
import { isNewThreadLaunchAction, resumeReturnTargetForSession, selectProjectFromValue, selectThreadFromValue, shouldStartNewAgentThreadFromSession } from "./messaging-resume-browser.js";
import { nextMessagingStreamingResponseMode } from "./messaging-status-card.js";
import { acpBackendUsesExecutionModePermissions, buildMessagingAcpRuntimeModeSummary } from "./messaging-acp-runtime.js";
import { skillsBrowserPageFromValue } from "./messaging-skills-browser.js";
import { type MessagingThreadContext } from "./messaging-thread-state.js";
import { type MessagingQueuedTurnEntry } from "./messaging-queue-recoveries";
import { readPrivateReplyAction, type PrivateReplyAction, readCommandAction, readHelpNavAction, readBrowseAction, readPermissionsQueueCancelAction, readMonitorAction, readFullAccessRiskAction, readAcpRuntimeRiskAction, readStatusAction, readQueuedTurnAction, type QueuedTurnAction, readBindingTarget, boundThreadConfirmationBody, boundThreadFallbackText, approvalResponseLabel, buildQueuedInputPreview, isSameMessagingSurface, readHelpPageIndex, directoryForProjectSelection, resolveNewThreadWorkMode, canCreateNewThreadWorktree, resolveNewThreadBaseBranch, branchPageIndexFromValue, newThreadOptionsForSession, readMessagingToolUpdateModeValue, normalizeNewThreadSessionForBackend, clearNewThreadProviderPreferences, normalizeReasoningEffortForModel, formatDefaultAgentScope, normalizeMonitorCallbackAction, topicChannelRef, findThreadForBinding, readFullAccessRiskContext, type FullAccessRiskWarningContext, readAcpRuntimeRiskContext, type AcpRuntimeRiskWarningContext, type FullAccessEscalationContext } from "./messaging-callback-helpers";
import type { MessagingCallbackContext } from "./messaging-callback-context";

export class MessagingCallbackHandlers {
  constructor(private readonly context: MessagingCallbackContext) {}

  private async handleQueuedTurnCallback(
    event: MessagingInboundCallbackEvent,
    action: QueuedTurnAction,
  ): Promise<void> {
    const entry = this.context.host().queueRecoveries.get(action.entryId)
      ?? [...this.context.host().sharedQueueNotices.values()].flatMap((state) =>
        state.phase === "announcing" || state.phase === "queued" ? [state.entry] : [],
      ).find((candidate) => candidate.id === action.entryId);
    if (!entry || entry.status !== "queued") {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("expired-queued-turn"),
          createdAt: this.context.now(),
          title: "Queued message unavailable",
          body: "That queued message is no longer waiting.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    if (action.kind === "retry") {
      if (!entry.manualRetryRequired
        || !(await this.context.host().requirePermission(event, "message.reply", "queued-turn:retry"))
        || !(await this.context.host().requireRemoteScopeForBinding(event, entry.binding, "queued-turn:retry:remote-instance"))
        || this.context.host().turnAdmission.isStarting(entry.threadKey)) return;
      const claim = this.context.host().queueRecoveries.claim(entry.id);
      if (!claim) return;
      let accepted = false;
      try {
        const result = await this.context.host().startPreparedInput({
          binding: entry.binding, event: entry.event, input: entry.input,
          pdfAttachments: entry.pdfAttachments, privateResponseRequested: entry.privateResponseRequested,
          preview: entry.preview, threadKey: entry.threadKey, reportBusyRefusal: false,
        });
        if (result === "failed") return;
        accepted = true;
        const retiredEntry = this.context.host().queueRecoveries.settle(entry.id, claim.receipt, true) ?? entry;
        await this.context.host().retireQueuedTurnNotice(retiredEntry, result === "queued"
          ? "Queued message handed to the thread queue."
          : "Queued message sent as the next turn.", event);
      } finally {
        this.context.host().queueRecoveries.settle(entry.id, claim.receipt, accepted);
      }
      return;
    }

    if (entry.ownerQueueEntryId) {
      if (action.kind === "cancel") {
        await this.handleSharedQueuedTurnCallback(entry, event, action.kind);
      } else {
        entry.status = "steering";
        this.context.host().trackQueuedTurnAction(entry, this.handleSharedQueuedTurnCallback(entry, event, action.kind).finally(() => {
          if (entry.status === "steering") entry.status = "queued";
        }));
      }
      return;
    }

    if (action.kind === "cancel") {
      if (this.context.host().queueRecoveries.cancel(entry.id)) {
        await this.context.host().retireQueuedTurnNotice(entry, "Queued message cancelled.", event);
      }
      return;
    }

    // Recovery input has no owner queue entry. Claim it before the first
    // await, but release ingress so escalation answers can still arrive.
    const claim = this.context.host().queueRecoveries.claim(entry.id);
    if (claim) this.context.host().trackQueuedTurnAction(entry, this.steerRecovery(entry, event, claim.receipt));
  }

  private async steerRecovery(entry: MessagingQueuedTurnEntry, event: MessagingInboundCallbackEvent, receipt: symbol): Promise<void> {
    let accepted = false;
    try {
      const active = await this.context.host().resolveSteerableActiveTurn(entry.binding, "queued_turn_steer");
      if (this.context.host().isDisposed()) return;
      if (entry.pdfAttachments?.length || !this.context.backend.steerTurn || !active || !["working", "waiting"].includes(active.status)) {
        await this.context.host().deliver(buildErrorIntent({ id: this.context.host().newIntentId("queued-turn-steer-unavailable"),
          createdAt: this.context.now(), title: "Steer unavailable",
          body: "There is no active turn available to steer. The message is still queued.", recoverable: true,
        }), entry.binding, event);
        return;
      }
      try {
        await this.context.backend.steerTurn({ backend: entry.binding.backend, federationTarget: federationTargetForBinding(entry.binding),
          threadId: entry.binding.threadId, expectedTurnId: active.turnId, input: entry.input, requestId: entry.id,
          messageOrigin: messageOriginForInboundEvent(entry.event, entry.event ? this.context.host().rememberHumanMessagingSource(entry.binding, entry.event)?.ref : undefined),
        });
      } catch (error) {
        if (this.context.host().isDisposed()) return;
        await this.context.host().deliver(buildErrorIntent({ id: this.context.host().newIntentId("queued-turn-steer-failed"),
          createdAt: this.context.now(), title: "Steer failed",
          body: `${error instanceof Error ? error.message : String(error)}\n\nThe message is still queued.`, recoverable: true,
        }), entry.binding, event);
        return;
      }
      accepted = true;
      const retiredEntry = this.context.host().queueRecoveries.settle(entry.id, receipt, true) ?? entry;
      if (this.context.host().isDisposed()) return;
      await this.context.host().retireQueuedTurnNotice(retiredEntry, "Queued message was sent as a steering message.", event);
    } finally {
      this.context.host().queueRecoveries.settle(entry.id, receipt, accepted);
    }
  }

  private async handleSharedQueuedTurnCallback(
    entry: MessagingQueuedTurnEntry,
    event: MessagingInboundCallbackEvent,
    kind: "cancel" | "steer",
  ): Promise<void> {
    const backend = this.context.backend;
    const target = federationTargetForBinding(entry.binding);
    try {
      if (!backend.cancelQueuedTurn || !backend.readQueuedTurn) throw new Error("The thread owner cannot edit this queue.");
      // Desktop viewers can edit queued content. Read the owner before
      // removing it; its hash makes cancellation refuse a concurrent edit.
      const content = await backend.readQueuedTurn({ backend: entry.binding.backend,
        threadId: entry.binding.threadId, federationTarget: target, queueEntryId: entry.id, forEdit: true });
      const active = kind === "steer" ? await this.context.host().resolveSteerableActiveTurn(entry.binding, "queued_turn_steer") : undefined;
      if (kind === "steer" && (entry.pdfAttachments?.length || !backend.steerTurn || !active || !["working", "waiting"].includes(active.status))) {
        throw new Error("There is no active turn available to steer. The message is still queued.");
      }
      const cancelled = await backend.cancelQueuedTurn({ federationTarget: target,
        queueEntryId: entry.id, expectedContentHash: content.contentHash });
      if (!cancelled.cancelled) throw new Error("The queued message changed or has already been admitted. Refresh the thread queue.");
      if (kind === "steer" && active && backend.steerTurn) {
        try {
          await backend.steerTurn({ backend: entry.binding.backend, federationTarget: target,
            threadId: entry.binding.threadId, expectedTurnId: active.turnId, requestId: entry.id,
            input: content.input, messageOrigin: content.messageOrigin });
        } catch (error) {
          // Cancellation succeeded, so restore the owner's current content
          // through normal admission if the turn ended before steering.
          const restored = await this.context.host().startPreparedInput({
            binding: entry.binding, event: entry.event, input: content.input,
            pdfAttachments: entry.pdfAttachments, privateResponseRequested: entry.privateResponseRequested,
            preview: entry.preview, threadKey: entry.threadKey, reportBusyRefusal: false,
          });
          if (restored === "failed") {
            // The owner no longer has this input. Retain a separate recovery
            // entry until an operator's Retry is accepted; idle events must
            // not repeatedly submit it while the owner is unavailable.
            const recovery = this.context.host().queueRecoveries.hold({
              binding: entry.binding, event: entry.event, input: content.input,
              pdfAttachments: entry.pdfAttachments,
              privateResponseRequested: entry.privateResponseRequested,
              preview: buildQueuedInputPreview(content.input.flatMap((item) => item.type === "text" ? [item.text] : [])) || entry.preview,
              threadKey: entry.threadKey,
            });
            if (recovery) await this.context.host().deliverQueuedTurnNotice(recovery);
          }
          throw error;
        }
      }
      await this.context.host().applySharedQueueNoticeEvent(`${entry.threadKey}:${entry.id}`, {
        type: "ownerOutcome", outcome: { status: "cancelled" },
      });
      await this.context.host().retireQueuedTurnNotice(entry, kind === "steer"
        ? "Queued message was sent as a steering message." : "Queued message cancelled.", event);
    } catch (error) {
      await this.context.host().deliver(buildErrorIntent({ id: this.context.host().newIntentId("queued-turn-action-failed"),
        createdAt: this.context.now(), title: "Queued message could not be updated",
        body: error instanceof Error ? error.message : String(error), recoverable: true,
      }), entry.binding, event);
    }
  }

  async handleCallback(event: MessagingInboundCallbackEvent): Promise<void> {
    if (event.actionId === "claude:continue-session") {
      await this.context.host().commandHandlers.continueClaudeThreadInNewSession(event);
      return;
    }
    const privateReplyAction = readPrivateReplyAction(event);
    if (privateReplyAction) {
      await this.handlePrivateReplyCallback(event, privateReplyAction);
      return;
    }
    if (event.actionId === "agent-default:set") {
      await this.context.host().presentDefaultAgentAssignmentBrowser(event, "conversation");
      return;
    }
    if (event.actionId === "agent-default:clear") {
      await this.context.host().clearDefaultAgentAssignment(event, "conversation");
      return;
    }
    const command = readCommandAction(event);
    if (command) {
      await this.context.host().commandHandlers.handleCommand(
        {
          ...event,
          kind: "command",
          args: [],
          command,
          rawText: `/${command}`,
        },
        {
          targetSurface: event.sourceSurface,
        },
      );
      return;
    }

    const helpAction = readHelpNavAction(event);
    if (helpAction) {
      await this.handleHelpNavCallback(event, helpAction);
      return;
    }

    const browseAction = readBrowseAction(event);
    if (browseAction) {
      await this.handleBrowseCallback(event, browseAction);
      return;
    }

    const permissionsQueueCancelAction = readPermissionsQueueCancelAction(event);
    if (permissionsQueueCancelAction) {
      await this.handlePermissionsQueueCancelCallback(
        event,
        permissionsQueueCancelAction.queueId,
      );
      return;
    }

    const monitorAction = readMonitorAction(event);
    if (monitorAction) {
      await this.handleMonitorCallback(event, monitorAction);
      return;
    }

    const fullAccessRiskAction = readFullAccessRiskAction(event);
    if (fullAccessRiskAction) {
      await this.handleFullAccessRiskCallback(event, fullAccessRiskAction);
      return;
    }

    const acpRuntimeRiskAction = readAcpRuntimeRiskAction(event);
    if (acpRuntimeRiskAction) {
      await this.handleAcpRuntimeRiskCallback(event, acpRuntimeRiskAction);
      return;
    }

    const statusAction = readStatusAction(event);
    if (statusAction) {
      await this.handleStatusCallback(event, statusAction);
      return;
    }

    const queuedTurnAction = readQueuedTurnAction(event);
    if (queuedTurnAction) {
      await this.handleQueuedTurnCallback(event, queuedTurnAction);
      return;
    }

    const bindingTarget = readBindingTarget(event);
    if (bindingTarget) {
      const federationTarget = bindingTarget.federatedThread?.target;
      // RBAC scope: binding to a thread that lives on a federated peer is
      // remote control, whatever the thread's execution mode. Gate before the
      // bind so an actor without the scope can never create a remote binding
      // (the picker also hides remote threads from them).
      if (
        !(await this.context.host().requireRemoteScope(
          event,
          federationTarget,
          "resume:remote-instance",
        ))
      ) {
        return;
      }
      const targetThread = await this.context.host().readExactNavigationThread({
        ref: { backend: bindingTarget.backend, threadId: bindingTarget.threadId,
          ...(federationTarget?.scope === "remote" ? { ownerInstanceId: federationTarget.instanceId } : {}) },
        federationTarget,
      });
      if (!targetThread || targetThread.archivedAt) {
        await this.context.host().deliver(buildErrorIntent({ id: this.context.host().newIntentId("bind-unavailable"), createdAt: this.context.now(),
          title: "Thread unavailable", body: "The owning instance could not resolve an active thread. Refresh the thread picker.", recoverable: true }), undefined, event);
        return;
      }
      if (targetThread?.executionMode === "full-access") {
        // RBAC: binding a conversation to a Full Access thread needs the danger
        // permission, in addition to the global resume-full-access setting.
        if (
          !(await this.context.host().requirePermission(
            event,
            "thread.execution.full_access",
            "resume:full-access",
          ))
        ) {
          return;
        }
        if (!(await this.context.host().canResumeFullAccessThreads())) {
          await this.context.host().deliverFullAccessPolicyError(
            undefined,
            event,
            "Full Access threads cannot be resumed from messaging with the current settings.",
          );
          return;
        }
      }
      const binding = await this.context.host().bindChannelToThread(event, bindingTarget);
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("bound"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: this.context.now(),
          title: "Thread bound",
          body: boundThreadConfirmationBody(binding, this.context.capabilityProfile),
          fallbackText: boundThreadFallbackText(binding, this.context.capabilityProfile),
        }),
        binding,
      );
      await this.context.host().renderBindingStatus(binding);
      await this.context.host().repostLastAssistantMessageForResume(binding);
      return;
    }

    const pendingIntent = await this.pendingIntentForCallback(
      event,
      await this.context.store.findActivePendingIntentForChannel({
        actorId: event.actor.platformUserId,
        channel: event.channel,
        now: this.context.now(),
      }),
    );
    if (pendingIntent) {
      const action = actionsForIntent(pendingIntent.intent).find(
        (candidate) => candidate.id === (event.actionId ?? event.interaction.id),
      );
      if (action && pendingIntent.intent.kind === "approval") {
        // RBAC (fail closed): a pending-request approval is the agent asking to
        // act OUTSIDE its sandbox (run a command, touch the network/filesystem).
        // We can't reliably prove any such request is benign, so every one
        // requires the escalation permission — never the weaker default. This
        // avoids under-classifying an exec/network approval whose payload lacks
        // the subject fields (path/grantRoot/diff/files) we can recognize.
        if (
          !(await this.context.host().requirePermission(
            event,
            "approval.respond.escalation",
            "approval:respond",
          ))
        ) {
          return;
        }
        if (await this.retireApprovalCallbackIfBackendIdle(pendingIntent, event)) {
          return;
        }
        const decision = await this.context.host().submitApprovalAction(
          pendingIntent.intent,
          action.id,
        );
        await this.context.host().retireApprovalIntent(
          pendingIntent,
          event,
          approvalResponseLabel(decision),
        );
        await this.context.store.deletePendingIntent(pendingIntent.id);
        await this.context.host().resumeBindingForPendingIntent(
          pendingIntent,
          "pending_request.submitted",
        );
        return;
      }
      if (action && pendingIntent.intent.kind === "questionnaire") {
        if (
          !(await this.context.host().requirePermission(
            event,
            "elicitation.answer",
            "questionnaire:answer",
          ))
        ) {
          return;
        }
        await this.context.host().handleQuestionnaireAction(pendingIntent, event, action);
        return;
      }
      if (action && pendingIntent.intent.kind === "review") {
        await this.context.host().handleReviewAction(pendingIntent, event, action);
        return;
      }
    }

    if ((event.actionId ?? event.interaction.id).startsWith("approval:")) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("expired-approval"),
          createdAt: this.context.now(),
          title: "Approval expired",
          body: "That approval request is no longer available. Retry the command or request that needed approval.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    if ((event.actionId ?? event.interaction.id).startsWith("questionnaire:")) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("expired-questionnaire"),
          createdAt: this.context.now(),
          title: "Input request expired",
          body: "That input request is no longer available. Retry the command or request that needed input.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    if ((event.actionId ?? event.interaction.id).startsWith("review:")) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("expired-review"),
          createdAt: this.context.now(),
          title: "Review picker expired",
          body: "That review picker is no longer available. Send /review to open a new one.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    await this.context.host().deliver(
      buildErrorIntent({
        id: this.context.host().newIntentId("expired-callback"),
        createdAt: this.context.now(),
        title: "Action expired",
        body: "That action is no longer available. Use /resume to refresh.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  /**
   * A channel's newest pending intent answers its callbacks, but an agent can
   * ask a second async question while an earlier card is still open. A click
   * on the earlier card must act on that card, not on the newest question.
   */
  private async pendingIntentForCallback(
    event: MessagingInboundCallbackEvent,
    newest: MessagingPendingIntentRecord | undefined,
  ): Promise<MessagingPendingIntentRecord | undefined> {
    const clicked = event.sourceSurface;
    const actionId = event.actionId ?? event.interaction.id;
    if (actionId.startsWith("approval:")) {
      if (newest?.intent.kind !== "approval") return undefined;
      // Action ids (such as approval:mcp:accept) are shared by every card.
      // A provider's durable handle or the clicked surface must identify
      // this exact proposal; an old button must never approve a newer one.
      const handle = await this.resolveCallbackHandleForEvent(event);
      const identifies = (candidate: MessagingPendingIntentRecord) => handle?.pendingIntentId
        ? handle.pendingIntentId === candidate.id
        : Boolean(clicked && isSameMessagingSurface(clicked, candidate.surface));
      if (identifies(newest)) return newest;
      // Creation time establishes supersession only when it is strictly
      // later. The store's first row in a tie is not the clicked proposal.
      // Resolve another live card in that same binding and time cohort by
      // identity, keeping actor/channel/expiry filtering in the store.
      const candidates = await this.context.store.findActivePendingIntentsForChannel({
        actorId: event.actor.platformUserId,
        channel: event.channel,
        now: this.context.now(),
      });
      if (candidates.some(candidate => candidate.createdAt > newest.createdAt)) return undefined;
      return candidates.find(candidate =>
        candidate.intent.kind === "approval"
        && candidate.bindingId === newest.bindingId
        && candidate.createdAt === newest.createdAt
        && identifies(candidate)
      );
    }
    if (
      !clicked
      || (newest && isSameMessagingSurface(clicked, newest.surface))
      // Only a questionnaire button can belong to an older async card.
      || !(actionId.startsWith("questionnaire:") || actionId.startsWith("async-question:"))
    ) {
      return newest;
    }
    const binding = await this.context.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      return newest;
    }
    const questionnaires =
      await this.context.store.findActivePendingAsyncQuestionnaires({
        backend: binding.backend,
        threadId: binding.threadId,
        now: this.context.now(),
      });
    return questionnaires.find((candidate) =>
      candidate.bindingId === binding.id
      && candidate.allowedActorIds.includes(event.actor.platformUserId)
      && isSameMessagingSurface(clicked, candidate.surface)
    ) ?? newest;
  }

  /**
   * Handle navigation callbacks on the paginated help surface
   * (Prev / Next / Cancel). The page index travels in
   * `event.value.pageIndex` so help has no persistent session
   * record — re-rendering is a function of catalog + page index.
   *
   * `targetSurface` is taken from the originating callback's
   * interaction state so the help post is updated in place rather
   * than stacking new posts on every Next click.
   */
  private async handleHelpNavCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    const targetSurface: MessagingSurfaceRef | undefined = {
      channel: event.interaction.channel,
      id: event.interaction.id,
      ...(event.interaction.state ? { state: event.interaction.state } : {}),
    };
    if (actionId === "help:cancel") {
      // Replace the help body with a brief dismissal and strip the
      // action row. Mirrors the resume browser's "Resume cancelled"
      // pattern for consistent dismissed-surface UX across both
      // paginated flows.
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("help-dismissed"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: this.context.now(),
          title: "Help dismissed",
          body: "Send `/help` or `@<bot> help` to see commands again.",
          actions: [],
          delivery: { mode: "update", replaceMarkup: true },
          targetSurface,
        }),
        undefined,
        event,
      );
      return;
    }
    const requestedPage = readHelpPageIndex(event);
    await this.context.host().commandHandlers.presentHelp(event, {
      pageIndex: requestedPage,
      targetSurface,
    });
  }

  private async handleBrowseCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    const session = await this.findBrowseSessionForCallback(event);
    if (!session) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("expired-browse"),
          createdAt: this.context.now(),
          title: "Action expired",
          body: "That browser action is no longer available. Use /resume to refresh.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const navigation = await readMessagingLaunchpadContext({ backend: this.context.backend,
      ...(actionId.startsWith("browse:new:") ? { project: session.selectedProject } : {}) });
    const nextSession = {
      ...session,
      updatedAt: this.context.now(),
    };

    if (actionId === "browse:page:next") {
      await this.context.host().renderResumeBrowser(
        { ...nextSession, pageIndex: nextSession.pageIndex + 1 },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:page:prev") {
      await this.context.host().renderResumeBrowser(
        { ...nextSession, pageIndex: Math.max(0, nextSession.pageIndex - 1) },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:projects") {
      await this.context.host().renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "resume_thread",
          mode: "projects",
          pageIndex: 0,
          returnTo: shouldStartNewAgentThreadFromSession(session)
            ? session.returnTo ?? resumeReturnTargetForSession(session)
            : undefined,
          selectedProject: undefined,
          directorySelector: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:recents") {
      await this.context.host().renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "resume_thread",
          mode: "recents",
          pageIndex: 0,
          returnTo: shouldStartNewAgentThreadFromSession(session)
            ? session.returnTo ?? resumeReturnTargetForSession(session)
            : undefined,
          selectedProject: undefined,
          directorySelector: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:agents") {
      await this.context.host().renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "resume_thread",
          mode: "agents",
          pageIndex: 0,
          selectedProject: undefined,
          directorySelector: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:new") {
      const selectedBackend = await this.context.host().resolveNewThreadBackendForSession(
        {
          launchpadBackend: navigation.launchpadDefaults.backend,
          session: nextSession,
        },
        event,
      );
      if (!selectedBackend) {
        return;
      }
      await this.context.host().renderResumeBrowser(
        {
          ...nextSession,
          backend: selectedBackend.kind,
          launchAction: shouldStartNewAgentThreadFromSession(session)
            ? "start_new_agent_thread"
            : "start_new_thread",
          mode: "new_project",
          pageIndex: 0,
          returnTo: session.returnTo ?? resumeReturnTargetForSession(nextSession),
          selectedProject: undefined,
          directorySelector: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:new-agent") {
      const selectedBackend = await this.context.host().resolveNewThreadBackendForSession(
        {
          launchpadBackend: navigation.launchpadDefaults.backend,
          session: nextSession,
        },
        event,
      );
      if (!selectedBackend) {
        return;
      }
      await this.context.host().renderResumeBrowser(
        {
          ...nextSession,
          backend: selectedBackend.kind,
          launchAction: "start_new_agent_thread",
          mode: "new_project",
          pageIndex: 0,
          selectedProject: undefined,
          directorySelector: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:new-thread") {
      const selectedBackend = await this.context.host().resolveNewThreadBackendForSession(
        {
          launchpadBackend: navigation.launchpadDefaults.backend,
          session: nextSession,
        },
        event,
      );
      if (!selectedBackend) {
        return;
      }
      await this.context.host().renderResumeBrowser(
        {
          ...nextSession,
          backend: selectedBackend.kind,
          launchAction: "start_new_thread",
          mode: "new_project",
          pageIndex: 0,
          selectedProject: undefined,
          directorySelector: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:resume") {
      const target = session.returnTo;
      await this.context.host().renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "resume_thread",
          mode: target?.mode ?? "recents",
          pageIndex: target?.pageIndex ?? 0,
          preferences: target?.preferences,
          query: target?.query,
          returnTo: undefined,
          selectedProject: target?.selectedProject,
          directorySelector: target?.directorySelector,
          workMode: undefined,
          branchName: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:cancel") {
      await this.context.host().retireBrowseSession(session);
      if (session.cancelDestination === "help" && session.surface) {
        await this.context.host().commandHandlers.presentHelp(event, {
          targetSurface: session.surface,
        });
        return;
      }
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("browse-cancelled"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: this.context.now(),
          delivery: session.surface
            ? {
                mode: "update",
                replaceMarkup: true,
              }
            : undefined,
          title: "Resume cancelled",
          body: "No thread binding changed.",
          targetSurface: session.surface,
        }),
        undefined,
        event,
      );
      return;
    }
    if (actionId === "browse:select-project") {
      const project = selectProjectFromValue(event.value);
      if (!project) {
        await this.context.host().deliverInvalidBrowseSelection(event);
        return;
      }
      if (isNewThreadLaunchAction(session.launchAction)) {
        await this.context.host().startNewThreadFromProject(event, session, navigation, project);
        return;
      }
      await this.context.host().renderResumeBrowser(
        {
          ...nextSession,
          mode: "project_threads",
          pageIndex: 0,
          selectedProject: project,
          directorySelector: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:new:workspace:toggle") {
      const directory = nextSession.selectedProject
        ? directoryForProjectSelection(navigation, nextSession.selectedProject)
        : undefined;
      const currentWorkMode = resolveNewThreadWorkMode({
        requestedWorkMode:
          nextSession.workMode ??
          directory?.launchpad?.workMode ??
          navigation.launchpadDefaults.workMode ??
          "local",
        directory,
      });
      const nextWorkMode =
        currentWorkMode === "worktree" || !canCreateNewThreadWorktree(directory)
          ? "local"
          : "worktree";
      const branchName = nextWorkMode === "worktree"
        ? resolveNewThreadBaseBranch(nextSession, navigation, directory)
        : undefined;
      await this.context.host().updateNewThreadStickySettings(nextSession, {
        branchName,
        workMode: nextWorkMode,
      });
      await this.context.host().presentNewThreadPromptGate(
        {
          ...nextSession,
          workMode: nextWorkMode,
          branchName,
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:workspace:local") {
      await this.context.host().updateNewThreadStickySettings(nextSession, {
        branchName: undefined,
        workMode: "local",
      });
      await this.context.host().presentNewThreadPromptGate(
        {
          ...nextSession,
          workMode: "local",
          branchName: undefined,
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:workspace:worktree") {
      const directory = nextSession.selectedProject
        ? directoryForProjectSelection(navigation, nextSession.selectedProject)
        : undefined;
      if (!canCreateNewThreadWorktree(directory)) {
        await this.context.host().presentNewThreadPromptGate(
          {
            ...nextSession,
            workMode: "local",
            branchName: undefined,
          },
          event,
          navigation,
        );
        return;
      }
      const branchName = resolveNewThreadBaseBranch(nextSession, navigation);
      await this.context.host().updateNewThreadStickySettings(nextSession, {
        branchName,
        workMode: "worktree",
      });
      await this.context.host().presentNewThreadPromptGate(
        {
          ...nextSession,
          workMode: "worktree",
          branchName,
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:base-branch") {
      const directory = nextSession.selectedProject
        ? directoryForProjectSelection(navigation, nextSession.selectedProject)
        : undefined;
      if (!canCreateNewThreadWorktree(directory)) {
        await this.context.host().presentNewThreadPromptGate(
          {
            ...nextSession,
            workMode: "local",
            branchName: undefined,
          },
          event,
          navigation,
        );
        return;
      }
      await this.context.host().presentNewThreadBranchPicker(nextSession, navigation, event);
      return;
    }
    if (
      actionId === "browse:new:branches:next" ||
      actionId === "browse:new:branches:previous"
    ) {
      await this.context.host().presentNewThreadBranchPicker(
        nextSession,
        navigation,
        event,
        branchPageIndexFromValue(event.value),
      );
      return;
    }
    if (actionId === "browse:new:set-base-branch") {
      const branchName = readStringValue(event.value, "branchName");
      if (!branchName) {
        await this.context.host().deliverInvalidBrowseSelection(event);
        return;
      }
      const directory = nextSession.selectedProject
        ? directoryForProjectSelection(navigation, nextSession.selectedProject)
        : undefined;
      if (!canCreateNewThreadWorktree(directory)) {
        await this.context.host().presentNewThreadPromptGate(
          {
            ...nextSession,
            workMode: "local",
            branchName: undefined,
          },
          event,
          navigation,
        );
        return;
      }
      await this.context.host().updateNewThreadStickySettings(nextSession, {
        branchName,
        workMode: "worktree",
      });
      await this.context.host().presentNewThreadPromptGate(
        {
          ...nextSession,
          workMode: "worktree",
          branchName,
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:permissions") {
      if (nextSession.backend && isAcpBackendId(nextSession.backend)) {
        const summary = await this.context.host().getBackendSummary(nextSession.backend);
        const directory = nextSession.selectedProject
          ? directoryForProjectSelection(navigation, nextSession.selectedProject)
          : undefined;
        const runtimeChoices = summary
          && !acpBackendUsesExecutionModePermissions(summary)
          ? buildMessagingAcpRuntimeModeSummary({
              backend: summary,
              runtime: newThreadOptionsForSession(
                nextSession,
                navigation,
                directory,
                this.context.host().streamingResponsesDefault,
                summary,
              ).acpRuntime,
            }).choices
          : [];
        if (runtimeChoices.length > 0) {
          await this.context.host().presentNewThreadAcpRuntimeModePicker(
            nextSession,
            event,
            nextSession.backend,
            navigation,
          );
        } else {
          await this.context.host().presentNewThreadPermissionsPicker(nextSession, event, navigation);
        }
        return;
      }
      await this.context.host().presentNewThreadPermissionsPicker(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:set-permissions") {
      await this.context.host().setNewThreadPermissions(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:environment") {
      await this.context.host().presentNewThreadEnvironmentPicker(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:environment:back") {
      await this.context.host().presentNewThreadPromptGate(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:set-environment") {
      await this.context.host().setNewThreadEnvironment(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:runtime-mode") {
      await this.context.host().presentNewThreadAcpRuntimeModePicker(
        nextSession,
        event,
        nextSession.backend ?? navigation.launchpadDefaults.backend,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:set-runtime-mode") {
      await this.context.host().setNewThreadAcpRuntimeMode(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:fast") {
      const backend = await this.context.host().resolveNewThreadBackendForSession({
        launchpadBackend: navigation.launchpadDefaults.backend,
        session: nextSession,
      }, event);
      if (!backend) return;
      const directory = nextSession.selectedProject
        ? directoryForProjectSelection(navigation, nextSession.selectedProject)
        : undefined;
      const options = newThreadOptionsForSession(
        nextSession,
        navigation,
        directory,
        this.context.host().streamingResponsesDefault,
        backend,
      );
      const models = backend.launchpadOptions?.models ?? [];
      const model = models.find((option) => option.id === options.model);
      const speedPatch = codexSpeedSettings(nextCodexSpeed(
        codexSpeedOptions(model, backend.codexFastAllowed !== false, backend.launchpadOptions?.supportsFastMode),
        options,
      ));
      await this.context.host().updateNewThreadStickySettings(nextSession, speedPatch);
      await this.context.host().presentNewThreadPromptGate(
        {
          ...nextSession,
          preferences: {
            ...nextSession.preferences,
            ...speedPatch,
            updatedAt: this.context.now(),
          },
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:streaming") {
      const streamingResponses = nextMessagingStreamingResponseMode(
        nextSession.preferences?.streamingResponses ?? "inherit",
        this.context.host().streamingResponsesDefault,
      );
      // Sticky-reveal so the control stays in the gate once enabled here, and
      // carries onto the created binding.
      const streamingControlRevealed =
        nextSession.preferences?.streamingControlRevealed ||
        streamingResponses === "enabled";
      await this.context.host().presentNewThreadPromptGate(
        {
          ...nextSession,
          preferences: {
            ...nextSession.preferences,
            streamingResponses,
            ...(streamingControlRevealed
              ? { streamingControlRevealed: true }
              : {}),
            updatedAt: this.context.now(),
          },
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:working-updates") {
      const ensured = await this.context.host().ensureNewThreadProjectLaunchpad(
        nextSession,
        navigation,
        nextSession.backend,
      );
      const currentMode =
        await this.context.host().resolveNewThreadToolUpdateMode(nextSession, ensured.directory);
      await this.context.host().presentNewThreadWorkingUpdatesPicker(
        nextSession,
        event,
        currentMode,
      );
      return;
    }
    if (actionId === "browse:new:set-working-updates") {
      const toolUpdateMode = readMessagingToolUpdateModeValue(event.value);
      if (!toolUpdateMode) {
        await this.context.host().deliverInvalidBrowseSelection(event);
        return;
      }
      const updatedSession = {
        ...nextSession,
        preferences: {
          ...nextSession.preferences,
          toolUpdateMode,
          updatedAt: this.context.now(),
        },
      };
      // This is sticky only for the selected project. The backend's broad
      // sticky flag would also freeze unrelated launchpad defaults.
      await this.context.host().updateNewThreadStickySettings(
        updatedSession,
        { messagingToolUpdateMode: toolUpdateMode },
        false,
      );
      await this.context.host().presentNewThreadPromptGate(
        updatedSession,
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:backend") {
      await this.context.host().presentNewThreadBackendPicker(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:set-backend") {
      const backend = readStringValue(event.value, "backend");
      const selectedBackend = await this.context.host().resolveNewThreadBackendForSession(
        {
          launchpadBackend: navigation.launchpadDefaults.backend,
          preferredBackend: backend,
          session: nextSession,
          requirePreferred: true,
        },
        event,
      );
      if (!selectedBackend) {
        return;
      }
      const backendChanged =
        selectedBackend.kind !==
        (nextSession.backend ?? navigation.launchpadDefaults.backend);
      const updatedAt = this.context.now();
      const normalizedSession = normalizeNewThreadSessionForBackend(
        backendChanged
          ? clearNewThreadProviderPreferences(
              {
                ...nextSession,
                backend: selectedBackend.kind,
              },
              updatedAt,
            )
          : {
              ...nextSession,
              backend: selectedBackend.kind,
            },
        selectedBackend,
        updatedAt,
        navigation,
      );
      await this.context.host().updateNewThreadStickySettings(normalizedSession, {
        backend: selectedBackend.kind,
      });
      await this.context.host().presentNewThreadPromptGate(
        normalizedSession,
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:model" || actionId.startsWith("browse:new:model:")) {
      await this.context.host().presentNewThreadModelPicker(
        nextSession,
        event,
        nextSession.backend ?? navigation.launchpadDefaults.backend,
      );
      return;
    }
    if (actionId === "browse:new:set-model") {
      const model = readStringValue(event.value, "model");
      if (!model) {
        await this.context.host().deliverInvalidBrowseSelection(event);
        return;
      }
      const backend = nextSession.backend ?? navigation.launchpadDefaults.backend;
      const summary = await this.context.host().getBackendSummary(backend);
      const models = summary?.launchpadOptions?.models ?? [];
      const modelOption = models.find((candidate) => candidate.id === model);
      if (summary && !modelOption) {
        await this.context.host().deliverInvalidBrowseSelection(event);
        return;
      }
      const directory = nextSession.selectedProject
        ? directoryForProjectSelection(navigation, nextSession.selectedProject)
        : undefined;
      const launchpadSettings = applyNavigationLaunchpadProviderSettingsPatch(
        directory?.launchpad ?? navigation.launchpadDefaults,
        { backend, model },
      );
      const reasoningEffort = summary
        ? normalizeReasoningEffortForModel(summary, modelOption, [
            launchpadSettings.reasoningEffort,
            nextSession.preferences?.reasoningEffort,
          ])
        : nextSession.preferences?.reasoningEffort;
      const preferences = {
        ...nextSession.preferences,
        model,
        updatedAt: this.context.now(),
      };
      if (summary && reasoningEffort === undefined) {
        delete preferences.reasoningEffort;
      } else if (reasoningEffort !== undefined) {
        preferences.reasoningEffort = reasoningEffort;
      }
      await this.context.host().updateNewThreadStickySettings(nextSession, { model });
      await this.context.host().presentNewThreadPromptGate(
        {
          ...nextSession,
          preferences,
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:reasoning") {
      await this.context.host().presentNewThreadReasoningPicker(
        nextSession,
        event,
        nextSession.backend ?? navigation.launchpadDefaults.backend,
      );
      return;
    }
    if (actionId === "browse:new:set-reasoning") {
      const reasoningEffort = readStringValue(event.value, "reasoningEffort");
      if (!reasoningEffort) {
        await this.context.host().deliverInvalidBrowseSelection(event);
        return;
      }
      await this.context.host().updateNewThreadStickySettings(nextSession, {
        reasoningEffort,
      });
      await this.context.host().presentNewThreadPromptGate(
        {
          ...nextSession,
          preferences: {
            ...nextSession.preferences,
            reasoningEffort,
            updatedAt: this.context.now(),
          },
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:select-thread") {
      const target = selectThreadFromValue(event.value);
      if (!target) {
        await this.context.host().deliverInvalidBrowseSelection(event);
        return;
      }
      if (session.launchAction === "assign_default_agent" && target.federatedThread?.target.scope === "remote") {
        await this.context.host().deliverDefaultAgentCommandError(event,
          "Select an Agent owned by this instance for this default route.");
        return;
      }
      if (!await this.context.host().requireRemoteScope(event, target.federatedThread?.target, "resume:select:remote-instance")) return;
      const targetThread = await this.context.host().readExactNavigationThread({ ref: { backend: target.backend, threadId: target.threadId,
        ...(target.federatedThread?.target.scope === "remote" ? { ownerInstanceId: target.federatedThread.target.instanceId } : {}) },
        federationTarget: target.federatedThread?.target });
      if (session.mode === "agents" && !targetThread?.agent) {
        await this.context.host().deliverInvalidBrowseSelection(event);
        return;
      }
      if (session.launchAction === "assign_default_agent") {
        const backendSummaries = await this.context.host().loadDefaultAgentBackendSummaries();
        if (
          !session.defaultAgentScope
          || !targetThread?.agent
          || defaultAgentBackendSupport(target.backend, backendSummaries)
            !== "supported"
        ) {
          await this.context.host().deliverDefaultAgentCommandError(
            event,
            "That thread is not an eligible default Agent. Choose a Codex Agent or an ACP Agent with PwrAgent HTTP MCP tools.",
          );
          return;
        }
        const assignment: MessagingDefaultAgentAssignmentRecord = {
          id: this.context.host().newIntentId("default-agent-assignment"),
          scope: session.defaultAgentScope,
          target: {
            kind: "agent",
            backend: target.backend,
            threadId: target.threadId,
          },
          createdAt: this.context.now(),
          updatedAt: this.context.now(),
        };
        await this.context.store.upsertDefaultAgentAssignment(assignment);
        this.context.host().notifyBindingChanged("default-agent-assigned");
        await this.context.store.deleteBrowseSession(session.id);
        await this.context.host().presentDefaultAgentStatus(event, {
          notice:
            `${targetThread.title || target.threadId} is now the `
            + `${formatDefaultAgentScope(assignment.scope)} default.`,
        });
        return;
      }
      if (
        targetThread?.executionMode === "full-access" &&
        !(await this.context.host().canResumeFullAccessThreads())
      ) {
        await this.context.host().deliverFullAccessPolicyError(
          undefined,
          event,
          "Full Access threads cannot be resumed from messaging with the current settings.",
        );
        return;
      }
      // Scope: the picker hides remote threads from actors without the scope,
      // but a browse session outlives its render (it is persisted with a TTL),
      // so the selection is gated too rather than trusting the filter.
      if (
        !(await this.context.host().requireRemoteScope(
          event,
          target.federatedThread?.target,
          "resume:select:remote-instance",
        ))
      ) {
        return;
      }
      const requestedExecutionMode = session.preferences?.executionMode;
      const shouldEscalateTarget =
        requestedExecutionMode === "full-access" &&
        targetThread?.executionMode !== "full-access";
      if (shouldEscalateTarget) {
        const allowed = await this.context.host().ensureFullAccessEscalationAllowed(
          {
            backend: target.backend,
            federatedThread: target.federatedThread,
            kind: "resume-thread",
            session,
            threadId: target.threadId,
          },
          event,
        );
        if (!allowed) {
          return;
        }
      }
      const binding = await this.context.host().bindChannelToThread(event, {
        ...target,
        targetKind: session.mode === "agents" ? "agent_thread" : "thread",
      });
      const updatedBinding = session.preferences
        ? await this.context.host().updateBindingPreferences(binding, session.preferences)
        : binding;
      if (shouldEscalateTarget) {
        await this.context.backend.setThreadExecutionMode?.({
          backend: target.backend,
          federationTarget: target.federatedThread?.target,
          threadId: target.threadId,
          executionMode: "full-access",
        });
      }
      await this.context.store.deleteBrowseSession(session.id);
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("bound"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: this.context.now(),
          delivery: session.surface
            ? {
                mode: "update",
                replaceMarkup: true,
              }
            : undefined,
          title: "Thread bound",
          body: boundThreadConfirmationBody(
            updatedBinding,
            this.context.capabilityProfile,
          ),
          fallbackText: boundThreadFallbackText(
            updatedBinding,
            this.context.capabilityProfile,
          ),
          targetSurface: session.surface,
        }),
        undefined,
        event,
      );
      await this.context.host().renderBindingStatus(updatedBinding, event);
      await this.context.host().repostLastAssistantMessageForResume(updatedBinding);
      return;
    }

    await this.context.host().deliverInvalidBrowseSelection(event);
  }

  private async findBrowseSessionForCallback(
    event: MessagingInboundCallbackEvent,
  ): Promise<MessagingBrowseSessionRecord | undefined> {
    const callbackHandle = await this.resolveCallbackHandleForEvent(event);
    if (callbackHandle?.browseSessionId) {
      return await this.context.store.getBrowseSession(callbackHandle.browseSessionId, {
        now: this.context.now(),
      });
    }
    if (callbackHandle) {
      return undefined;
    }

    return await this.context.store.findActiveBrowseSessionForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.context.now(),
    });
  }

  private async resolveCallbackHandleForEvent(
    event: MessagingInboundCallbackEvent,
  ): Promise<MessagingCallbackHandleRecord | undefined> {
    return await this.context.store.resolveCallbackHandle({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      handle: event.interaction.id,
      now: this.context.now(),
    });
  }

  private async handleMonitorCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    if (actionId === "monitor:topics" || actionId.startsWith("monitor:topics:")) {
      await this.handleMonitorTopicCallback(event, actionId);
      return;
    }
    if (actionId === "monitor:stop") {
      await this.context.host().stopMonitoringForChannel(event);
      return;
    }

    await this.context.host().enableAndRenderChannelMonitor(event, normalizeMonitorCallbackAction(actionId));
  }

  private async handleMonitorTopicCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    if (actionId === "monitor:topics:cleanup") {
      await this.context.host().commandHandlers.handleMonitorTopicCommand(
        {
          ...event,
          kind: "command",
          command: "monitor",
          args: ["topics", "cleanup"],
          rawText: "/monitor topics cleanup",
        },
        { kind: "topics-cleanup" },
      );
      return;
    }
    if (actionId === "monitor:topics:fanout") {
      await this.context.host().commandHandlers.handleMonitorTopicCommand(
        {
          ...event,
          kind: "command",
          command: "monitor",
          args: ["topics", "fanout"],
          rawText: "/monitor topics fanout",
        },
        { kind: "topics-fanout" },
      );
      return;
    }
    const approvePrefix = "monitor:topics:approve:";
    if (!actionId.startsWith(approvePrefix)) {
      await this.context.host().commandHandlers.handleMonitorTopicCommand(
        {
          ...event,
          kind: "command",
          command: "monitor",
          args: ["topics"],
          rawText: "/monitor topics",
        },
        { kind: "topics-adopt" },
      );
      return;
    }

    const approvalKey = actionId.slice(approvePrefix.length);
    const separatorIndex = approvalKey.lastIndexOf(":");
    const proposalId = separatorIndex > 0 ? approvalKey.slice(0, separatorIndex) : "";
    const itemId = separatorIndex > 0 ? approvalKey.slice(separatorIndex + 1) : "";
    if (!proposalId || !itemId) {
      await this.context.host().deliverInvalidTopicApproval(event);
      return;
    }
    const proposal = await this.context.store.getTopicCleanupProposal(proposalId);
    const item = proposal?.items.find((candidate) => candidate.id === itemId);
    if (!proposal || proposal.status !== "pending" || !item) {
      await this.context.host().deliverInvalidTopicApproval(event);
      return;
    }

    const topic = await this.context.store.getManagedTopic(item.topicRecordId);
    if (!topic) {
      await this.context.host().deliverInvalidTopicApproval(event);
      return;
    }

    let result: MessagingManagedConversationActionResult | undefined;
    if (item.action === "close") {
      result = await this.context.adapter.closeManagedConversation?.({
        actor: event.actor,
        channel: topicChannelRef(topic),
        routingState: topic.routingState,
      });
    } else if (item.action === "delete") {
      result = await this.context.adapter.deleteManagedConversation?.({
        actor: event.actor,
        channel: topicChannelRef(topic),
        routingState: topic.routingState,
      });
    }
    const now = this.context.now();
    if (!result || result.outcome !== "updated") {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("topics-approval-failed"),
          createdAt: now,
          title: "Topic action failed",
          body: result?.errorMessage ?? "The Telegram adapter could not apply that topic action.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    await this.context.store.upsertManagedTopic({
      ...topic,
      closedAt: item.action === "close" ? now : topic.closedAt,
      deletedAt: item.action === "delete" ? now : topic.deletedAt,
      lifecycle: item.action === "delete" ? "deleted" : "closed",
      recommendation: item.action,
      updatedAt: now,
    });
    await this.context.store.upsertTopicCleanupProposal({
      ...proposal,
      appliedAt: now,
      status: "applied",
      updatedAt: now,
    });
    await this.context.host().deliver(
      buildConfirmationIntent({
        id: this.context.host().newIntentId("topics-action-applied"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: now,
        title: "Topic action applied",
        body: `${item.action === "delete" ? "Deleted" : "Closed"} ${topic.title ?? topic.topicId}.`,
        actions: [],
      }),
      undefined,
      event,
    );
  }

  async handleStatusCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    // RBAC top-guard: every status/handoff action maps to a permission through
    // the shared lookup table, so one check covers every mutation method below
    // without touching each individually. Unmapped actions (skills sub-nav)
    // fall through ungated. The full-access double-gate is enforced deeper, at
    // ensureFullAccessEscalationAllowed / ensureAcpRuntimeModeAllowed.
    const requiredPermission = permissionForActionId(actionId);
    if (
      requiredPermission &&
      !(await this.context.host().requirePermission(event, requiredPermission, actionId))
    ) {
      if (
        actionId === "status:stop"
        && readStringValue(event.value, "source") === "agent_session_stopped"
      ) {
        const binding = await this.context.store.findActiveBindingForChannel(
          event.channel,
        );
        const activeTurn = binding ? this.context.host().getActiveTurn(binding) : undefined;
        if (binding && activeTurn) {
          await this.context.host().signalTurnActivity(binding, activeTurn, {
            force: true,
            reason: "agent_session_stop_denied",
          });
        }
      }
      return;
    }
    // Detach is exempt: it removes the LOCAL binding record and never touches
    // the peer. Gating it would strand an actor whose scope was revoked while
    // bound to a remote thread — unable to act, and unable to let go either.
    if (actionId === "status:detach") {
      await this.context.host().detachBinding(event);
      return;
    }

    const binding = await this.context.store.findActiveBindingForChannel(event.channel);
    // Scope gate: a binding created while the actor still had remote scope (or
    // by an operator) must not stay drivable after the scope is revoked.
    if (
      !(await this.context.host().requireRemoteScopeForBinding(
        event,
        binding,
        `${actionId}:remote-instance`,
      ))
    ) {
      return;
    }
    if (!binding) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("status-expired"),
          createdAt: this.context.now(),
          title: "Action expired",
          body: "That status action is no longer available. Use /status to refresh.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }
    this.context.host().rememberHumanMessagingSource(binding, event);

    if (actionId === "status:refresh" || actionId === "handoff:back-to-status") {
      if (
        actionId === "status:refresh" &&
        await this.context.host().dismissActiveSkillsWorkflow(binding, event)
      ) {
        return;
      }
      // "Back" buttons from handoff sub-flows resolve to a status card
      // refresh, same as an explicit Refresh tap.
      await this.context.host().clearActiveBindingSubmodeIntent(event, binding);
      await this.context.host().renderBindingStatus(binding, event);
      return;
    }
    if (actionId === "status:skills") {
      await this.context.host().presentSkillsBrowser(binding, event);
      return;
    }
    if (actionId === "skills:next" || actionId === "skills:previous") {
      const page = skillsBrowserPageFromValue(event.value);
      await this.context.host().presentSkillsBrowser(binding, event, page);
      return;
    }
    if (actionId === "skills:search") {
      await this.context.host().presentSkillsSearchPrompt(binding, event);
      return;
    }
    if (actionId === "skills:cancel" || actionId === "skills:search:cancel") {
      await this.context.host().dismissActiveSkillsWorkflow(binding, event, {
        allowCallbackFallback: true,
      });
      return;
    }
    if (actionId === "skills:select") {
      await this.context.host().selectPendingSkill(binding, event);
      return;
    }
    if (actionId === "skills:remove") {
      await this.context.host().removePendingSkill(binding, event);
      return;
    }
    if (actionId === "status:handoff") {
      await this.context.host().presentHandoffOverview(binding, event);
      return;
    }
    if (actionId === "handoff:projects") {
      await this.context.host().presentHandoffProjectPicker(binding, event);
      return;
    }
    if (actionId === "handoff:select-project") {
      await this.context.host().presentHandoffConfirmation(binding, event);
      return;
    }
    if (actionId === "handoff:cancel") {
      await this.context.host().clearActiveHandoffIntent(event);
      await this.context.host().renderBindingStatus(binding, event);
      return;
    }
    if (actionId === "handoff:move-branch" || actionId === "handoff:local-to-worktree") {
      await this.context.host().presentHandoffBranchPicker(binding, event);
      return;
    }
    if (actionId === "handoff:create-detached") {
      await this.context.host().presentHandoffConfirmation(binding, event);
      return;
    }
    if (
      actionId === "handoff:branches:next" ||
      actionId === "handoff:branches:previous"
    ) {
      await this.context.host().presentHandoffBranchPicker(
        binding,
        event,
        branchPageIndexFromValue(event.value),
      );
      return;
    }
    if (actionId === "handoff:worktree-to-local" || actionId === "handoff:worktree-to-worktree") {
      await this.context.host().presentHandoffConfirmation(binding, event);
      return;
    }
    if (actionId === "handoff:select-leave-branch") {
      await this.context.host().presentHandoffConfirmation(binding, event);
      return;
    }
    if (actionId === "handoff:confirm") {
      await this.context.host().executeHandoff(binding, event);
      return;
    }
    if (actionId === "status:model" || actionId.startsWith("status:model:")) {
      await this.context.host().presentModelPicker(binding, event);
      return;
    }
    if (actionId === "status:reasoning") {
      await this.context.host().presentReasoningPicker(binding, event);
      return;
    }
    if (actionId === "status:runtime-mode") {
      await this.context.host().presentStatusAcpRuntimeModePicker(binding, event);
      return;
    }
    if (actionId === "status:set-model") {
      await this.context.host().setBindingModel(binding, event);
      return;
    }
    if (actionId === "status:set-reasoning") {
      await this.context.host().setBindingReasoning(binding, event);
      return;
    }
    if (actionId === "status:set-runtime-mode") {
      await this.context.host().setBindingAcpRuntimeMode(binding, event);
      return;
    }
    if (actionId === "status:set-permissions") {
      await this.context.host().setBindingPermissionsMode(binding, event);
      return;
    }
    if (actionId === "status:set-tool-updates") {
      await this.context.host().setToolUpdateMode(binding, event);
      return;
    }
    if (actionId === "status:set-response-mode") {
      await this.context.host().setBindingResponseMode(binding, event);
      return;
    }
    if (actionId === "status:fast") {
      await this.context.host().toggleFastMode(binding, event);
      return;
    }
    if (actionId === "status:permissions") {
      if (isAcpBackendId(binding.backend)) {
        const summary = await this.context.host().getBackendSummary(
          binding.backend,
          federationTargetForBinding(binding),
        );
        const navigation: MessagingThreadContext = { kind: "thread", thread: await this.context.host().readBoundNavigationThread(binding) };
        const thread = findThreadForBinding(navigation, binding);
        const runtimeMode = buildMessagingAcpRuntimeModeSummary({
          backend: summary,
          runtime: thread?.acpRuntime ?? binding.preferences?.acpRuntime,
        });
        if (
          !acpBackendUsesExecutionModePermissions(summary)
          && runtimeMode.choices.length > 0
        ) {
          await this.context.host().presentStatusAcpRuntimeModePicker(binding, event);
        } else {
          await this.context.host().presentPermissionsPicker(binding, event);
        }
      } else {
        await this.context.host().presentPermissionsPicker(binding, event);
      }
      return;
    }
    if (actionId === "status:tool-updates") {
      await this.context.host().presentToolUpdateModePicker(binding, event);
      return;
    }
    if (actionId === "status:response-mode") {
      await this.context.host().presentResponseModePicker(binding, event);
      return;
    }
    if (actionId === "status:streaming") {
      await this.context.host().cycleStreamingResponseMode(binding, event);
      return;
    }
    if (actionId === "status:stop") {
      await this.context.host().stopActiveTurn(binding, event);
      return;
    }
    if (actionId === "status:compact") {
      await this.context.host().compactThread(binding, event);
      return;
    }
    if (actionId === "status:lock") {
      await this.context.host().toggleThreadLock(binding, event);
      return;
    }
    if (actionId === "status:sync-name") {
      await this.context.host().syncConversationName(binding, event);
      return;
    }

    await this.context.host().deliver(
      buildConfirmationIntent({
        id: this.context.host().newIntentId("status-action-pending"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        title: "Status action unavailable",
        body: "Use /status to refresh. This control will be wired to backend actions in the next implementation slice.",
      }),
      binding,
    );
  }

  private async handleFullAccessRiskCallback(
    event: MessagingInboundCallbackEvent,
    action: "accept" | "dismiss" | "cancel",
  ): Promise<void> {
    const context = readFullAccessRiskContext(event.value);
    if (!context) {
      await this.context.host().deliverInvalidStatusSelection(event);
      return;
    }
    if (action === "cancel") {
      if (context.kind === "new-thread" || context.kind === "resume-thread") {
        const session = await this.context.store.getBrowseSession(context.sessionId, {
          now: this.context.now(),
        });
        if (!session) {
          await this.context.host().deliverStaleFullAccessWarning(event);
          return;
        }
        if (context.kind === "new-thread") {
          this.context.host().pendingFullAccessNewThreadPrompts.delete(session.id);
        }
        const navigation = await readMessagingLaunchpadContext({ backend: this.context.backend, project: session.selectedProject });
        if (context.kind === "new-thread") {
          await this.context.host().presentNewThreadPromptGate(
            this.context.host().withNewThreadPromptCaptureExpiry(session),
            event,
            navigation,
          );
        } else {
          await this.context.host().renderResumeBrowser(session, navigation, event);
        }
        return;
      }
      const binding = await this.context.store.getBinding(context.bindingId);
      if (!binding) {
        await this.context.host().deliverInvalidStatusSelection(event);
        return;
      }
      if (binding.statusSurface || binding.pinnedStatusSurface) {
        await this.context.host().clearActiveBindingSubmodeIntent(event, binding);
        await this.context.host().renderBindingStatus(binding, event);
        return;
      }
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("full-access-risk-cancelled"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: this.context.now(),
          title: "Full Access cancelled",
          body: "No Full Access change was made.",
        }),
        undefined,
        event,
      );
      return;
    }

    const escalationContext =
      await this.resolveFullAccessRiskCallbackContext(context, event);
    if (!escalationContext) {
      return;
    }
    if (!(await this.ensureFullAccessRiskCallbackAllowed(escalationContext, event))) {
      return;
    }

    if (action === "dismiss") {
      const controls = await this.context.host().resolveFullAccessControls();
      const warning = await this.context.host().resolveFullAccessWarning(controls, event);
      if (warning.canDismiss) {
        await controls.dismissWarning?.({
          actorId: event.actor.platformUserId,
          channel: event.channel.channel,
        });
      }
    }

    if (escalationContext.kind === "new-thread") {
      const { session } = escalationContext;
      const acceptedSession = {
        ...session,
        fullAccessRiskAcceptedAt: this.context.now(),
        preferences: {
          ...session.preferences,
          executionMode: "full-access" as const,
          permissionsMode: "full-access" as const,
          updatedAt: this.context.now(),
        },
      };
      const pendingPrompt = this.context.host().pendingFullAccessNewThreadPrompts.get(session.id);
      if (escalationContext.pendingPrompt && !pendingPrompt) {
        await this.context.host().deliverMissingFullAccessPrompt(event);
        return;
      }
      if (pendingPrompt) {
        try {
          await this.context.host().createNewThreadFromPromptBundle({
            events: pendingPrompt.events,
            session: acceptedSession,
          });
        } catch (error) {
          this.context.logger.warn?.("messaging new-thread prompt failed", {
            channel: pendingPrompt.session.channel.channel,
            error: error instanceof Error ? error.message : String(error),
            sessionId: pendingPrompt.session.id,
          });
          await this.context.host().deliverNewThreadPromptFailure(
            {
              events: pendingPrompt.events,
              session: acceptedSession,
            },
            error,
          );
        }
        return;
      }
      await this.context.host().presentNewThreadPromptGate(acceptedSession, event);
      return;
    }

    if (escalationContext.kind === "resume-thread") {
      const { session } = escalationContext;
      const target = {
        backend: escalationContext.backend,
        federatedThread: escalationContext.federatedThread,
        threadId: escalationContext.threadId,
      };
      const binding = await this.context.host().bindChannelToThread(event, target);
      const preferences = {
        ...session.preferences,
        executionMode: "full-access" as const,
        permissionsMode: "full-access" as const,
        updatedAt: this.context.now(),
      };
      const updatedBinding = await this.context.host().updateBindingPreferences(binding, preferences);
      await this.context.backend.setThreadExecutionMode?.({
        backend: escalationContext.backend,
        federationTarget: escalationContext.federatedThread?.target,
        threadId: escalationContext.threadId,
        executionMode: "full-access",
      });
      await this.context.store.deleteBrowseSession(session.id);
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("bound"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: this.context.now(),
          delivery: session.surface
            ? {
                mode: "update",
                replaceMarkup: true,
              }
            : undefined,
          title: "Thread bound",
          body: "Messages in this conversation will route to the selected thread.",
          fallbackText: "Send a message to continue the thread.",
          targetSurface: session.surface,
        }),
        undefined,
        event,
      );
      await this.context.host().renderBindingStatus(updatedBinding, event);
      await this.context.host().repostLastAssistantMessageForResume(updatedBinding);
      return;
    }

    const { binding } = escalationContext;
    if (!binding) {
      await this.context.host().deliverInvalidStatusSelection(event);
      return;
    }
    await this.context.host().updateBindingPreferences(binding, {
      executionMode: "full-access",
      permissionsMode: "full-access",
    });
    await this.context.host().clearActiveBindingSubmodeIntent(event, binding);
    await this.context.backend.setThreadExecutionMode?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: escalationContext.threadId,
      executionMode: "full-access",
    });
  }

  private async handleAcpRuntimeRiskCallback(
    event: MessagingInboundCallbackEvent,
    action: "accept" | "dismiss" | "cancel",
  ): Promise<void> {
    const context = readAcpRuntimeRiskContext(event.value);
    if (!context) {
      await this.context.host().deliverInvalidStatusSelection(event);
      return;
    }

    if (action === "cancel") {
      if (context.kind === "new-thread") {
        const session = await this.context.store.getBrowseSession(context.sessionId, {
          now: this.context.now(),
        });
        if (!session) {
          await this.context.host().deliverStaleFullAccessWarning(event);
          return;
        }
        const navigation = await readMessagingLaunchpadContext({ backend: this.context.backend, project: session.selectedProject });
        await this.context.host().presentNewThreadPromptGate(session, event, navigation);
        return;
      }
      const binding = await this.context.store.getBinding(context.bindingId);
      if (!binding) {
        await this.context.host().deliverInvalidStatusSelection(event);
        return;
      }
      await this.context.host().renderBindingStatus(binding, event);
      return;
    }

    if (!(await this.ensureAcpRuntimeRiskCallbackAllowed(context, event))) {
      return;
    }
    if (action === "dismiss") {
      const controls = await this.context.host().resolveFullAccessControls();
      const warning = await this.context.host().resolveFullAccessWarning(controls, event);
      if (warning.canDismiss) {
        await controls.dismissWarning?.({
          actorId: event.actor.platformUserId,
          channel: event.channel.channel,
        });
      }
    }

    if (context.kind === "new-thread") {
      const session = await this.context.store.getBrowseSession(context.sessionId, {
        now: this.context.now(),
      });
      if (!session) {
        await this.context.host().deliverStaleFullAccessWarning(event);
        return;
      }
      const navigation = await readMessagingLaunchpadContext({ backend: this.context.backend, project: session.selectedProject });
      await this.context.host().applyNewThreadAcpRuntimeMode(session, event, navigation, context);
      return;
    }

    const binding = await this.context.store.getBinding(context.bindingId);
    if (!binding) {
      await this.context.host().deliverInvalidStatusSelection(event);
      return;
    }
    await this.context.host().applyBindingAcpRuntimeMode(binding, event, context);
  }

  private async ensureAcpRuntimeRiskCallbackAllowed(
    context: AcpRuntimeRiskWarningContext,
    event: MessagingInboundEvent,
  ): Promise<boolean> {
    const controls = await this.context.host().resolveFullAccessControls();
    if (controls.allowEscalation) {
      return true;
    }
    await this.context.host().deliverFullAccessPolicyError(
      context.kind === "thread"
        ? await this.context.store.getBinding(context.bindingId)
        : undefined,
      event,
        `Permissions mode ${context.label} is disabled from messaging by Full Access settings.`,
    );
    return false;
  }

  private async resolveFullAccessRiskCallbackContext(
    context: FullAccessRiskWarningContext,
    event: MessagingInboundEvent,
  ): Promise<FullAccessEscalationContext | undefined> {
    if (context.kind === "new-thread") {
      const session = await this.context.store.getBrowseSession(context.sessionId, {
        now: this.context.now(),
      });
      if (!session) {
        await this.context.host().deliverStaleFullAccessWarning(event);
        return undefined;
      }
      return {
        kind: "new-thread",
        pendingPrompt: context.pendingPrompt,
        session,
      };
    }

    if (context.kind === "resume-thread") {
      const session = await this.context.store.getBrowseSession(context.sessionId, {
        now: this.context.now(),
      });
      if (!session) {
        await this.context.host().deliverStaleFullAccessWarning(event);
        return undefined;
      }
      return {
        backend: context.backend,
        ...(context.federationInstanceId
          ? {
              federatedThread: buildFederatedThreadRef({
                backend: context.backend,
                instanceId: context.federationInstanceId,
                threadId: context.threadId,
              }),
            }
          : {}),
        kind: "resume-thread",
        session,
        threadId: context.threadId,
      };
    }

    const binding = await this.context.store.getBinding(context.bindingId);
    if (!binding) {
      await this.context.host().deliverInvalidStatusSelection(event);
      return undefined;
    }
    return {
      backend: binding.backend,
      binding,
      kind: "thread",
      threadId: context.threadId,
    };
  }

  private async ensureFullAccessRiskCallbackAllowed(
    context: FullAccessEscalationContext,
    event: MessagingInboundEvent,
  ): Promise<boolean> {
    const controls = await this.context.host().resolveFullAccessControls();
    if (!controls.allowEscalation) {
      await this.context.host().recordFullAccessPolicyViolation(context, event);
      await this.context.host().deliverFullAccessPolicyError(
        context.kind === "thread" ? context.binding : undefined,
        event,
        "Escalating to Full Access from messaging is disabled in Settings.",
      );
      return false;
    }
    return true;
  }

  /**
   * Handle a tap on the Cancel button of a queued-permissions audit
   * message. The actionId is `permissions:queue:cancel:${queueId}`; we
   * validate that the queueId still matches the active tracking entry
   * before calling the bridge.
   *
   * Stale-click feedback (mirroring `handleQueuedTurnCallback`'s
   * "queued message no longer waiting" pattern): if the queue this
   * button references has already been applied or cancelled, OR a
   * different queue has replaced it, we post an explicit "no longer
   * waiting" reply instead of silently routing through the registry's
   * idempotent no-op. This is the same UX contract queued reply
   * messages have used since `2026-05-03-001-fix-messaging-turn-admission-plan.md`.
   *
   * The visual button SHOULD have been removed by the
   * `handleExecutionModeQueueCleared` edit when the queue resolved,
   * but Telegram/Discord chat history can still show stale buttons
   * (the user scrolled up; the edit failed; the tab was offline at
   * the time of the edit; etc.) — we treat the click as the
   * authoritative "user wants to interact with this queue" signal
   * and respond with the truth at click time.
   */
  private async handlePermissionsQueueCancelCallback(
    event: MessagingInboundCallbackEvent,
    queueId: string,
  ): Promise<void> {
    const binding = await this.context.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      return;
    }

    const queueKey = this.context.host().queueAuditKey(binding.backend, binding.threadId);
    const tracking = this.context.host().pendingQueueAuditMessages.get(queueKey);
    const isStale = !tracking || tracking.queueId !== queueId;
    if (isStale) {
      try {
        await this.context.host().deliver(
          buildErrorIntent({
            id: this.context.host().newIntentId("expired-permissions-queue"),
            createdAt: this.context.now(),
            title: "Permissions change unavailable",
            body: "That queued permissions change is no longer waiting.",
            recoverable: true,
          }),
          binding,
          event,
        );
      } catch (error) {
        this.context.logger.debug?.(
          "messaging permissions-queue stale-cancel notice failed",
          {
            bindingId: binding.id,
            threadId: binding.threadId,
            queueId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return;
    }

    if (!this.context.backend.cancelThreadExecutionModeQueue) {
      return;
    }
    try {
      await this.context.backend.cancelThreadExecutionModeQueue({
        backend: binding.backend,
        federationTarget: federationTargetForBinding(binding),
        threadId: binding.threadId,
      });
    } catch (error) {
      this.context.logger.debug?.("messaging permissions-queue cancel failed", {
        bindingId: binding.id,
        threadId: binding.threadId,
        queueId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async retireApprovalCallbackIfBackendIdle(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<boolean> {
    const persistedBinding = pendingIntent.bindingId
      ? await this.context.store.getBinding(pendingIntent.bindingId)
      : undefined;
    const origin = this.context.host().agentMessagingOriginForPendingIntent(pendingIntent);
    const binding = persistedBinding ?? origin?.deliveryBinding ?? origin?.binding;
    const turnId = pendingIntent.intent.requestContext?.turnId;
    if (!binding || binding.revokedAt || !turnId) {
      return false;
    }

    const threadStatus = await this.context.host().readBackendThreadStatus(binding);
    if (threadStatus !== "idle") {
      return false;
    }

    await this.context.host().reconcileActiveTurnFromBackendStatus(
      binding,
      "pending_request.submitted",
    );
    await this.context.store.deletePendingIntent(pendingIntent.id);
    await this.context.host().retireApprovalIntent(pendingIntent, event, "Resolved");
    return true;
  }

  private async handlePrivateReplyCallback(
    event: MessagingInboundCallbackEvent,
    action: PrivateReplyAction,
  ): Promise<void> {
    if (this.context.host().privateReplyClaims.has(action.requestId)) {
      if (action.kind === "cancel") {
        await this.context.host().deliverPrivateReplyButtonState(
          event,
          "This request already has a response or has been closed. Cancellation is no longer available.",
        );
      }
      return;
    }
    const binding = (await this.context.store.findActiveBindings()).find((candidate) =>
      candidate.privateReplyContinuation?.requestId === action.requestId
    );
    const continuation = binding?.privateReplyContinuation;
    if (
      !binding
      || !continuation
      || continuation.expiresAt <= this.context.now()
      || !binding.authorizedActorIds.includes(event.actor.platformUserId)
      || binding.channel.channel !== event.channel.channel
      || binding.channel.conversation.id !== event.channel.conversation.id
      || (
        continuation.requestSurface
        && event.sourceSurface
        && continuation.requestSurface.id !== event.sourceSurface.id
      )
    ) {
      await this.context.host().deliverPrivateReplyButtonState(event, "This private request is no longer available.");
      return;
    }

    if (action.kind === "cancel") {
      // Binding lookup yielded: a typed reply or another button may have won.
      const replyClaim = this.context.host().privateReplyClaims.claim(action.requestId);
      if (!replyClaim) {
        await this.context.host().deliverPrivateReplyButtonState(
          event,
          "This request already has a response or has been closed. Cancellation is no longer available.",
        );
        return;
      }
      try {
        await this.context.host().completePrivateReplyContinuation(binding.id);
        this.context.host().privateReplyClaims.complete(replyClaim);
      } catch (error) {
        this.context.host().privateReplyClaims.release(replyClaim);
        throw error;
      }
      await this.context.host().deliverPrivateReplyButtonState(
        event,
        "Private request cancelled. The Agent will not resume from this request.",
      );
      return;
    }

    const option = continuation.replyOptions?.[action.optionIndex];
    if (!option) {
      await this.context.host().deliverPrivateReplyButtonState(event, "This private reply option is no longer available.");
      return;
    }
    if (
      !(await this.context.host().requirePermission(event, "message.reply", "private-reply:button", { notify: false }))
      || !(await this.context.host().requireRemoteScopeForBinding(
        event,
        binding,
        "private-reply:button:remote-instance",
        { notify: false },
      ))
    ) {
      return;
    }

    const responseEvent: MessagingInboundTextEvent = {
      ...event,
      id: `${event.id}:private-reply:${action.optionIndex}`,
      kind: "text",
      channel: binding.channel,
      routingState: binding.routingState,
      receivedAt: this.context.now(),
      text: option.text,
    };
    // Admission rechecks and acquires the claim after asynchronous validation.
    if (!(await this.context.host().admitTurnInput({ binding, event: responseEvent }))) return;
    await this.context.host().deliverPrivateReplyButtonState(
      event,
      "Response received. The Agent will continue in the original conversation.",
    );
  }
}
