import type { MessagingChannelRef, MessagingInboundEvent } from "@pwragent/messaging-interface";

export function messagingDestinationIdentity(channel: MessagingChannelRef): string {
  const c = channel.conversation;
  return JSON.stringify([channel.channel, c.workspaceId ?? null, c.kind, c.id,
    c.parentId ?? null, c.parentConversationId ?? null]);
}

function routingSnapshot(event: MessagingInboundEvent): MessagingInboundEvent {
  // Retaining the complete inbound event would copy user text and attachment data
  // at every delegation. Only this bounded routing snapshot belongs in provenance.
  const snapshot: MessagingInboundEvent = {
    id: event.id,
    kind: "lifecycle",
    lifecycle: "bound",
    actor: { platformUserId: event.actor.platformUserId, isBot: false },
    channel: event.channel,
    receivedAt: event.receivedAt,
    routingState: event.routingState,
    sourceSurface: event.sourceSurface,
  };
  const json = JSON.stringify(snapshot, (key, value: unknown) =>
    /token|secret|password|authorization|api[_-]?key/i.test(key) ? undefined : value);
  if (Buffer.byteLength(json) > 16 * 1024) throw new Error("Messaging source routing exceeds 16 KiB.");
  return JSON.parse(json) as MessagingInboundEvent;
}

// Messaging admission and routing privacy stay with the host. SQLite only
// indexes this projection and persists its bounded, opaque event payload.
export function projectMessagingRequest(input: MessagingInboundEvent) {
  if (input.actor.isBot || input.observedOnly
    || !["text", "media", "command", "callback"].includes(input.kind)) return undefined;
  const event = routingSnapshot(input);
  return {
    event,
    eventId: event.id,
    platform: event.channel.channel,
    workspaceId: event.channel.conversation.workspaceId,
    actorId: event.actor.platformUserId,
    destinationIdentity: messagingDestinationIdentity(event.channel),
    receivedAt: event.receivedAt,
  };
}
