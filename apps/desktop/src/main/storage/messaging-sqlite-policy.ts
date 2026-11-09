import type { SqliteMessagingPolicy } from "@pwragent/sqlite-storage/messaging-store-sqlite";
import type { DesktopMessagingStorageRecords } from "../messaging/core/messaging-storage.js";
import type {
  MessagingAdapterState,
  MessagingBindingRecord,
  MessagingBrowseSessionRecord,
  MessagingCallbackHandleRecord,
  MessagingChannelRef,
  MessagingDefaultAgentAssignmentRecord,
  MessagingDefaultAgentScope,
  MessagingJsonValue,
  MessagingManagedTopicRecord,
  MessagingMonitorSubscriptionRecord,
  MessagingPendingIntentRecord,
} from "@pwragent/messaging-interface";
import {
  normalizeMessagingBindingTargetKind,
} from "@pwragent/shared";
import type {
  MessagingDeliveryRecord,
} from "../messaging/core/messaging-migrations.js";
import {
  CURRENT_MESSAGING_STORE_VERSION,
  migrateMessagingDefaultAgentAssignmentRecord,
} from "../messaging/core/messaging-migrations.js";
import {
  buildDefaultAgentScopeLookup,
  buildMessagingDefaultAgentScopeKey,
} from "../messaging/core/messaging-default-agent.js";
import {
  mergeMessagingBindingChannelMetadata,
  mergeMessagingManagedTopicObservation,
} from "../messaging/core/messaging-store-merge.js";
import { isBindingForThread } from "../messaging/core/messaging-binding-thread-match.js";
import { isAsyncQuestionnaireForThread } from "../messaging/core/messaging-pending-intent-match.js";

const SECRET_KEY_PATTERN = /token|secret|password|authorization|api[_-]?key/i;

export const messagingSqlitePolicy: SqliteMessagingPolicy<DesktopMessagingStorageRecords> = {
  sanitizeBinding,
  sanitizeDefaultAgentAssignment,
  sanitizeMonitorSubscription,
  sanitizeManagedTopic,
  sanitizePendingIntent,
  sanitizeBrowseSession,
  sanitizeCallbackHandle,
  sanitizeDelivery,
  buildMessagingConversationKey,
  buildMessagingConversationLookupKeys,
  buildChannelId,
  buildMessagingDefaultAgentScopeKey,
  buildDefaultAgentScopeLookup,
  channelKindForDefaultAgentScope,
  parseDefaultAgentAssignment,
  mergeMessagingBindingChannelMetadata,
  mergeMessagingManagedTopicObservation,
  isBindingForThread,
  isAsyncQuestionnaireForThread,
  observeSurface(current, channel, observedAt) {
    return {
      channel: mergeObservedChannel(current?.channel, channel),
      firstSeenAt: Math.min(current?.firstSeenAt ?? observedAt, observedAt),
      lastSeenAt: Math.max(current?.lastSeenAt ?? observedAt, observedAt),
    };
  },
  bindingMetadataResult(binding, changed) { return { binding, changed }; },
  managedTopicResult(topic, changed) { return { topic, changed }; },
  snapshot(records) { return { version: CURRENT_MESSAGING_STORE_VERSION, ...records }; },
};

export function buildMessagingConversationKey(
  channel: MessagingChannelRef,
): string {
  return [
    channel.channel,
    channel.conversation.kind,
    channel.conversation.parentId ?? "",
    channel.conversation.id,
  ].join(":");
}

function buildMessagingConversationLookupKeys(
  channel: MessagingChannelRef,
): string[] {
  const keys = new Set<string>([buildMessagingConversationKey(channel)]);
  if (channel.conversation.kind === "thread") {
    keys.add(buildMessagingConversationKey({
      channel: channel.channel,
      conversation: {
        ...channel.conversation,
        kind: "channel",
      },
    }));
    // DM-only. Slack thread refs carry `id = channelId`, so a parentId-less
    // `channel` root key would equal the parent channel's own binding key
    // and every side thread in a bound channel would resolve to it — which
    // makes `/bind` inside such a thread revoke the channel's binding.
    if (channel.conversation.isDirectMessage) {
      keys.add(buildMessagingConversationKey({
        channel: channel.channel,
        conversation: {
          id: channel.conversation.id,
          kind: "dm",
        },
      }));
    }
    if (
      channel.conversation.parentConversationId
      && channel.conversation.parentConversationId !== channel.conversation.id
    ) {
      // Reconstruct the parent's own key the way `messaging-default-agent`
      // does: providers such as Discord store the parent channel under its
      // guild `parentId`, so dropping it never matches.
      keys.add(buildMessagingConversationKey({
        channel: channel.channel,
        conversation: {
          id: channel.conversation.parentConversationId,
          kind: channel.conversation.isDirectMessage ? "dm" : "channel",
          ...(channel.conversation.parentConversationParentId
            ? { parentId: channel.conversation.parentConversationParentId }
            : {}),
        },
      }));
    }
  }
  return [...keys];
}

function buildChannelId(channel: MessagingChannelRef): string {
  return [
    channel.conversation.kind,
    channel.conversation.parentId ?? "",
    channel.conversation.id,
  ].join(":");
}

