import { createHash, randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AppServerBackendKind,
  AppServerPendingRequestNotification,
  AppServerToolRequestUserInputNotification,
  MessagingBindingRecord,
  MessagingBrowseSessionRecord,
  MessagingActiveTurnSummary,
  MessagingChannelKind,
  MessagingDeliveryResult,
  MessagingInboundCallbackEvent,
  MessagingInboundCommandEvent,
  MessagingInboundEvent,
  MessagingInboundTextEvent,
  MessagingJsonValue,
  MessagingMessageIntent,
  MessagingPendingIntentRecord,
  MessagingSurfaceIntent,
  NavigationSnapshot,
  NavigationThreadSummary,
  ThreadExecutionMode,
  ThreadIdentifier,
} from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import { MessagingStore, buildMessagingConversationKey } from "./messaging-store.js";
import type { MessagingAdapter, MessagingBackendBridge } from "./messaging-adapter.js";
import {
  buildActivityIntent,
  buildApprovalIntent,
  buildConfirmationIntent,
  buildErrorIntent,
  buildQuestionnaireIntent,
  buildStatusIntent,
} from "./messaging-renderer.js";
import { buildMessagingAuditContext } from "./messaging-audit.js";
import { getMainLogger } from "../../log.js";
import { DeterministicInteractionMapper } from "./deterministic-interaction-mapper.js";
import { actionsForIntent } from "./deterministic-interaction-mapper.js";
import type { MessagingInteractionMapper } from "./interaction-mapper.js";
import {
  buildResumeIntent,
  directoryForProjectSelection,
  parseResumeCommandArgs,
  RESUME_BROWSER_PAGE_SIZE,
  selectProjectFromValue,
  selectThreadFromValue,
} from "./messaging-resume-browser.js";
import {
  buildBindingStatusIntent,
  buildStatusModelPickerIntent,
  buildStatusReasoningPickerIntent,
} from "./messaging-status-card.js";
import { resolveMessagingThreadState } from "./messaging-thread-state.js";

const DEFAULT_PENDING_INTENT_TTL_MS = 15 * 60 * 1000;
const TYPING_ACTIVITY_LEASE_MS = 15_000;
const TYPING_ACTIVITY_REFRESH_MS = 10_000;
const messagingControllerLog = getMainLogger("pwragnt:messaging");

function executionModeForBinding(
  binding: MessagingBindingRecord,
  navigation?: NavigationSnapshot,
): ThreadExecutionMode | undefined {
  const thread = findThreadForBinding(navigation, binding);
  return (
    thread?.executionMode ??
    binding.preferences?.executionMode ??
    (binding.preferences?.permissionsMode === "full-access" ? "full-access" : undefined) ??
    (binding.preferences?.permissionsMode === "default" ? "default" : undefined)
  );
}

function turnSettingsForBinding(
  binding: MessagingBindingRecord,
  navigation?: NavigationSnapshot,
): {
  executionMode?: ThreadExecutionMode;
  fastMode?: boolean;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
} {
  const thread = findThreadForBinding(navigation, binding);
  return {
    executionMode: executionModeForBinding(binding, navigation),
    fastMode: thread?.fastMode ?? binding.preferences?.fastMode,
    model: thread?.model ?? binding.preferences?.model,
    reasoningEffort: thread?.reasoningEffort ?? binding.preferences?.reasoningEffort,
    serviceTier: thread?.serviceTier ?? binding.preferences?.serviceTier,
  };
}

function findThreadForBinding(
  navigation: NavigationSnapshot | undefined,
  binding: MessagingBindingRecord,
): NavigationThreadSummary | undefined {
  return navigation?.threads.find(
    (thread) => thread.source === binding.backend && thread.id === binding.threadId,
  );
}

type MessagingControllerLogger = {
  debug?(message: string, data?: Record<string, unknown>): void;
};

export type MessagingControllerOptions = {
  adapter: MessagingAdapter;
  authorizedActorIds: string[];
  backend: MessagingBackendBridge;
  channel?: MessagingChannelKind;
  interactionMapper?: MessagingInteractionMapper;
  logger?: MessagingControllerLogger;
  now?: () => number;
  pendingIntentTtlMs?: number;
  store: MessagingStore;
};

export class MessagingController {
  private readonly authorizedActorIds: Set<string>;
  private readonly deliveredAssistantMessageKeys = new Set<string>();
  private readonly now: () => number;
  private readonly pendingIntentTtlMs: number;
  private readonly interactionMapper: MessagingInteractionMapper;
  private readonly activeTurnsByThreadKey = new Map<string, MessagingActiveTurnSummary>();
  private readonly typingActivityLastSignaledAt = new Map<string, number>();
  private readonly logger: MessagingControllerLogger;

  constructor(private readonly options: MessagingControllerOptions) {
    this.authorizedActorIds = new Set(options.authorizedActorIds);
    this.now = options.now ?? Date.now;
    this.pendingIntentTtlMs =
      options.pendingIntentTtlMs ?? DEFAULT_PENDING_INTENT_TTL_MS;
    this.interactionMapper = options.interactionMapper ?? new DeterministicInteractionMapper();
    this.logger = options.logger ?? messagingControllerLog;
  }

