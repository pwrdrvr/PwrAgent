import { matchesAutomationConversation } from "@pwragent/shared";
import type { InboundPreviewMessage, StartInboundPreviewRequest } from "@pwragent/shared";
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
export type InboundPreviewScope = Omit<StartInboundPreviewRequest, "subscriptionId">;

const MAX_PREVIEW_TEXT_CHARS = 600;

const activeScopes = new Map<string, InboundPreviewScope>();
let sink: ((message: InboundPreviewMessage) => void) | undefined;
const scopeListeners = new Set<() => void>();

function notifyScopesChanged(): void {
  for (const listener of scopeListeners) listener();
}

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
  notifyScopesChanged();
}

export function stopInboundPreview(subscriptionId: string): void {
  if (activeScopes.delete(subscriptionId)) notifyScopesChanged();
}

/** Called whenever a preview opens or closes. Returns an unsubscribe. */
export function onInboundPreviewScopesChanged(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => {
    scopeListeners.delete(listener);
  };
}

/**
 * Shared conversations an open preview is watching on one platform, for the
 * adapters' observed sets. Without this, a preview only ever showed senders on
 * the actor allowlist: an adapter forwards everyone else's messages only in
 * conversations an ENABLED automation watches, so previewing `#alerts` before
 * saving showed nothing from the alert bot the automation exists to catch.
 *
 * A contact-DM preview contributes nothing. A 1:1 DM is gated by who the
 * sender is, not by which conversation it is in, and observing the contact's
 * user ID would widen nothing an operator could see.
 */
export function activeInboundPreviewConversationIds(
  provider: InboundPreviewScope["provider"],
): string[] {
  const ids = new Set<string>();
  for (const scope of activeScopes.values()) {
    if (scope.provider !== provider || scope.recipientUserId) continue;
    ids.add(scope.conversationId);
    if (scope.parentId) ids.add(scope.parentId);
  }
  return [...ids];
}

export function hasActiveInboundPreview(): boolean {
  return activeScopes.size > 0;
}

/**
 * Test/lifecycle helper. Clears scopes and the sink, not scope-change
 * listeners: those belong to their subscribers, who unsubscribe themselves.
 * The messaging runtime subscribes once per start, so clearing them here
 * would silently stop open previews from joining the observed sets.
 */
export function resetInboundPreview(): void {
  const hadScopes = activeScopes.size > 0;
  activeScopes.clear();
  sink = undefined;
  if (hadScopes) notifyScopesChanged();
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
    if (matchesAutomationConversation({ ...scope, channel: scope.provider }, {
      ...conversation,
      conversationId: conversation.id,
      conversationKind: conversation.kind,
      channel: event.channel.channel,
    }, event.actor.platformUserId)) return true;
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
    conversationKind: event.channel.conversation.kind,
    isDirectMessage: event.channel.conversation.isDirectMessage,
    parentConversationId: event.channel.conversation.parentConversationId,
    parentConversationParentId: event.channel.conversation.parentConversationParentId,
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
