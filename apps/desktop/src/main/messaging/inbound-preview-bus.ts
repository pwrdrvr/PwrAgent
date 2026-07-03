import type { InboundPreviewMessage } from "@pwragent/shared";
import type { MessagingInboundEvent } from "@pwragent/messaging-interface";

/**
 * Going-forward live preview of inbound messages for the Automations editor.
 *
 * The editor registers a scope (provider + conversation, optionally a group
 * parent) while the operator is configuring a trigger. As authorized inbound
 * text/media events flow through the messaging controller, matching ones are
 * forwarded to the renderer so the operator can see which messages their
 * filter would catch. There is no history backfill — only messages that
 * arrive while a preview scope is active are surfaced.
 */
export type InboundPreviewScope = {
  conversationId: string;
  parentId?: string;
  provider: string;
};

const MAX_PREVIEW_TEXT_CHARS = 600;

const activeScopes = new Map<string, InboundPreviewScope>();
let sink: ((message: InboundPreviewMessage) => void) | undefined;

/** Wire the transport that pushes preview messages to renderer windows. */
export function setInboundPreviewSink(
  next: ((message: InboundPreviewMessage) => void) | undefined,
): void {
  sink = next;
}

export function startInboundPreview(
  subscriptionId: string,
  scope: InboundPreviewScope,
): void {
  activeScopes.set(subscriptionId, scope);
}

export function stopInboundPreview(subscriptionId: string): void {
  activeScopes.delete(subscriptionId);
}

export function hasActiveInboundPreview(): boolean {
  return activeScopes.size > 0;
}

/** Test/lifecycle helper. */
export function resetInboundPreview(): void {
  activeScopes.clear();
  sink = undefined;
}

/**
 * Publish an inbound event to any active preview scope it matches. Cheap and
 * silent when no preview is open. Only text/media events carry useful preview
 * content; the caller is expected to gate on that.
 */
export function publishInboundPreview(event: MessagingInboundEvent): void {
  if (activeScopes.size === 0 || !sink) return;
  if (event.kind !== "text" && event.kind !== "media") return;
  if (!matchesAnyScope(event)) return;
  sink(toPreviewMessage(event));
}

function matchesAnyScope(
  event: Extract<MessagingInboundEvent, { kind: "text" | "media" }>,
): boolean {
  const conversation = event.channel.conversation;
  for (const scope of activeScopes.values()) {
    if (scope.provider !== event.channel.channel) continue;
    if (
      conversation.id === scope.conversationId ||
      conversation.parentId === scope.conversationId
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Map an inbound event to the compact preview shape. Returns undefined for
 * non-text/media events (callbacks, commands) which have no preview content.
 * Exported for history backfill, which reuses the same mapping.
 */
export function inboundEventToPreviewMessage(
  event: MessagingInboundEvent,
): InboundPreviewMessage | undefined {
  if (event.kind !== "text" && event.kind !== "media") return undefined;
  return toPreviewMessage(event);
}

function toPreviewMessage(
  event: Extract<MessagingInboundEvent, { kind: "text" | "media" }>,
): InboundPreviewMessage {
  const rawText = event.kind === "text" ? event.text : event.text ?? "";
  const text =
    rawText.length > MAX_PREVIEW_TEXT_CHARS
      ? `${rawText.slice(0, MAX_PREVIEW_TEXT_CHARS)}…`
      : rawText;
  return {
    id: event.id,
    provider: event.channel.channel,
    conversationId: event.channel.conversation.id,
    ...(event.channel.conversation.parentId
      ? { parentId: event.channel.conversation.parentId }
      : {}),
    receivedAt: event.receivedAt,
    actor: {
      platformUserId: event.actor.platformUserId,
      ...(event.actor.displayName ? { displayName: event.actor.displayName } : {}),
      ...(event.actor.isBot !== undefined ? { isBot: event.actor.isBot } : {}),
    },
    text,
  };
}