function sanitizeBinding(
  binding: MessagingBindingRecord,
): MessagingBindingRecord {
  const { activeTurn: _activeTurn, threadDisplay: _threadDisplay, ...rest } =
    binding;
  return {
    ...rest,
    authorizedActorIds: [...new Set(binding.authorizedActorIds)],
    monitorSurface: sanitizeSurfaceRef(binding.monitorSurface),
    pinnedStatusSurface: sanitizeSurfaceRef(binding.pinnedStatusSurface),
    privateReplyContinuation: binding.privateReplyContinuation
      ? {
          ...binding.privateReplyContinuation,
          source: {
            ...binding.privateReplyContinuation.source,
            authorizedActorIds: [
              ...new Set(binding.privateReplyContinuation.source.authorizedActorIds),
            ],
            channel: structuredClone(
              binding.privateReplyContinuation.source.channel,
            ),
            routingState: sanitizeAdapterState(
              binding.privateReplyContinuation.source.routingState,
            ),
          },
        }
      : undefined,
    routingState: sanitizeAdapterState(binding.routingState),
    statusSurface: sanitizeSurfaceRef(binding.statusSurface),
    targetKind: normalizeMessagingBindingTargetKind(binding.targetKind),
  };
}

function mergeObservedChannel(
  current: MessagingChannelRef | undefined,
  next: MessagingChannelRef,
): MessagingChannelRef {
  const conversation = {
    ...current?.conversation,
    id: next.conversation.id,
    kind: next.conversation.kind,
  };
  for (const key of [
    "ancestorTitle",
    "parentConversationId",
    "parentConversationParentId",
    "parentId",
    "parentTitle",
    "title",
    "workspaceId",
  ] as const) {
    const value = next.conversation[key];
    if (value !== undefined) conversation[key] = value;
  }
  return {
    channel: next.channel,
    conversation,
  };
}

function parseDefaultAgentAssignment(
  payload: string,
): MessagingDefaultAgentAssignmentRecord | undefined {
  try {
    return migrateMessagingDefaultAgentAssignmentRecord(JSON.parse(payload));
  } catch {
    return undefined;
  }
}

function sanitizeDefaultAgentAssignment(
  assignment: MessagingDefaultAgentAssignmentRecord,
): MessagingDefaultAgentAssignmentRecord {
  return {
    ...assignment,
    scope: assignment.scope.kind === "conversation"
      ? {
          ...assignment.scope,
          channel: {
            ...assignment.scope.channel,
            conversation: { ...assignment.scope.channel.conversation },
          },
        }
      : { ...assignment.scope },
    target: { ...assignment.target },
  };
}

function channelKindForDefaultAgentScope(
  scope: MessagingDefaultAgentScope,
): string | null {
  if (scope.kind === "profile") {
    return null;
  }
  return scope.kind === "conversation" ? scope.channel.channel : scope.channel;
}

function sanitizePendingIntent(
  intent: MessagingPendingIntentRecord,
): MessagingPendingIntentRecord {
  return {
    ...intent,
    allowedActorIds: [...new Set(intent.allowedActorIds)],
    intent: sanitizeJsonValue(
      intent.intent as unknown as MessagingJsonValue,
    ) as unknown as MessagingPendingIntentRecord["intent"],
    surface: sanitizeSurfaceRef(intent.surface),
  };
}

function sanitizeMonitorSubscription(
  subscription: MessagingMonitorSubscriptionRecord,
): MessagingMonitorSubscriptionRecord {
  return {
    ...subscription,
    authorizedActorIds: [...new Set(subscription.authorizedActorIds)],
    monitorSurface: sanitizeSurfaceRef(subscription.monitorSurface),
  };
}

function sanitizeManagedTopic(
  topic: MessagingManagedTopicRecord,
): MessagingManagedTopicRecord {
  return {
    ...topic,
    authorizedActorIds: [...new Set(topic.authorizedActorIds)],
    routingState: sanitizeAdapterState(topic.routingState),
  };
}

function sanitizeBrowseSession(
  session: MessagingBrowseSessionRecord,
): MessagingBrowseSessionRecord {
  return {
    ...session,
    allowedActorIds: [...new Set(session.allowedActorIds)],
    surface: sanitizeSurfaceRef(session.surface),
  };
}

function sanitizeCallbackHandle(
  handle: MessagingCallbackHandleRecord,
): MessagingCallbackHandleRecord {
  return {
    ...handle,
    allowedActorIds: [...new Set(handle.allowedActorIds)],
    surface: sanitizeSurfaceRef(handle.surface),
    value:
      handle.value === undefined ? undefined : sanitizeJsonValue(handle.value),
  };
}

function sanitizeDelivery(
  delivery: MessagingDeliveryRecord,
): MessagingDeliveryRecord {
  return {
    ...delivery,
    surface: sanitizeSurfaceRef(
      (delivery as unknown as Record<string, unknown>).surface as
        | { state?: MessagingAdapterState }
        | undefined,
    ) as unknown as MessagingDeliveryRecord["surface"],
  };
}

function sanitizeSurfaceRef<T extends { state?: MessagingAdapterState }>(
  surface: T | undefined,
): T | undefined {
  if (!surface) return undefined;
  return { ...surface, state: sanitizeAdapterState(surface.state) };
}

function sanitizeAdapterState(
  state: MessagingAdapterState | undefined,
): MessagingAdapterState | undefined {
  if (!state) return undefined;
  return { opaque: sanitizeJsonValue(state.opaque) };
}

function sanitizeJsonValue(value: MessagingJsonValue): MessagingJsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        SECRET_KEY_PATTERN.test(key)
          ? "[REDACTED]"
          : sanitizeJsonValue(entryValue),
      ]),
    );
  }
  return value;
}
