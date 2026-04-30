import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AppServerBackendKind,
  AppServerPendingRequestNotification,
  AppServerToolRequestUserInputNotification,
  MessagingBindingRecord,
  MessagingInboundCallbackEvent,
  MessagingInboundCommandEvent,
  MessagingInboundEvent,
  MessagingInboundTextEvent,
  MessagingJsonValue,
  MessagingMessageIntent,
  MessagingPendingIntentRecord,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
  ThreadIdentifier,
} from "@pwragnt/shared";
import { MessagingStore, buildMessagingConversationKey } from "./messaging-store.js";
import type { MessagingAdapter, MessagingBackendBridge } from "./messaging-adapter.js";
import {
  buildApprovalIntent,
  buildConfirmationIntent,
  buildErrorIntent,
  buildQuestionnaireIntent,
  buildStatusIntent,
  buildThreadPickerIntent,
} from "./messaging-renderer.js";
import { buildMessagingAuditContext } from "./messaging-audit.js";
import { DeterministicInteractionMapper } from "./deterministic-interaction-mapper.js";
import { actionsForIntent } from "./deterministic-interaction-mapper.js";
import type { MessagingInteractionMapper } from "./interaction-mapper.js";

const DEFAULT_PICKER_PAGE_SIZE = 5;
const DEFAULT_PENDING_INTENT_TTL_MS = 15 * 60 * 1000;

export type MessagingControllerOptions = {
  adapter: MessagingAdapter;
  authorizedActorIds: string[];
  backend: MessagingBackendBridge;
  interactionMapper?: MessagingInteractionMapper;
  now?: () => number;
  pendingIntentTtlMs?: number;
  store: MessagingStore;
};

export class MessagingController {
  private readonly authorizedActorIds: Set<string>;
  private readonly now: () => number;
  private readonly pendingIntentTtlMs: number;
  private readonly interactionMapper: MessagingInteractionMapper;

  constructor(private readonly options: MessagingControllerOptions) {
    this.authorizedActorIds = new Set(options.authorizedActorIds);
    this.now = options.now ?? Date.now;
    this.pendingIntentTtlMs =
      options.pendingIntentTtlMs ?? DEFAULT_PENDING_INTENT_TTL_MS;
    this.interactionMapper = options.interactionMapper ?? new DeterministicInteractionMapper();
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
    if (event.notification.method !== "turn/completed") {
      return;
    }

    const bindings = await this.options.store.findActiveBindingsForThread({
      backend: event.backend,
      threadId: (
        event.notification.params as {
          threadId: ThreadIdentifier;
        }
      ).threadId,
    });
    const turn = (
      event.notification.params as {
        turn: {
          output: Array<{ text?: string }>;
        };
      }
    ).turn;
    const text = turn.output
      .map((item) => item.text ?? "")
      .join("\n\n")
      .trim();
    if (!text) {
      return;
    }

    for (const binding of bindings) {
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
  }

  async handleBackendPendingRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
  ): Promise<void> {
    const bindings = await this.options.store.findActiveBindingsForThread({
      backend,
      threadId: request.params.threadId,
    });

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
      await this.storePendingIntent(intent, binding);
      await this.deliver(intent, binding);
    }
  }

  private async handleCommand(event: MessagingInboundCommandEvent): Promise<void> {
    const command = event.command.replace(/^\//, "").toLowerCase();
    if (command === "threads" || command === "thread" || command === "bind") {
      await this.presentThreadPicker(event);
      return;
    }

    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("help"),
        createdAt: this.now(),
        title: "PwrAgnt",
        body: "Use /threads to choose a thread to control from this conversation.",
        actions: [
          {
            id: "command:threads",
            label: "Threads",
            style: "primary",
            fallbackText: "/threads",
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
        args: [],
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
          fallbackText: "Reply /threads to choose a thread.",
          actions: [
            {
              id: "command:threads",
              label: "Threads",
              style: "primary",
              fallbackText: "/threads",
            },
          ],
        }),
        undefined,
        event,
      );
      return;
    }

    await this.options.backend.startTurn({
      backend: binding.backend,
      threadId: binding.threadId,
      input: [
        {
          type: "text",
          text: event.text,
        },
      ],
    });
    await this.deliver(
      buildStatusIntent({
        id: this.newIntentId("turn-started"),
        createdAt: this.now(),
        status: "working",
        text: "Sent to thread.",
      }),
      binding,
    );
  }

  private async handleCallback(event: MessagingInboundCallbackEvent): Promise<void> {
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

    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("expired-callback"),
        createdAt: this.now(),
        title: "Action expired",
        body: "That action is no longer available. Use /threads to refresh.",
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

  private async presentThreadPicker(event: MessagingInboundEvent): Promise<void> {
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const actions = navigation.threads
      .slice(0, DEFAULT_PICKER_PAGE_SIZE)
      .map((thread, index): MessagingSurfaceAction => ({
        id: `bind:${thread.source}:${thread.id}`,
        label: `${index + 1}. ${thread.title}`,
        style: "primary",
        fallbackText: String(index + 1),
        value: {
          backend: thread.source,
          threadId: thread.id,
        },
      }));
    if (navigation.threads.length > DEFAULT_PICKER_PAGE_SIZE) {
      actions.push({
        id: "page:next",
        label: "Next",
        style: "navigation",
        fallbackText: "next",
      });
    }

    const intent = buildThreadPickerIntent({
      id: this.newIntentId("thread-picker"),
      createdAt: this.now(),
      fallbackText: "Reply with a number to bind, or Next for more threads.",
      navigation,
      pageSize: DEFAULT_PICKER_PAGE_SIZE,
      actions,
    });
    await this.storePendingIntent(intent, undefined, event);
    await this.deliver(intent, undefined, event);
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
  ): Promise<void> {
    const routedIntent = this.withRoutingAudit(intent, binding, event);
    const result = await this.options.adapter.deliver(routedIntent);
    await this.options.store.recordDelivery({
      ...result,
      id: `delivery:${routedIntent.id}:${randomUUID()}`,
      bindingId: binding?.id ?? intent.bindingId,
      intentId: routedIntent.id,
    });
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
    };
  }

  private isAuthorized(platformUserId: string): boolean {
    return this.authorizedActorIds.has(platformUserId);
  }

  private newIntentId(prefix: string): string {
    return `${prefix}:${randomUUID()}`;
  }
}

function parseTextCommand(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  return trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase();
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
