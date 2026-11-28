import { federationTargetForBinding } from "./messaging-backend-event-helpers";
import { permissionForCommandVerb } from "@pwragent/shared/contracts/rbac";
import type { MessagingBindingRecord, MessagingInboundCallbackEvent, MessagingInboundCommandEvent, MessagingInboundEvent, MessagingSurfaceRef } from "@pwragent/messaging-interface";
import { buildHelpActions, formatMessagingCommandHelpBody, matchMessagingCommandVerb, MESSAGING_COMMAND_CATALOG, MESSAGING_HELP_ACTION_COMMANDS, MESSAGING_REVIEW_HELP_SPEC, paginateHelpCatalog } from "./messaging-command-catalog.js";
import { buildConfirmationIntent, buildErrorIntent } from "./messaging-renderer.js";
import { isBareClaudeCodeReviewCommand, parseReviewCommand } from "../../../shared/review-command.js";
import { parseMessagingSchedule, resolveScheduledAction, scheduledActionDisplayId } from "./messaging-scheduled-actions.js";
import { messageOriginForInboundEvent, scheduledActionFailureMessage, parseDefaultAgentScopeKind, normalizeMonitorCommandAction, type MonitorCommandAction, readStringValue } from "./messaging-command-helpers";
import type { MessagingCommandContext } from "./messaging-command-context";

export class MessagingCommandHandlers {
  constructor(private readonly context: MessagingCommandContext) {}

  async handleCommand(
    event: MessagingInboundCommandEvent,
    options?: {
      targetSurface?: MessagingSurfaceRef;
    },
  ): Promise<void> {
    const verb = matchMessagingCommandVerb(event.command)
      ?? (event.command.trim().replace(/^\/+/, "").toLowerCase() === "review" ? "review" : undefined);
    // RBAC: gate the verb before dispatching. `help` and unknown commands are
    // ungated (they only surface the command list). `permissionForCommandVerb`
    // is the same lookup the render-time button filter uses, so they can't drift.
    // This stays ABOVE every verb branch so a newly added command cannot slip
    // in below the gate.
    if (verb) {
      const permission = permissionForCommandVerb(verb);
      if (
        permission &&
        !(await this.context.host().requirePermission(event, permission, `command:${verb}`))
      ) {
        return;
      }
      // Scope gate: a command against a conversation already bound to a peer's
      // thread drives that peer. Exempt: `resume`/`agent` only open the picker
      // (which filters, and the bind is gated at bind time), and `detach` is a
      // local unbind that must stay available or a scope-revoked actor is
      // stranded in a conversation they can neither use nor leave. Review
      // checks peer scope in the PR path, which routes to the bound owner.
      if (
        verb !== "resume" &&
        verb !== "agent" &&
        verb !== "detach" &&
        verb !== "review" &&
        !(await this.context.host().requireRemoteScopeForBinding(
          event,
          await this.context.store.findActiveBindingForChannel(event.channel),
          `command:${verb}:remote-instance`,
        ))
      ) {
        return;
      }
    }
    if (verb === "schedule") {
      await this.handleScheduleCommand(event);
      return;
    }
    if (verb === "scheduled") {
      await this.handleScheduledCommand(event);
      return;
    }
    if (verb === "continue") {
      await this.continueClaudeThreadInNewSession(event);
      return;
    }
    if (verb === "status") {
      if (event.args[0]?.toLowerCase() === "handoff") {
        await this.context.host().handleStatusCallback({
          ...event, kind: "callback",
          interaction: { channel: event.channel.channel, id: event.id },
          actionId: "status:handoff",
        }, "status:handoff");
        return;
      }
      await this.context.host().presentStatus(event);
      return;
    }
    if (verb === "detach") {
      await this.context.host().detachBinding(event);
      return;
    }
    if (verb === "monitor") {
      await this.handleMonitorCommand(event);
      return;
    }
    if (verb === "resume") {
      await this.context.host().presentResumeBrowser(event, {
        cancelDestination: options?.targetSurface ? "help" : undefined,
        targetSurface: options?.targetSurface,
      });
      return;
    }
    if (verb === "agent") {
      if (event.args[0]?.toLowerCase() === "default") {
        await this.handleDefaultAgentCommand(event);
        return;
      }
      await this.context.host().presentAgentBrowser(event, {
        cancelDestination: options?.targetSurface ? "help" : undefined,
        targetSurface: options?.targetSurface,
      });
      return;
    }
    if (verb === "new") {
      await this.context.host().presentResumeBrowser(
        {
          ...event,
          command: "resume",
          args: ["--new", ...event.args],
          rawText: ["/resume", "--new", ...event.args].join(" "),
        },
        {
          cancelDestination: options?.targetSurface ? "help" : undefined,
          targetSurface: options?.targetSurface,
        },
      );
      return;
    }
    if (verb === "help") {
      await this.presentHelp(event, {
        targetSurface: options?.targetSurface,
      });
      return;
    }
    if (verb === "review") {
      await this.handleReviewCommand(event);
      return;
    }
    const binding = await this.context.store.findActiveBindingForChannel(event.channel);
    if (await this.handleBareCodeReviewCommand(event, binding)) {
      return;
    }
    await this.routeUnknownCommandToBoundThread(event, binding);
  }