  async handleInboundEvent(event: MessagingInboundEvent): Promise<void> {
    if (!this.isAuthorized(event.actor.platformUserId)) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("unauthorized"),
          createdAt: this.now(),
          title: "Not authorized",
          body: "This channel user is not authorized to control PwrAgnt.",
          recoverable: false,
        }),
        undefined,
        event,
      );
      return;
    }

    if (event.kind === "command") {
      await this.handleCommand(event);
      return;
    }

    if (event.kind === "callback") {
      await this.handleCallback(event);
      return;
    }

    if (event.kind === "media") {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("unsupported-media"),
          createdAt: this.now(),
          title: "Media is not supported yet",
          body: "This messaging integration accepts text and buttons for now.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    if (event.kind === "text") {
      await this.handleText(event);
    }
  }

  async handleBackendEvent(event: AgentEvent): Promise<void> {
    const threadId = threadIdForBackendEvent(event);
    if (!threadId) {
      return;
    }
    if (event.notification.method === "serverRequest/resolved") {
      await this.handleBackendRequestResolved(event);
      return;
    }

    const bindings = this.filterBindingsForChannel(
      await this.options.store.findActiveBindingsForThread({
        backend: event.backend,
        threadId,
      }),
    );
    const lifecycle = turnLifecycleForBackendEvent(event, this.now());
    for (const binding of bindings) {
      let activeTurn = this.getActiveTurn(binding);
      if (lifecycle) {
        const previousTurn = activeTurn;
        activeTurn = lifecycle;
        this.setActiveTurn(binding, activeTurn);
        this.logBindingTurnStateChange(
          binding,
          previousTurn,
          activeTurn,
          event.notification.method,
        );
      } else if (isThreadStatusIdleEvent(event) && activeTurn) {
        const previousTurn = activeTurn;
        activeTurn = {
          ...activeTurn,
          status: "completed",
          updatedAt: this.now(),
        };
        this.setActiveTurn(binding, activeTurn);
        this.logBindingTurnStateChange(
          binding,
          previousTurn,
          activeTurn,
          event.notification.method,
        );
      }

      const assistantText = assistantTextForBackendEvent(event);
      if (assistantText && !lifecycle && activeTurn?.status === "working") {
        const previousTurn = activeTurn;
        activeTurn = {
          ...activeTurn,
          status: "completed",
          updatedAt: this.now(),
        };
        this.setActiveTurn(binding, activeTurn);
        this.logBindingTurnStateChange(
          binding,
          previousTurn,
          activeTurn,
          event.notification.method,
        );
        await this.signalTurnActivity(binding, activeTurn, {
          reason: "assistant_final",
          force: true,
        });
      }
      if (assistantText) {
        await this.deliverAssistantMessage(assistantText, event, binding);
      }

      if (lifecycle || (isThreadStatusIdleEvent(event) && activeTurn)) {
        await this.signalTurnActivity(binding, activeTurn!, {
          reason: event.notification.method,
          force: true,
        });
        await this.renderBindingStatus(binding);
      } else if (!assistantText && activeTurn?.status === "working") {
        await this.signalTurnActivity(binding, activeTurn, {
          reason: event.notification.method,
        });
      }
    }
  }

  async handleBackendPendingRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
  ): Promise<void> {
    const bindings = this.filterBindingsForChannel(
      await this.options.store.findActiveBindingsForThread({
        backend,
        threadId: request.params.threadId,
      }),
    );

    for (const binding of bindings) {
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
        now: this.now(),
        threadId: request.params.threadId,
      });
      const pendingIntent = await this.storePendingIntent(intent, binding);
      const delivery = await this.deliver(intent, binding);
      if (delivery.surface) {
        await this.options.store.upsertPendingIntent({
          ...pendingIntent,
          surface: delivery.surface,
        });
      }
      if (request.params.turnId) {
        const activeTurn: MessagingActiveTurnSummary = {
          turnId: request.params.turnId,
          status: "waiting",
          updatedAt: this.now(),
        };
        this.setActiveTurn(binding, activeTurn);
        await this.signalTurnActivity(binding, activeTurn, {
          force: true,
        });
        await this.renderBindingStatus(binding);
      }
    }
  }

  private async handleCommand(event: MessagingInboundCommandEvent): Promise<void> {
    const command = event.command.replace(/^\//, "").toLowerCase();
    if (command === "status") {
      await this.presentStatus(event);
      return;
    }
    if (command === "detach") {
      await this.detachBinding(event);
      return;
    }
    if (command === "resume") {
      await this.presentResumeBrowser(event);
      return;
    }

    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("help"),
        createdAt: this.now(),
        title: "PwrAgnt",
        body: "Use /resume to choose a thread to control from this conversation.",
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

  private async handleText(event: MessagingInboundTextEvent): Promise<void> {
    const command = parseTextCommand(event.text);
    if (command) {
      await this.handleCommand({
        ...event,
        kind: "command",
        command,
        args: parseTextCommandArgs(event.text),
        rawText: event.text,
      });
      return;
    }

    const pendingIntent = await this.options.store.findActivePendingIntentForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
    if (pendingIntent) {
      const mapped = await this.interactionMapper.mapText({
        intent: pendingIntent.intent,
        text: event.text,
      });
      if (mapped.kind === "matched") {
        await this.handleCallback({
          ...event,
          kind: "callback",
          interaction: {
            channel: event.channel.channel,
            id: mapped.action.id,
          },
          actionId: mapped.action.id,
          value: mapped.action.value,
        });
        return;
      }
      if (mapped.kind === "ambiguous") {
        await this.deliver(
          buildConfirmationIntent({
            id: this.newIntentId("ambiguous-reply"),
            createdAt: this.now(),
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

    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("needs-binding"),
          createdAt: this.now(),
          title: "Choose a thread",
          body: "Bind this conversation to a PwrAgnt thread before sending instructions.",
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

    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const turnSettings = turnSettingsForBinding(binding, navigation);
    const started = await this.options.backend.startTurn({
      backend: binding.backend,
      threadId: binding.threadId,
      input: [
        {
          type: "text",
          text: event.text,
        },
      ],
      ...turnSettings,
    });
    const activeTurn: MessagingActiveTurnSummary = {
      turnId: started.turnId,
      status: "working",
      startedAt: this.now(),
      updatedAt: this.now(),
    };
    this.setActiveTurn(binding, activeTurn);
    await this.signalTurnActivity(binding, activeTurn, {
      force: true,
    });
    await this.renderBindingStatus(binding, undefined, navigation);
  }

  private async handleCallback(event: MessagingInboundCallbackEvent): Promise<void> {
    const command = readCommandAction(event);
    if (command) {
      await this.handleCommand({
        ...event,
        kind: "command",
        args: [],
        command,
        rawText: `/${command}`,
      });
      return;
    }

    const browseAction = readBrowseAction(event);
    if (browseAction) {
      await this.handleBrowseCallback(event, browseAction);
      return;
    }

    const statusAction = readStatusAction(event);
    if (statusAction) {
      await this.handleStatusCallback(event, statusAction);
      return;
    }

    const bindingTarget = readBindingTarget(event);
    if (bindingTarget) {
      const binding = await this.bindChannelToThread(event, bindingTarget);
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("bound"),
          createdAt: this.now(),
          title: "Thread bound",
          body: "Messages in this conversation will route to the selected thread.",
          fallbackText: "Send a message to continue the thread.",
        }),
        binding,
      );
      await this.renderBindingStatus(binding);
      return;
    }

    const pendingIntent = await this.options.store.findActivePendingIntentForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
    if (pendingIntent) {
      const action = actionsForIntent(pendingIntent.intent).find(
        (candidate) => candidate.id === (event.actionId ?? event.interaction.id),
      );
      if (action && pendingIntent.intent.kind === "approval") {
        await this.submitApprovalAction(pendingIntent.intent, action.id);
        await this.retireApprovalIntent(pendingIntent, event);
        await this.options.store.deletePendingIntent(pendingIntent.id);
        await this.deliver(
          buildStatusIntent({
            id: this.newIntentId("approval-submitted"),
            createdAt: this.now(),
            status: "completed",
            text: "Approval response sent.",
          }),
          undefined,
          event,
        );
        return;
      }
    }

    if ((event.actionId ?? event.interaction.id).startsWith("approval:")) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("expired-approval"),
          createdAt: this.now(),
          title: "Approval expired",
          body: "That approval request is no longer available. Retry the command or request that needed approval.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("expired-callback"),
        createdAt: this.now(),
        title: "Action expired",
        body: "That action is no longer available. Use /resume to refresh.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  private async submitApprovalAction(
    intent: Extract<MessagingSurfaceIntent, { kind: "approval" }>,
    actionId: string,
  ): Promise<void> {
    const requestContext = intent.requestContext;
    const decision = intent.decisions.find((action) => action.id === actionId)?.decision;
    if (!requestContext || !decision || !this.options.backend.submitServerRequest) {
      return;
    }

    await this.options.backend.submitServerRequest({
      backend: requestContext.backend,
      threadId: requestContext.threadId,
      turnId: requestContext.turnId,
      requestId: requestContext.requestId,
      response: {
        decision,
      },
    });
  }

  private async handleBackendRequestResolved(event: AgentEvent): Promise<void> {
    if (event.notification.method !== "serverRequest/resolved") {
      return;
    }

    const pendingIntents =
      await this.options.store.findActivePendingIntentsForRequest({
        backend: event.backend,
        threadId: event.notification.params.threadId,
        requestId: event.notification.params.requestId,
        now: this.now(),
      });

    for (const pendingIntent of pendingIntents.filter((intent) =>
      this.isChannelInScope(intent.channel),
    )) {
      await this.retireApprovalIntent(pendingIntent);
      await this.options.store.deletePendingIntent(pendingIntent.id);
    }
  }

  private async retireApprovalIntent(
    pendingIntent: MessagingPendingIntentRecord,
    event?: MessagingInboundCallbackEvent,
  ): Promise<void> {
    if (pendingIntent.intent.kind !== "approval") {
      return;
    }

    const targetSurface = pendingIntent.surface ?? event?.interaction;
    if (!targetSurface) {
      return;
    }

    try {
      await this.deliver(
        {
          ...pendingIntent.intent,
          decisions: [],
          delivery: {
            mode: "update",
            replaceMarkup: true,
            fallback: "fail",
          },
          targetSurface,
        },
        undefined,
        event,
      );
    } catch (error) {
      this.logger.debug?.("messaging approval retirement update failed", {
        error: error instanceof Error ? error.message : String(error),
        intentId: pendingIntent.intent.id,
      });
    }
  }

  private async deliverAssistantMessage(
    text: string,
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): Promise<void> {
    const key = assistantMessageDeliveryKey(event, text);
    if (this.deliveredAssistantMessageKeys.has(key)) {
      return;
    }
    this.deliveredAssistantMessageKeys.add(key);
    this.logger.debug?.(
      `messaging assistant deliver thread=${binding.threadId} binding=${binding.id} chars=${text.length} preview="${compactLogPreview(text)}"`,
    );

    await this.deliver(
      {
        id: this.newIntentId("assistant-message"),
        kind: "message",
        bindingId: binding.id,
        createdAt: this.now(),
        role: "assistant",
        parts: [
          {
            type: "text",
            text,
            markdown: "markdown",
          },
        ],
      },
      binding,
    );
  }

  private async presentResumeBrowser(event: MessagingInboundCommandEvent): Promise<void> {
    const parsed = parseResumeCommandArgs(event.args);
    if (parsed.error) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("resume-error"),
          createdAt: this.now(),
          title: "Resume command error",
          body: parsed.error,
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
      filter: parsed.query,
    });
    const selectedDirectory = parsed.cwd
      ? navigation.directories.find(
          (directory) => directory.path === parsed.cwd || directory.key === parsed.cwd,
        )
      : undefined;
    const session: MessagingBrowseSessionRecord = {
      id: this.newIntentId("browse"),
      allowedActorIds: [event.actor.platformUserId],
      channel: event.channel,
      createdAt: this.now(),
      updatedAt: this.now(),
      expiresAt: this.now() + this.pendingIntentTtlMs,
      launchAction: parsed.launchAction,
      mode: selectedDirectory && parsed.mode === "recents" ? "project_threads" : parsed.mode,
      pageIndex: 0,
      pageSize: RESUME_BROWSER_PAGE_SIZE,
      preferences: parsed.preferences
        ? {
            ...parsed.preferences,
            updatedAt: this.now(),
          }
        : undefined,
      query: parsed.query,
      selectedProject: selectedDirectory
        ? {
            directoryKey: selectedDirectory.key,
            label: selectedDirectory.label,
            path: selectedDirectory.path,
          }
        : undefined,
    };
    await this.renderResumeBrowser(session, navigation, event);
  }

  private async handleBrowseCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    const session = await this.options.store.findActiveBrowseSessionForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
    if (!session) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("expired-browse"),
          createdAt: this.now(),
          title: "Action expired",
          body: "That browser action is no longer available. Use /resume to refresh.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
      filter: session.query,
    });
    const nextSession = {
      ...session,
      updatedAt: this.now(),
    };

    if (actionId === "browse:page:next") {
      await this.renderResumeBrowser(
        { ...nextSession, pageIndex: nextSession.pageIndex + 1 },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:page:prev") {
      await this.renderResumeBrowser(
        { ...nextSession, pageIndex: Math.max(0, nextSession.pageIndex - 1) },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:projects") {
      await this.renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "resume_thread",
          mode: "projects",
          pageIndex: 0,
          selectedProject: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:recents") {
      await this.renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "resume_thread",
          mode: "recents",
          pageIndex: 0,
          selectedProject: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:new") {
      await this.renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "start_new_thread",
          mode: "new_project",
          pageIndex: 0,
          selectedProject: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:cancel") {
      await this.options.store.deleteBrowseSession(session.id);
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("browse-cancelled"),
          createdAt: this.now(),
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
        await this.deliverInvalidBrowseSelection(event);
        return;
      }
      if (session.launchAction === "start_new_thread") {
        await this.startNewThreadFromProject(event, session, navigation, project);
        return;
      }
      await this.renderResumeBrowser(
        {
          ...nextSession,
          mode: "project_threads",
          pageIndex: 0,
          selectedProject: project,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:select-thread") {
      const target = selectThreadFromValue(event.value);
      if (!target) {
        await this.deliverInvalidBrowseSelection(event);
        return;
      }
      const binding = await this.bindChannelToThread(event, target);
      const updatedBinding = session.preferences
        ? await this.updateBindingPreferences(binding, session.preferences)
        : binding;
      await this.options.store.deleteBrowseSession(session.id);
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("bound"),
          createdAt: this.now(),
          title: "Thread bound",
          body: "Messages in this conversation will route to the selected thread.",
          fallbackText: "Send a message to continue the thread.",
        }),
        updatedBinding,
      );
      await this.renderBindingStatus(updatedBinding, event, navigation);
      return;
    }

    await this.deliverInvalidBrowseSelection(event);
  }

  private async renderResumeBrowser(
    session: MessagingBrowseSessionRecord,
    navigation: Awaited<ReturnType<MessagingBackendBridge["getNavigationSnapshot"]>>,
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.options.store.upsertBrowseSession(session);
    const intent = buildResumeIntent({
      id: this.newIntentId("resume"),
      createdAt: this.now(),
      navigation,
      session,
    });
    await this.storePendingIntent(intent, undefined, event);
    const result = await this.deliver(intent, undefined, event);
    if (!result.surface) {
      return;
    }

    await this.options.store.upsertBrowseSession({
      ...session,
      surface: result.surface,
      updatedAt: this.now(),
    });
    await this.options.store.upsertPendingIntent({
      id: intent.id,
      channel: event.channel,
      intent,
      allowedActorIds: [event.actor.platformUserId],
      createdAt: this.now(),
      expiresAt: this.now() + this.pendingIntentTtlMs,
      surface: result.surface,
    });
  }

  private async startNewThreadFromProject(
    event: MessagingInboundCallbackEvent,
    session: MessagingBrowseSessionRecord,
    navigation: Awaited<ReturnType<MessagingBackendBridge["getNavigationSnapshot"]>>,
    project: NonNullable<ReturnType<typeof selectProjectFromValue>>,
  ): Promise<void> {
    if (!this.options.backend.startThread) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("new-thread-unavailable"),
          createdAt: this.now(),
          title: "New thread unavailable",
          body: "This backend does not support starting a thread from messaging yet.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const directory = directoryForProjectSelection(navigation, project);
    const preferences = session.preferences;
    const started = await this.options.backend.startThread({
      backend: navigation.launchpadDefaults.backend,
      cwd: directory?.path ?? project.path,
      executionMode: preferences?.executionMode ?? navigation.launchpadDefaults.executionMode,
      fastMode: preferences?.fastMode ?? navigation.launchpadDefaults.fastMode,
      model: preferences?.model ?? navigation.launchpadDefaults.model,
      reasoningEffort:
        preferences?.reasoningEffort ?? navigation.launchpadDefaults.reasoningEffort,
      serviceTier: preferences?.serviceTier ?? navigation.launchpadDefaults.serviceTier,
    });
    const binding = await this.bindChannelToThread(event, {
      backend: started.backend,
      threadId: started.threadId,
    });
    const updatedBinding = preferences
      ? await this.updateBindingPreferences(binding, preferences)
      : binding;
    await this.options.store.deleteBrowseSession(session.id);
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("new-thread-bound"),
        createdAt: this.now(),
        title: "Thread started",
        body: `Started and bound a new thread for ${project.label}.`,
        fallbackText: "Send a message to continue the new thread.",
      }),
      updatedBinding,
    );
    await this.renderBindingStatus(updatedBinding, event);
  }

  private async presentStatus(event: MessagingInboundEvent): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("status-unbound"),
          createdAt: this.now(),
          title: "No thread bound",
          body: "Use /resume to choose a PwrAgnt thread for this conversation.",
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

    await this.recreateBindingStatus(binding, event);
  }

  private async handleStatusCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    if (actionId === "status:detach") {
      await this.detachBinding(event);
      return;
    }

    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-expired"),
          createdAt: this.now(),
          title: "Action expired",
          body: "That status action is no longer available. Use /status to refresh.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    if (actionId === "status:refresh") {
      await this.renderBindingStatus(binding, event);
      return;
    }
    if (actionId === "status:model") {
      await this.presentModelPicker(binding, event);
      return;
    }
    if (actionId === "status:reasoning") {
      await this.presentReasoningPicker(binding, event);
      return;
    }
    if (actionId === "status:set-model") {
      await this.setBindingModel(binding, event);
      return;
    }
    if (actionId === "status:set-reasoning") {
      await this.setBindingReasoning(binding, event);
      return;
    }
    if (actionId === "status:fast") {
      await this.toggleFastMode(binding, event);
      return;
    }
    if (actionId === "status:permissions") {
      await this.togglePermissionsMode(binding, event);
      return;
    }
    if (actionId === "status:stop") {
      await this.stopActiveTurn(binding, event);
      return;
    }
    if (actionId === "status:compact") {
      await this.compactThread(binding, event);
      return;
    }
    if (actionId === "status:sync-name") {
      await this.syncConversationName(binding, event);
      return;
    }

    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("status-action-pending"),
        createdAt: this.now(),
        title: "Status action unavailable",
        body: "Use /status to refresh. This control will be wired to backend actions in the next implementation slice.",
      }),
      binding,
    );
  }

  private async presentModelPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const summary = await this.getBackendSummary(binding.backend);
    const models = summary?.launchpadOptions?.models ?? [];
    if (models.length === 0) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-models-unavailable"),
          createdAt: this.now(),
          title: "Models unavailable",
          body: "This backend did not report model choices. Use /status to refresh.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    await this.deliver(
      buildStatusModelPickerIntent({
        id: this.newIntentId("status-model-picker"),
        binding,
        createdAt: this.now(),
        models,
      }),
      binding,
      event,
    );
  }

  private async presentReasoningPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const summary = await this.getBackendSummary(binding.backend);
    const efforts = summary?.launchpadOptions?.reasoningEfforts ?? [
      "low",
      "medium",
      "high",
    ];
    await this.deliver(
      buildStatusReasoningPickerIntent({
        id: this.newIntentId("status-reasoning-picker"),
        binding,
        createdAt: this.now(),
        efforts,
      }),
      binding,
      event,
    );
  }

  private async setBindingModel(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const model = readStringValue(event.value, "model");
    if (!model) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }

    const updatedBinding = await this.updateBindingPreferences(binding, {
      model,
    });
    await this.options.backend.setThreadModelSettings?.({
      backend: binding.backend,
      threadId: binding.threadId,
      model,
      fastMode: updatedBinding.preferences?.fastMode,
      reasoningEffort: updatedBinding.preferences?.reasoningEffort,
      serviceTier: updatedBinding.preferences?.serviceTier,
    });
    await this.renderBindingStatus(updatedBinding, event);
  }

  private async setBindingReasoning(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const reasoningEffort = readStringValue(event.value, "reasoningEffort");
    if (!reasoningEffort) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }

    const updatedBinding = await this.updateBindingPreferences(binding, {
      reasoningEffort,
    });
    await this.options.backend.setThreadModelSettings?.({
      backend: binding.backend,
      threadId: binding.threadId,
      fastMode: updatedBinding.preferences?.fastMode,
      model: updatedBinding.preferences?.model,
      reasoningEffort,
      serviceTier: updatedBinding.preferences?.serviceTier,
    });
    await this.renderBindingStatus(updatedBinding, event);
  }

  private async toggleFastMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const fastMode = !binding.preferences?.fastMode;
    const updatedBinding = await this.updateBindingPreferences(binding, {
      fastMode,
    });
    await this.options.backend.setThreadModelSettings?.({
      backend: binding.backend,
      threadId: binding.threadId,
      fastMode,
      model: updatedBinding.preferences?.model,
      reasoningEffort: updatedBinding.preferences?.reasoningEffort,
      serviceTier: updatedBinding.preferences?.serviceTier,
    });
    await this.renderBindingStatus(updatedBinding, event);
  }

  private async togglePermissionsMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const currentMode = executionModeForBinding(binding, navigation) ?? "default";
    const nextMode = currentMode === "full-access" ? "default" : "full-access";
    const executionMode = nextMode;
    await this.options.backend.setThreadExecutionMode?.({
      backend: binding.backend,
      threadId: binding.threadId,
      executionMode,
    });
    const updatedBinding = await this.updateBindingPreferences(binding, {
      executionMode,
      permissionsMode: nextMode,
    });
    await this.renderBindingStatus(updatedBinding, event);
  }

  private async stopActiveTurn(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const activeTurn = this.getActiveTurn(binding);
    if (!activeTurn || !["working", "waiting"].includes(activeTurn.status)) {
      await this.renderBindingStatus(binding, event);
      return;
    }
    await this.options.backend.interruptTurn?.({
      backend: binding.backend,
      threadId: binding.threadId,
      turnId: activeTurn.turnId,
    });
    const interruptedTurn: MessagingActiveTurnSummary = {
      ...activeTurn,
      status: "interrupted",
      updatedAt: this.now(),
    };
    this.setActiveTurn(binding, interruptedTurn);
    await this.signalTurnActivity(binding, interruptedTurn, {
      force: true,
    });
    await this.renderBindingStatus(binding, event);
  }

  private async compactThread(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    if (!this.options.backend.compactThread) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-compact-unavailable"),
          createdAt: this.now(),
          title: "Compact unavailable",
          body: "This backend does not expose thread compaction through messaging.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const compacted = await this.options.backend.compactThread({
      backend: binding.backend,
      threadId: binding.threadId,
    });
    const activeTurn: MessagingActiveTurnSummary = {
      turnId: compacted.turnId,
      status: "working",
      startedAt: this.now(),
      updatedAt: this.now(),
    };
    this.setActiveTurn(binding, activeTurn);
    await this.signalTurnActivity(binding, activeTurn, {
      force: true,
    });
    await this.renderBindingStatus(binding, event);
  }

  private async syncConversationName(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    if (!this.options.adapter.setConversationTitle) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-sync-name-unavailable"),
          createdAt: this.now(),
          title: "Name sync unavailable",
          body: "This messaging provider does not support syncing the conversation name.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const threadState = resolveMessagingThreadState({
      activeTurn: this.getActiveTurn(binding),
      binding,
      navigation,
    });
    const threadTitle = normalizeConversationTitle(threadState.title);
    if (!threadTitle) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-sync-name-missing-title"),
          createdAt: this.now(),
          title: "Name sync unavailable",
          body: "This thread does not have a Codex thread name to sync yet.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const result = await this.options.adapter.setConversationTitle({
      actor: event.actor,
      channel: binding.channel,
      routingState: event.routingState ?? binding.routingState,
      title: threadTitle,
    });
    if (result.outcome !== "updated") {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-sync-name-failed"),
          createdAt: this.now(),
          title: "Name sync unavailable",
          body:
            result.errorMessage ??
            `This ${conversationKindLabel(binding.channel.conversation.kind)} cannot be renamed from messaging.`,
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const updatedBinding = await this.options.store.upsertBinding({
      ...binding,
      channel: {
        ...binding.channel,
        conversation: {
          ...binding.channel.conversation,
          title: result.title,
        },
      },
      updatedAt: this.now(),
    });
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("status-sync-name-confirmed"),
        createdAt: this.now(),
        title: "Name synced",
        body: `Set this ${conversationKindLabel(binding.channel.conversation.kind)} name to "${result.title}".`,
      }),
      updatedBinding,
      event,
    );
    await this.renderBindingStatus(updatedBinding, event, navigation);
  }

  private async updateBindingPreferences(
    binding: MessagingBindingRecord,
    patch: Partial<NonNullable<MessagingBindingRecord["preferences"]>>,
  ): Promise<MessagingBindingRecord> {
    return await this.options.store.upsertBinding({
      ...binding,
      preferences: {
        ...binding.preferences,
        ...patch,
        updatedAt: this.now(),
      },
      updatedAt: this.now(),
    });
  }

  private async getBackendSummary(backend: AppServerBackendKind) {
    const response = await this.options.backend.listBackends?.({
      includeUnavailable: true,
    });
    return response?.backends.find((candidate) => candidate.kind === backend);
  }

  private async deliverInvalidStatusSelection(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("invalid-status-selection"),
        createdAt: this.now(),
        title: "Invalid status selection",
        body: "That status selection is no longer available. Use /status to refresh.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  private async detachBinding(event: MessagingInboundEvent): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("detach-unbound"),
          createdAt: this.now(),
          title: "No thread bound",
          body: "This conversation is not bound to a PwrAgnt thread.",
        }),
        undefined,
        event,
      );
      return;
    }

    const statusSurface = binding.pinnedStatusSurface ?? binding.statusSurface;
    const activeTurn = this.getActiveTurn(binding);
    if (activeTurn) {
      await this.signalTurnActivity(
        binding,
        {
          ...activeTurn,
          status: "interrupted",
          updatedAt: this.now(),
        },
        { force: true },
      );
    }
    if (statusSurface) {
      await this.deliver(
        {
          id: this.newIntentId("status-dismiss"),
          kind: "dismiss",
          bindingId: binding.id,
          createdAt: this.now(),
          delivery: {
            mode: "dismiss",
            unpin: Boolean(binding.pinnedStatusSurface),
          },
          reason: "detached",
          targetSurface: statusSurface,
        },
        binding,
        event,
      );
    }

    await this.options.store.revokeBinding({
      bindingId: binding.id,
      revokedAt: this.now(),
    });
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("detached"),
        createdAt: this.now(),
        title: "Thread detached",
        body: "Messages in this conversation will no longer route to PwrAgnt.",
      }),
      undefined,
      event,
    );
  }

  private async recreateBindingStatus(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<MessagingBindingRecord> {
    const snapshot = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const retiredBinding = await this.retireBindingStatus(binding, event, snapshot);
    return await this.renderBindingStatus(retiredBinding, event, snapshot);
  }

  private async retireBindingStatus(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    navigation: NavigationSnapshot,
  ): Promise<MessagingBindingRecord> {
    const statusSurface = binding.statusSurface ?? binding.pinnedStatusSurface;
    if (!statusSurface) {
      return binding;
    }

    try {
      await this.deliver(
        {
          ...buildBindingStatusIntent({
            id: this.newIntentId("status-retire"),
            binding,
            createdAt: this.now(),
            threadState: resolveMessagingThreadState({
              activeTurn: this.getActiveTurn(binding),
              binding,
              navigation,
            }),
          }),
          actions: [],
          delivery: {
            mode: "update",
            replaceMarkup: true,
            fallback: "fail",
          },
          targetSurface: statusSurface,
        },
        binding,
        event,
      );
    } catch (error) {
      this.logger.debug?.("messaging status retirement update failed", {
        bindingId: binding.id,
        error: error instanceof Error ? error.message : String(error),
        threadId: binding.threadId,
      });
    }

    if (binding.pinnedStatusSurface) {
      try {
        await this.deliver(
          {
            id: this.newIntentId("status-unpin"),
            kind: "dismiss",
            bindingId: binding.id,
            createdAt: this.now(),
            delivery: {
              mode: "dismiss",
              unpin: true,
            },
            reason: "status_recreated",
            targetSurface: binding.pinnedStatusSurface,
          },
          binding,
          event,
        );
      } catch (error) {
        this.logger.debug?.("messaging status retirement unpin failed", {
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
      }
    }

    return await this.options.store.upsertBinding({
      ...binding,
      pinnedStatusSurface: undefined,
      statusSurface: undefined,
      updatedAt: this.now(),
    });
  }

  private async renderBindingStatus(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    navigation?: NavigationSnapshot,
  ): Promise<MessagingBindingRecord> {
    const snapshot =
      navigation ??
      (await this.options.backend.getNavigationSnapshot({
        backend: "all",
      }));
    const intent = buildBindingStatusIntent({
      id: this.newIntentId("status"),
      binding,
      createdAt: this.now(),
      threadState: resolveMessagingThreadState({
        activeTurn: this.getActiveTurn(binding),
        binding,
        navigation: snapshot,
      }),
    });
    const result = await this.deliver(intent, binding, event);
    if (!result.surface) {
      return binding;
    }

    return await this.options.store.upsertBinding({
      ...binding,
      pinnedStatusSurface:
        result.outcome === "pinned"
          ? result.surface
          : binding.pinnedStatusSurface,
      statusSurface: result.surface,
      updatedAt: this.now(),
    });
  }

  private getActiveTurn(
    binding: MessagingBindingRecord,
  ): MessagingActiveTurnSummary | undefined {
    return this.activeTurnsByThreadKey.get(this.threadKeyForBinding(binding));
  }

  private setActiveTurn(
    binding: MessagingBindingRecord,
    activeTurn: MessagingActiveTurnSummary,
  ): void {
    this.activeTurnsByThreadKey.set(this.threadKeyForBinding(binding), activeTurn);
  }

  private threadKeyForBinding(binding: MessagingBindingRecord): string {
    return buildThreadIdentityKey(binding.backend, binding.threadId);
  }

  private async signalTurnActivity(
    binding: MessagingBindingRecord,
    activeTurn: MessagingActiveTurnSummary,
    options?: { force?: boolean; reason?: string },
  ): Promise<void> {
    const state = activeTurn.status === "working" ? "active" : "idle";
    const now = this.now();
    const lastSignaledAt = this.typingActivityLastSignaledAt.get(binding.id);
    if (
      state === "active" &&
      !options?.force &&
      lastSignaledAt !== undefined &&
      now - lastSignaledAt < TYPING_ACTIVITY_REFRESH_MS
    ) {
      if (options?.reason !== "item/agentMessage/delta") {
        this.logger.debug?.(
          `messaging typing suppressed state=${state} reason=${options?.reason ?? "unknown"} elapsedMs=${now - lastSignaledAt} thread=${binding.threadId} turn=${activeTurn.turnId} binding=${binding.id}`,
        );
      }
      return;
    }
    if (state === "active") {
      this.typingActivityLastSignaledAt.set(binding.id, now);
    } else {
      this.typingActivityLastSignaledAt.delete(binding.id);
    }

    this.logger.debug?.(
      `messaging typing signaled state=${state} reason=${options?.reason ?? "unknown"} force=${Boolean(options?.force)} leaseMs=${state === "active" ? TYPING_ACTIVITY_LEASE_MS : "none"} status=${activeTurn.status} thread=${binding.threadId} turn=${activeTurn.turnId} binding=${binding.id}`,
    );

    await this.deliver(
      buildActivityIntent({
        id: this.newIntentId("activity"),
        activity: "typing",
        bindingId: binding.id,
        createdAt: now,
        leaseMs: state === "active" ? TYPING_ACTIVITY_LEASE_MS : undefined,
        state,
      }),
      binding,
    );
  }

  private logBindingTurnStateChange(
    binding: MessagingBindingRecord,
    previousTurn: MessagingActiveTurnSummary | undefined,
    nextTurn: MessagingActiveTurnSummary | undefined,
    reason: string,
  ): void {
    if (
      previousTurn?.turnId === nextTurn?.turnId &&
      previousTurn?.status === nextTurn?.status
    ) {
      return;
    }

    this.logger.debug?.(
      `messaging turn state changed reason=${reason} backend=${binding.backend} thread=${binding.threadId} binding=${binding.id} previous=${previousTurn?.status ?? "none"}:${previousTurn?.turnId ?? "none"} next=${nextTurn?.status ?? "none"}:${nextTurn?.turnId ?? "none"}`,
    );
  }

  private async deliverInvalidBrowseSelection(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("invalid-browse-selection"),
        createdAt: this.now(),
        title: "Invalid selection",
        body: "That resume selection is no longer available. Use /resume to refresh.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  private async bindChannelToThread(
    event: MessagingInboundCallbackEvent,
    target: { backend: AppServerBackendKind; threadId: ThreadIdentifier },
  ): Promise<MessagingBindingRecord> {
    const now = this.now();
    const binding: MessagingBindingRecord = {
      id: `binding:${buildMessagingConversationKey(event.channel)}:${target.backend}:${target.threadId}`,
      channel: event.channel,
      backend: target.backend,
      threadId: target.threadId,
      authorizedActorIds: [event.actor.platformUserId],
      routingState: event.routingState,
      createdAt: now,
      updatedAt: now,
      displayName: event.actor.displayName ?? event.actor.username,
    };
    return await this.options.store.upsertBinding(binding);
  }

  private intentForPendingRequest(
    request: AppServerPendingRequestNotification,
  ): MessagingSurfaceIntent | undefined {
    if (request.method === "item/tool/requestUserInput") {
      return buildQuestionnaireIntent({
        id: this.newIntentId("questionnaire"),
        createdAt: this.now(),
        request: request as AppServerToolRequestUserInputNotification,
      });
    }

    if (request.method.toLowerCase().includes("requestapproval")) {
      return buildApprovalIntent({
        id: this.newIntentId("approval"),
        createdAt: this.now(),
        request,
      });
    }

    return undefined;
  }

  private async storePendingIntent(
    intent: MessagingSurfaceIntent,
    binding?: MessagingBindingRecord,
    event?: MessagingInboundEvent,
  ): Promise<MessagingPendingIntentRecord> {
    return await this.options.store.upsertPendingIntent({
      id: intent.id,
      bindingId: binding?.id,
      channel: binding?.channel ?? event?.channel,
      intent,
      allowedActorIds: binding?.authorizedActorIds ?? [
        event?.actor.platformUserId ?? "unknown",
      ],
      createdAt: this.now(),
      expiresAt: this.now() + this.pendingIntentTtlMs,
    });
  }

  private async deliver(
    intent: MessagingSurfaceIntent,
    binding?: MessagingBindingRecord,
    event?: MessagingInboundEvent,
  ): Promise<MessagingDeliveryResult> {
    const routedIntent = this.withRoutingAudit(intent, binding, event);
    const result = await this.options.adapter.deliver(routedIntent);
    await this.options.store.recordDelivery({
      ...result,
      id: `delivery:${routedIntent.id}:${randomUUID()}`,
      bindingId: binding?.id ?? intent.bindingId,
      intentId: routedIntent.id,
    });
    if (
      binding &&
      result.channel === binding.channel.channel &&
      isPermanentMessagingTargetFailure(result)
    ) {
      await this.options.store.revokeBinding({
        bindingId: binding.id,
        revokedAt: this.now(),
      });
      this.logger.debug?.("messaging binding revoked after permanent delivery failure", {
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

  private filterBindingsForChannel(
    bindings: MessagingBindingRecord[],
  ): MessagingBindingRecord[] {
    if (!this.options.channel) {
      return bindings;
    }
    return bindings.filter((binding) => binding.channel.channel === this.options.channel);
  }

  private isChannelInScope(channel: MessagingBindingRecord["channel"] | undefined): boolean {
    return !this.options.channel || channel?.channel === this.options.channel;
  }

  private withRoutingAudit(
    intent: MessagingSurfaceIntent,
    binding?: MessagingBindingRecord,
    event?: MessagingInboundEvent,
  ): MessagingSurfaceIntent {
    if (intent.audit || (!binding && !event)) {
      return intent;
    }

    const channel = binding?.channel ?? event?.channel;
    if (!channel) {
      return intent;
    }

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
        now: this.now(),
        threadId: binding?.threadId,
      }),
      ...(intent.targetSurface
        ? { targetSurface: intent.targetSurface }
        : event?.routingState
          ? {
              targetSurface: {
                channel: channel.channel,
                id: event.id,
                state: event.routingState,
              },
            }
          : {}),
    };
  }

  private isAuthorized(platformUserId: string): boolean {
    return this.authorizedActorIds.has(platformUserId);
  }

  private newIntentId(prefix: string): string {
    return `${prefix}:${randomUUID()}`;
  }
}

function readCommandAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  const match = /^command:([a-z0-9_-]+)$/i.exec(actionId);
  return match?.[1]?.toLowerCase();
}

function readBrowseAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  return actionId.startsWith("browse:") ? actionId : undefined;
}

function readStatusAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  return actionId.startsWith("status:") ? actionId : undefined;
}

