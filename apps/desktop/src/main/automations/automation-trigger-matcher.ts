import {
  evaluateAutomationInboundConditions,
  normalizeInboundTriggerConditions,
} from "@pwragent/shared";
import type {
  AutomationInboundMessageTriggerDefinition,
  AutomationReplayCandidate,
  AutomationRunSourceMetadata,
  InboundPreviewMessage,
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
    conversation.id === expectedConversationId ||
    conversation.parentId === expectedConversationId;
  if (!matchesConversation) return false;
  if (
    conversation.kind === "thread" &&
    !trigger.includeThreadReplies &&
    conversation.id !== expectedConversationId
  ) {
    return false;
  }

  return matchesConditionGroup(trigger, event);
}

function matchesConditionGroup(
  trigger: AutomationInboundMessageTriggerDefinition,
  event: Extract<MessagingInboundEvent, { kind: "text" | "media" }>,
): boolean {
  return evaluateAutomationInboundConditions(
    normalizeInboundTriggerConditions(trigger),
    {
      text: event.kind === "text" ? event.text : event.text ?? "",
      platformUserId: event.actor.platformUserId,
      ...(event.actor.isBot === undefined ? {} : { isBot: event.actor.isBot }),
    },
  );
}

function buildRunSourceMetadata(params: {
  event: Extract<MessagingInboundEvent, { kind: "text" | "media" }>;
  trigger: AutomationInboundMessageTriggerDefinition;
}): AutomationRunSourceMetadata {
  const text = params.event.kind === "text" ? params.event.text : params.event.text;
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
      ? { routingState: params.event.routingState as unknown as Record<string, unknown> }
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

/**
 * Judge recent conversation messages against a trigger's filter for the
 * Replay picker. Uses the same shared evaluator as live matching and the
 * editor preview, so a "matches" badge here is a promise about what the
 * trigger would actually have done.
 */
export function buildAutomationReplayCandidates(
  trigger: AutomationInboundMessageTriggerDefinition,
  messages: InboundPreviewMessage[],
): AutomationReplayCandidate[] {
  const group = normalizeInboundTriggerConditions(trigger);
  return messages.map((message) => ({
    message,
    matches: evaluateAutomationInboundConditions(group, {
      text: message.text,
      platformUserId: message.actor.platformUserId,
      ...(message.actor.isBot === undefined ? {} : { isBot: message.actor.isBot }),
    }),
  }));
}

/**
 * Source metadata for an operator-initiated replay of a captured message.
 *
 * The event key is namespaced with `replay:` plus a timestamp — never the
 * original key — because inbound dispatch dedupes on `sourceEventKey`, and a
 * replay run carrying the real key would make the scheduler treat a later
 * genuine delivery of that message as already handled.
 */
export function buildReplayRunSourceMetadata(params: {
  trigger: AutomationInboundMessageTriggerDefinition;
  message: InboundPreviewMessage;
  now?: number;
}): AutomationRunSourceMetadata {
  const { message, trigger } = params;
  const bounded = boundSourceText(message.text);
  return {
    kind: "messaging",
    eventId: message.id,
    sourceEventKey: `replay:${message.id}:${params.now ?? Date.now()}`,
    receivedAt: message.receivedAt,
    matchedTriggerId: trigger.id,
    matchedTriggerName: trigger.name,
    actor: {
      platformUserId: message.actor.platformUserId,
      ...(message.actor.displayName
        ? { displayName: message.actor.displayName }
        : {}),
      ...(message.actor.isBot ? { isBot: true } : {}),
    },
    conversation: {
      channel: message.provider,
      conversationId: message.conversationId,
      ...(message.parentId ? { parentId: message.parentId } : {}),
      ...(trigger.conversation.conversationId === message.conversationId
        && trigger.conversation.title
        ? { title: trigger.conversation.title }
        : {}),
    },
    ...(bounded
      ? { message: { text: bounded.text, textTruncated: bounded.truncated } }
      : {}),
  };
}

export function buildSourceEventKey(event: MessagingInboundEvent): string {
  const opaque = event.routingState?.opaque;
  const routing =
    opaque && typeof opaque === "object" && !Array.isArray(opaque)
      ? (opaque as Record<string, unknown>)
      : {};
  const channelId = stringValue(routing.channelId) ?? event.channel.conversation.id;
  const messageId =
    stringValue(routing.ts) ??
    stringValue(routing.messageId) ??
    stringValue(routing.eventTs) ??
    event.id;
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