  /**
   * A bare `/code-review` on a thread that reviews as Claude Code starts the
   * same tracked review of the current changes that `/review` and the desktop
   * panel start: a review card, Auto-fix, and the requesting contact's
   * permissions. Anywhere else, and with arguments, it is the agent's own
   * command and goes to the thread as typed. Returns false to pass it on.
   */
  private async handleBareCodeReviewCommand(
    event: MessagingInboundCommandEvent,
    binding: MessagingBindingRecord | undefined,
  ): Promise<boolean> {
    if (!isBareClaudeCodeReviewCommand(`/${event.command.replace(/^\/+/, "")} ${event.args.join(" ")}`)) {
      return false;
    }
    if (!binding || !await this.context.host().claudeCodeReviewSupportedForBinding(binding)) {
      return false;
    }
    // In a shared conversation, a command not addressed to PwrAgent is
    // ignored here exactly as it is when it goes to the thread as typed.
    if (
      binding.targetKind === "agent_thread"
      && !await this.context.host().shouldHandleAmbientSharedMessage({ ...event, kind: "text", text: event.rawText }, binding)
    ) {
      return true;
    }
    const permission = permissionForCommandVerb("review");
    if (permission && !await this.context.host().requirePermission(event, permission, "command:code-review")) {
      return true;
    }
    if (federationTargetForBinding(binding) && !await this.context.host().requireRemoteScopeForBinding(
      event, binding, "review:remote-instance",
    )) {
      return true;
    }
    await this.context.host().submitMessagingReview({
      binding,
      event,
      runMode: "claude-code-review",
      target: { type: "uncommittedChanges" },
      // A typed `/code-review` sends just that; `--fix` is the operator's to add.
      afterReview: "wait",
    });
    return true;
  }

  private async handleScheduleCommand(
    event: MessagingInboundCommandEvent,
  ): Promise<void> {
    const binding = await this.context.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.presentThreadCommandNeedsBinding(event);
      return;
    }
    if (!this.context.backend.createScheduledThreadAction) {
      await this.deliverScheduledActionError(
        binding,
        event,
        "Scheduled messages are unavailable.",
      );
      return;
    }
    const parsed = parseMessagingSchedule(event.args, this.context.now());
    if (!parsed.ok) {
      await this.deliverScheduledActionError(binding, event, parsed.error);
      return;
    }
    const response = await this.context.backend.createScheduledThreadAction({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      kind: "turn",
      origin: "messaging",
      scheduledFor: parsed.scheduledFor,
      displayText: parsed.text,
      turn: {
        input: [{ type: "text", text: parsed.text }],
        messageOrigin: messageOriginForInboundEvent(event, this.context.host().rememberHumanMessagingSource(binding, event)?.ref),
      },
    });
    const failureMessage = scheduledActionFailureMessage(response.action);
    if (failureMessage) {
      await this.deliverScheduledActionError(binding, event, failureMessage);
      return;
    }
    await this.context.host().deliver(
      buildConfirmationIntent({
        id: this.context.host().newIntentId("scheduled-message-created"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        title: "Message scheduled",
        body: [
          `ID: ${scheduledActionDisplayId(response.action.id)}`,
          `Sends: ${new Date(response.action.scheduledFor).toISOString()}`,
          "",
          response.action.displayText,
        ].join("\n"),
      }),
      binding,
      event,
    );
  }