function normalizeConversationTitle(title: string | undefined): string | undefined {
  const normalized = title?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function conversationKindLabel(kind: MessagingBindingRecord["channel"]["conversation"]["kind"]): string {
  switch (kind) {
    case "topic":
      return "topic";
    case "thread":
      return "thread";
    case "channel":
      return "channel";
    case "dm":
      return "conversation";
  }
}

function threadIdForBackendEvent(event: AgentEvent): ThreadIdentifier | undefined {
  const params = event.notification.params as { threadId?: unknown };
  return typeof params.threadId === "string" ? params.threadId : undefined;
}

function assistantTextForBackendEvent(event: AgentEvent): string | undefined {
  if (event.notification.method === "item/completed") {
    const params = event.notification.params as {
      item?: {
        text?: unknown;
        type?: unknown;
      };
    };
    if (params.item?.type !== "agentMessage" || typeof params.item.text !== "string") {
      return undefined;
    }
    return params.item.text.trim() || undefined;
  }

  if (event.notification.method === "turn/completed") {
    const params = event.notification.params as {
      turn?: {
        output?: unknown;
      };
    };
    if (!Array.isArray(params.turn?.output)) {
      return undefined;
    }
    const text = params.turn.output
      .map((item) =>
        item && typeof item === "object" && "text" in item
          ? (item as { text?: unknown }).text
          : undefined,
      )
      .filter((value): value is string => typeof value === "string")
      .join("\n\n")
      .trim();
    return text || undefined;
  }

  return undefined;
}

function compactLogPreview(text: string, limit = 96): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const preview = compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
  return preview.replace(/["\\]/g, "\\$&");
}

function isPermanentMessagingTargetFailure(result: MessagingDeliveryResult): boolean {
  return (
    result.outcome === "failed" &&
    Boolean(result.errorMessage?.match(/\bUnknown Channel\b|chat not found/i))
  );
}

function assistantMessageDeliveryKey(event: AgentEvent, text: string): string {
  const params = event.notification.params as {
    threadId?: unknown;
    turn?: { id?: unknown };
    turnId?: unknown;
  };
  const threadId = typeof params.threadId === "string" ? params.threadId : "";
  const turnId =
    typeof params.turnId === "string"
      ? params.turnId
      : typeof params.turn?.id === "string"
        ? params.turn.id
        : "";
  return [
    event.backend,
    threadId,
    turnId,
    createHash("sha256").update(text).digest("base64url"),
  ].join("\0");
}

function isThreadStatusIdleEvent(event: AgentEvent): boolean {
  if (event.notification.method !== "thread/status/changed") {
    return false;
  }
  const params = event.notification.params as {
    status?: {
      type?: unknown;
    };
  };
  return params.status?.type === "idle";
}

function turnLifecycleForBackendEvent(
  event: AgentEvent,
  now: number,
): MessagingActiveTurnSummary | undefined {
  switch (event.notification.method) {
    case "turn/started": {
      const params = event.notification.params as TurnLifecycleParams;
      const turnId = params.turnId ?? params.turn?.id;
      if (!turnId) {
        return undefined;
      }
      return {
        turnId,
        status: "working",
        startedAt: params.turn?.startedAt ?? undefined,
        updatedAt: now,
      };
    }
    case "turn/completed": {
      const params = event.notification.params as TurnLifecycleParams;
      const turnId = params.turnId ?? params.turn?.id;
      if (!turnId) {
        return undefined;
      }
      return {
        turnId,
        status: "completed",
        startedAt: params.turn?.startedAt ?? undefined,
        updatedAt: now,
      };
    }
    case "turn/failed": {
      const params = event.notification.params as TurnLifecycleParams;
      const turnId = params.turnId ?? params.turn?.id;
      if (!turnId) {
        return undefined;
      }
      return {
        turnId,
        status: "failed",
        startedAt: params.turn?.startedAt ?? undefined,
        updatedAt: now,
      };
    }
    case "turn/cancelled": {
      const params = event.notification.params as TurnLifecycleParams;
      const turnId = params.turnId ?? params.turn?.id;
      if (!turnId) {
        return undefined;
      }
      return {
        turnId,
        status: "interrupted",
        startedAt: params.turn?.startedAt ?? undefined,
        updatedAt: now,
      };
    }
    default:
      return undefined;
  }
}

type TurnLifecycleParams = {
  turnId?: string | null;
  turn?: {
    id?: string | null;
    startedAt?: number | null;
  };
};

function parseTextCommand(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  return trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase();
}

function parseTextCommandArgs(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return [];
  }

  return trimmed.slice(1).split(/\s+/).slice(1).filter(Boolean);
}

function readBindingTarget(
  event: MessagingInboundCallbackEvent,
): { backend: AppServerBackendKind; threadId: ThreadIdentifier } | undefined {
  const fromValue = readBindingTargetFromValue(event.value);
  if (fromValue) {
    return fromValue;
  }

  const actionId = event.actionId ?? event.interaction.id;
  const match = /^bind:(codex|grok):(.+)$/.exec(actionId);
  if (!match) {
    return undefined;
  }

  return {
    backend: match[1] as AppServerBackendKind,
    threadId: match[2]!,
  };
}

function readBindingTargetFromValue(
  value: MessagingJsonValue | undefined,
): { backend: AppServerBackendKind; threadId: ThreadIdentifier } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const backend = value.backend;
  const threadId = value.threadId;
  if ((backend === "codex" || backend === "grok") && typeof threadId === "string") {
    return {
      backend,
      threadId,
    };
  }

  return undefined;
}

function readStringValue(
  value: MessagingJsonValue | undefined,
  key: string,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result = value[key];
  return typeof result === "string" ? result : undefined;
}
