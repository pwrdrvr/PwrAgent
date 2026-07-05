import type {
  AutomationInboundMessageTriggerDefinition,
  AutomationRunSourceMetadata,
} from "@pwragent/shared";
import type { MessagingInboundEvent } from "@pwragent/messaging-interface";
import type { AutomationRecord } from "./automation-store.js";

const MAX_SOURCE_TEXT_CHARS = 4_000;

export type AutomationInboundTriggerMatch = {
  automation: AutomationRecord;
  source: AutomationRunSourceMetadata;
  trigger: AutomationInboundMessageTriggerDefinition;
};

export function matchAutomationInboundEvent(params: {
  automations: AutomationRecord[];
  event: MessagingInboundEvent;
}): AutomationInboundTriggerMatch[] {
  if (params.event.kind !== "text" && params.event.kind !== "media") {
    return [];
  }

  const matches: AutomationInboundTriggerMatch[] = [];
  for (const automation of params.automations) {
    if (automation.status !== "enabled") continue;
    for (const trigger of automation.triggers) {
      if (trigger.kind !== "inbound_message") continue;
      if (!matchesInboundTrigger(trigger, params.event)) continue;
      matches.push({
        automation,
        trigger,
        source: buildRunSourceMetadata({
          event: params.event,
          trigger,
        }),
      });
    }
  }
  return matches;
}

/**
 * Existence-only variant of {@link matchAutomationInboundEvent}: returns true on
 * the first matching trigger without building the (potentially 4k-bounded) run
 * source metadata. Used on the @mention-only ambient hot path, where the runtime
 * only needs a boolean to decide whether to deliver the message.
 */
export function anyAutomationInboundMatch(params: {
  automations: AutomationRecord[];
  event: MessagingInboundEvent;
}): boolean {
  if (params.event.kind !== "text" && params.event.kind !== "media") {
    return false;
  }
  for (const automation of params.automations) {
    if (automation.status !== "enabled") continue;
    for (const trigger of automation.triggers) {
      if (trigger.kind !== "inbound_message") continue;
      if (matchesInboundTrigger(trigger, params.event)) return true;
    }
  }
  return false;
}

function matchesInboundTrigger(
  trigger: AutomationInboundMessageTriggerDefinition,
  event: Extract<MessagingInboundEvent, { kind: "text" | "media" }>,
): boolean {
  if (event.channel.channel !== trigger.conversation.channel) return false;
  const conversation = event.channel.conversation;
  const expectedConversationId = trigger.conversation.conversationId;
  const matchesConversation =
    conversation.id === expectedConversationId
    || conversation.parentId === expectedConversationId;
  if (!matchesConversation) return false;
  if (
    conversation.kind === "thread"
    && !trigger.includeThreadReplies
    && conversation.id !== expectedConversationId
  ) {
    return false;
  }

  if (trigger.sender?.platformUserId) {
    if (event.actor.platformUserId !== trigger.sender.platformUserId)
      return false;
  }
  if (trigger.sender?.isBot !== undefined) {
    if (Boolean(event.actor.isBot) !== trigger.sender.isBot) return false;
  }

  if (trigger.textFilter) {
    const text = event.kind === "text" ? event.text : (event.text ?? "");
    if (!matchesTextFilter(text, trigger.textFilter)) return false;
  }

  return true;
}

function matchesTextFilter(
  value: string,
  filter: AutomationInboundMessageTriggerDefinition["textFilter"],
): boolean {
  if (!filter?.text) return false;
  const left = filter.caseSensitive ? value : value.toLowerCase();
  const right = filter.caseSensitive ? filter.text : filter.text.toLowerCase();
  if (filter.mode === "equals") return left === right;
  return left.includes(right);
}

function buildRunSourceMetadata(params: {
  event: Extract<MessagingInboundEvent, { kind: "text" | "media" }>;
  trigger: AutomationInboundMessageTriggerDefinition;
}): AutomationRunSourceMetadata {
  const text =
    params.event.kind === "text" ? params.event.text : params.event.text;
  const bounded = boundSourceText(text);
  return {
    kind: "messaging",
    eventId: params.event.id,
    sourceEventKey: buildSourceEventKey(params.event),
    receivedAt: params.event.receivedAt,
    matchedTriggerId: params.trigger.id,
    matchedTriggerName: params.trigger.name,
    actor: {
      platformUserId: params.event.actor.platformUserId,
      displayName: params.event.actor.displayName,
      username: params.event.actor.username,
      isBot: params.event.actor.isBot,
    },
    conversation: {
      channel: params.event.channel.channel,
      conversationId: params.event.channel.conversation.id,
      conversationKind: params.event.channel.conversation.kind,
      parentId: params.event.channel.conversation.parentId,
      title: params.event.channel.conversation.title,
      parentTitle: params.event.channel.conversation.parentTitle,
      ancestorTitle: params.event.channel.conversation.ancestorTitle,
    },
    ...(bounded
      ? {
          message: {
            text: bounded.text,
            textTruncated: bounded.truncated,
          },
        }
      : {}),
    ...(params.event.routingState
      ? {
          routingState: params.event.routingState as unknown as Record<
            string,
            unknown
          >,
        }
      : {}),
  };
}

function boundSourceText(
  text: string | undefined,
): { text: string; truncated?: boolean } | undefined {
  if (!text) return undefined;
  if (text.length <= MAX_SOURCE_TEXT_CHARS) return { text };
  return {
    text: `${text.slice(0, MAX_SOURCE_TEXT_CHARS)}\n[truncated]`,
    truncated: true,
  };
}

export function buildSourceEventKey(event: MessagingInboundEvent): string {
  const opaque = event.routingState?.opaque;
  const routing =
    opaque && typeof opaque === "object" && !Array.isArray(opaque)
      ? (opaque as Record<string, unknown>)
      : {};
  const channelId =
    stringValue(routing.channelId) ?? event.channel.conversation.id;
  const messageId =
    stringValue(routing.ts)
    ?? stringValue(routing.messageId)
    ?? stringValue(routing.eventTs)
    ?? event.id;
  const threadRoot =
    stringValue(routing.threadTs) ?? event.channel.conversation.parentId ?? "";
  return [
    event.channel.channel,
    channelId,
    messageId,
    threadRoot,
    event.actor.platformUserId,
  ].join(":");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