  private async handleScheduledCommand(
    event: MessagingInboundCommandEvent,
  ): Promise<void> {
    const binding = await this.context.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.presentThreadCommandNeedsBinding(event);
      return;
    }
    const list = this.context.backend.listScheduledThreadActions?.bind(
      this.context.backend,
    );
    if (!list) {
      await this.deliverScheduledActionError(
        binding,
        event,
        "Scheduled messages are unavailable.",
      );
      return;
    }
    const listed = await list({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
    });
    // An agent's notice for the operator is no scheduled message here.
    const response = { ...listed, actions: listed.actions.filter((action) => action.kind !== "notification") };
    const [operation, candidateId, ...remaining] = event.args;
    if (!operation) {
      const body = response.actions.length > 0
        ? response.actions.map((action) => [
            `${scheduledActionDisplayId(action.id)} · ${action.status} · ${new Date(action.scheduledFor).toISOString()}`,
            action.displayText,
          ].join("\n")).join("\n\n")
        : "No scheduled messages are waiting for this thread.";
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("scheduled-message-list"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: this.context.now(),
          title: "Scheduled messages",
          body: [
            body,
            "",
            "Manage with /scheduled send <id>, /scheduled cancel <id>, or /scheduled edit <id> <time> <message>.",
          ].join("\n"),
        }),
        binding,
        event,
      );
      return;
    }
    const resolved = resolveScheduledAction(response.actions, candidateId);
    if (!resolved.ok) {
      await this.deliverScheduledActionError(binding, event, resolved.error);
      return;
    }
    try {
      if (operation === "send" || operation === "now") {
        if (!this.context.backend.sendScheduledThreadActionNow) {
          throw new Error("Sending scheduled messages now is unavailable.");
        }
        const mutation = await this.context.backend.sendScheduledThreadActionNow({
          federationTarget: federationTargetForBinding(binding),
          id: resolved.action.id,
        });
        const failureMessage = scheduledActionFailureMessage(mutation.action);
        if (failureMessage) throw new Error(failureMessage);
      } else if (operation === "cancel" || operation === "remove") {
        if (!this.context.backend.cancelScheduledThreadAction) {
          throw new Error("Cancelling scheduled messages is unavailable.");
        }
        await this.context.backend.cancelScheduledThreadAction({
          federationTarget: federationTargetForBinding(binding),
          id: resolved.action.id,
        });
      } else if (operation === "edit") {
        if (
          resolved.action.kind !== "turn"
          || !this.context.backend.updateScheduledThreadAction
        ) {
          throw new Error("That scheduled action cannot be edited here.");
        }
        const parsed = parseMessagingSchedule(remaining, this.context.now());
        if (!parsed.ok) throw new Error(parsed.error);
        const mutation = await this.context.backend.updateScheduledThreadAction({
          federationTarget: federationTargetForBinding(binding),
          id: resolved.action.id,
          scheduledFor: parsed.scheduledFor,
          displayText: parsed.text,
          turn: {
            ...resolved.action.turn,
            input: [{ type: "text", text: parsed.text }],
            messageOrigin:
              resolved.action.turn?.messageOrigin
              ?? messageOriginForInboundEvent(event),
          },
        });
        const failureMessage = scheduledActionFailureMessage(mutation.action);
        if (failureMessage) throw new Error(failureMessage);
      } else {
        throw new Error(
          "Use /scheduled, /scheduled send <id>, /scheduled cancel <id>, or /scheduled edit <id> <time> <message>.",
        );
      }
    } catch (error) {
      await this.deliverScheduledActionError(
        binding,
        event,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    await this.context.host().deliver(
      buildConfirmationIntent({
        id: this.context.host().newIntentId("scheduled-message-updated"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        title:
          operation === "edit"
            ? "Scheduled message updated"
            : operation === "cancel" || operation === "remove"
              ? "Scheduled message cancelled"
              : "Scheduled message sent",
        body: resolved.action.displayText,
      }),
      binding,
      event,
    );
  }

  private async deliverScheduledActionError(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    message: string,
  ): Promise<void> {
    await this.context.host().deliver(
      buildErrorIntent({
        id: this.context.host().newIntentId("scheduled-message-error"),
        createdAt: this.context.now(),
        title: "Scheduled message error",
        body: message,
        recoverable: true,
      }),
      binding,
      event,
    );
  }

  private async routeUnknownCommandToBoundThread(
    event: MessagingInboundCommandEvent,
    binding: MessagingBindingRecord | undefined,
  ): Promise<void> {
    if (!binding) {
      await this.presentThreadCommandNeedsBinding(event);
      return;
    }
    if (
      binding.targetKind === "agent_thread" &&
      !await this.context.host().shouldHandleAmbientSharedMessage(
        {
          ...event,
          kind: "text",
          text: event.rawText,
        },
        binding,
      )
    ) {
      return;
    }
    const text = `/${[event.command.replace(/^\/+/, ""), ...event.args]
      .filter(Boolean)
      .join(" ")}`;
    await this.context.host().admitTurnInput({
      binding,
      event: {
        ...event,
        kind: "text",
        text,
      },
    });
  }

  private async presentThreadCommandNeedsBinding(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.context.host().deliver(
      buildConfirmationIntent({
        id: this.context.host().newIntentId("thread-command-needs-binding"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        title: "Choose a thread",
        body: "Bind this conversation to a PwrAgent thread before sending thread commands.",
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
  }

  private async handleReviewCommand(
    event: MessagingInboundCommandEvent,
  ): Promise<void> {
    const binding = await this.context.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.presentThreadCommandNeedsBinding(event);
      return;
    }
    // A peer's thread is reviewed on the peer, and its picker shows the
    // peer's workspaces, so every form needs peer scope first.
    if (federationTargetForBinding(binding) && !await this.context.host().requireRemoteScopeForBinding(
      event, binding, "review:remote-instance",
    )) {
      return;
    }
    const argument = event.args.join(" ").trim();
    const pullRequestFlag = /^--pr(?:\s+|$)/.exec(argument);
    if (pullRequestFlag) {
      await this.context.host().submitMessagingReview({
        binding,
        event,
        pullRequestArgs: argument.slice(pullRequestFlag[0].length),
      });
      return;
    }
    // A Claude owner has no review/start, but its picker runs Claude Code's
    // /code-review. Typed targets still need review/start.
    if (
      !await this.context.host().reviewSupportedForBinding(binding)
      && (event.args.length > 0 || !await this.context.host().claudeCodeReviewSupportedForBinding(binding))
    ) {
      await this.context.host().deliverReviewUnsupported(binding, event);
      return;
    }

    if (event.args.length > 0) {
      const parsed = parseReviewCommand(
        `/${["review", ...event.args].join(" ")}`,
      );
      if (!parsed) {
        await this.context.host().deliver(
          buildErrorIntent({
            id: this.context.host().newIntentId("invalid-review-command"),
            createdAt: this.context.now(),
            title: "Invalid review command",
            body:
              "Use /review, /review <base branch>, /review --pr <attached PR numbers or URLs>, /review --commit <sha>, or /review --custom <instructions>.",
            recoverable: true,
          }),
          binding,
          event,
        );
        return;
      }
      await this.context.host().submitMessagingReview({
        binding,
        event,
        target: parsed.target,
      });
      return;
    }

    await this.context.host().presentReviewPicker(binding, event);
  }

  /**
   * Render the help surface. The body is the prose
   * description-list (derived from `MESSAGING_COMMAND_CATALOG` so it
   * never drifts from the verb set) and the action row is one
   * `command:<verb>` button per catalog entry on the current page,
   * plus Prev/Next/Cancel navigation when the catalog overflows a
   * single page.
   *
   * Pagination is stateless: the next/previous page index travels in
   * `action.value.pageIndex` and comes back through the
   * `MessagingInboundCallbackEvent.value` field. Help has no
   * persistent session record like the resume browser does — the
   * page content is deterministic from the catalog plus the page
   * index.
   *
   * Re-renders pass `targetSurface` from the originating callback's
   * interaction state so we update the existing post in place
   * instead of stacking new help posts on every Next click.
   */
  async presentHelp(
    event: MessagingInboundEvent,
    options?: { pageIndex?: number; targetSurface?: MessagingSurfaceRef },
  ): Promise<void> {
    const binding = await this.context.store.findActiveBindingForChannel(event.channel);
    const reviewSupported = binding
      ? await this.context.host().reviewSupportedForBinding(binding)
        || await this.context.host().claudeCodeReviewSupportedForBinding(binding)
      : false;
    const actionCatalog =
      reviewSupported
        ? MESSAGING_HELP_ACTION_COMMANDS.flatMap((command) =>
            command.verb === "help"
              ? [MESSAGING_REVIEW_HELP_SPEC, command]
              : [command],
          )
        : MESSAGING_HELP_ACTION_COMMANDS;
    const helpCatalog = [
      ...MESSAGING_COMMAND_CATALOG,
      ...(reviewSupported
        ? [MESSAGING_REVIEW_HELP_SPEC]
        : []),
    ];
    const page = paginateHelpCatalog({
      catalog: actionCatalog,
      profile: this.context.capabilityProfile,
      pageIndex: options?.pageIndex,
    });
    const actions = buildHelpActions({ page });
    const titleSuffix
      = page.totalPages > 1
        ? ` (page ${page.pageIndex + 1}/${page.totalPages})`
        : "";
    await this.context.host().deliver(
      buildConfirmationIntent({
        id: this.context.host().newIntentId("help"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        title: `PwrAgent commands${titleSuffix}`,
        body: formatMessagingCommandHelpBody({ catalog: helpCatalog }),
        actions,
        ...(options?.targetSurface
          ? {
              targetSurface: options.targetSurface,
              delivery: { mode: "update" as const, replaceMarkup: true },
            }
          : {}),
      }),
      undefined,
      event,
    );
  }

  private async handleDefaultAgentCommand(
    event: MessagingInboundCommandEvent,
  ): Promise<void> {
    const action = event.args[1]?.toLowerCase() ?? "show";
    const requestedScope = parseDefaultAgentScopeKind(event.args[2]);
    if (event.args[2] && !requestedScope) {
      await this.context.host().deliverDefaultAgentCommandError(
        event,
        "Scope must be conversation, parent, workspace, provider, or profile.",
      );
      return;
    }
    const scopeKind = requestedScope ?? "conversation";
    if (action === "set" || action === "change") {
      await this.context.host().presentDefaultAgentAssignmentBrowser(event, scopeKind);
      return;
    }
    if (action === "clear") {
      await this.context.host().clearDefaultAgentAssignment(event, scopeKind);
      return;
    }
    if (action !== "show") {
      await this.context.host().deliverDefaultAgentCommandError(
        event,
        "Use /agent default, /agent default set [scope], or /agent default clear [scope].",
      );
      return;
    }
    await this.context.host().presentDefaultAgentStatus(event);
  }

  private async handleMonitorCommand(event: MessagingInboundCommandEvent): Promise<void> {
    const action = normalizeMonitorCommandAction(event.args);
    if (
      action.kind === "topics-adopt" ||
      action.kind === "topics-cleanup" ||
      action.kind === "topics-fanout"
    ) {
      await this.handleMonitorTopicCommand(event, action);
      return;
    }
    if (action.kind === "stop") {
      await this.context.host().stopMonitoringForChannel(event);
      return;
    }

    await this.context.host().enableAndRenderChannelMonitor(event, action);
  }

  async handleMonitorTopicCommand(
    event: MessagingInboundCommandEvent,
    action: Extract<
      MonitorCommandAction,
      { kind: "topics-adopt" | "topics-cleanup" | "topics-fanout" }
    >,
  ): Promise<void> {
    if (event.channel.channel !== "telegram") {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("topics-unsupported"),
          createdAt: this.context.now(),
          title: "Topic management unavailable",
          body: "Topic cleanup and fanout are currently implemented for Telegram supergroup topics only.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const topic = await this.context.host().resolveMonitorControlTopic(event);
    if (!topic) {
      return;
    }
    const topicEvent = this.context.host().eventForManagedTopic(
      event,
      topic,
      action.kind === "topics-cleanup"
        ? ["topics", "cleanup"]
        : action.kind === "topics-fanout"
          ? ["topics", "fanout"]
          : ["topics"],
    );
    if (action.kind === "topics-cleanup") {
      await this.context.host().renderTopicCleanupProposal(topicEvent, topic);
      return;
    }
    if (action.kind === "topics-fanout") {
      await this.context.host().runTopicMonitorFanout(topicEvent, topic);
      return;
    }

    await this.context.host().renderTopicControlStatus(topicEvent, topic);
  }

  async continueClaudeThreadInNewSession(
    event: MessagingInboundCommandEvent | MessagingInboundCallbackEvent,
  ): Promise<void> {
    // Recovery replaces only a session Claude confirms is gone. It preserves
    // the thread's messages and execution settings, so the reply floor applies.
    if (!(await this.context.host().requirePermission(event, "message.reply", "claude:continue-session"))) {
      return;
    }
    const binding = await this.context.store.findActiveBindingForChannel(event.channel);
    if (!(await this.context.host().requireRemoteScopeForBinding(event, binding, "claude:continue-session:remote-instance"))) {
      return;
    }
    let errorMessage: string | undefined;
    if (!binding) {
      errorMessage = "This conversation is not attached to a thread. Use /resume to choose one.";
    } else if (
      event.kind === "callback"
      && (readStringValue(event.value, "bindingId") !== binding.id
        || readStringValue(event.value, "threadId") !== binding.threadId)
    ) {
      errorMessage = "This conversation is now attached to a different thread. Send /continue for the current thread.";
    } else if (binding.backend !== "claude") {
      errorMessage = "Only Claude threads can continue in a new session.";
    } else if (federationTargetForBinding(binding)) {
      errorMessage = "Continue this Claude thread on its owning instance.";
    } else if (!this.context.backend.continueClaudeThreadInNewSession) {
      errorMessage = "This backend does not support continuing Claude in a new session.";
    } else {
      try {
        await this.context.backend.continueClaudeThreadInNewSession({ threadId: binding.threadId });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }
    if (errorMessage !== undefined) {
      await this.context.host().deliver(buildErrorIntent({
        id: this.context.host().newIntentId("claude-continue-failed"),
        createdAt: this.context.now(),
        title: "Could not continue in a new session",
        body: errorMessage,
        recoverable: true,
      }), binding, event);
      return;
    }
    await this.context.host().deliver(buildConfirmationIntent({
      id: this.context.host().newIntentId("claude-continue-ready"),
      createdAt: this.context.now(),
      title: "Ready to continue",
      body: "Your next message starts a new Claude session with this thread's conversation as context.",
    }), binding, event);
  }
}
