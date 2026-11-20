import { type MonitorCommandAction } from "./messaging-command-helpers";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { federatedThreadIdentityKey } from "@pwragent/shared/contracts/federation";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { MessagingChannelKind, MessagingChannelRef, MessagingDeliveryResult, MessagingAdapterState, MessagingManagedConversationOperationSupport, MessagingManagedTopicRecord, MessagingMonitorState, MessagingTopicCleanupProposalItem } from "@pwragent/messaging-interface";
import { MESSAGING_MONITOR_DEFAULT_PINNED_THREAD_LIMIT, MESSAGING_MONITOR_DEFAULT_RECENT_THREAD_LIMIT, MESSAGING_MONITOR_INTERVAL_MS, nextMonitorIntervalMs, nextMonitorThreadLimit, normalizeMonitorIntervalMs, normalizeMonitorThreadLimit } from "./messaging-monitor-card.js";
import { buildMessagingConversationKey } from "./messaging-store.js";

export type MonitorStateOptions = Pick<
  MessagingMonitorState,
  | "intervalMs"
  | "pinnedThreadLimit"
  | "recentThreadLimit"
  | "showLastResponseSnippet"
  | "showStatusLine"
>;

export function federationTargetForThread(
  thread: NavigationThreadSummary,
): FederationTarget | undefined {
  return thread.federation?.ref.target.scope === "remote"
    ? thread.federation.ref.target
    : undefined;
}

export function threadKeyForNavigationThread(
  thread: NavigationThreadSummary,
): string {
  return thread.federation
    ? federatedThreadIdentityKey(thread.federation.ref)
    : buildThreadIdentityKey(thread.source, thread.id);
}

export function formatTimeOfDay(epochMs: number): string {
  const date = new Date(epochMs);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const period = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;
  const paddedMinutes = minutes < 10 ? `0${minutes}` : String(minutes);
  return `${displayHours}:${paddedMinutes} ${period}`;
}

export function resolveMonitorStateOptions(
  monitor: MessagingMonitorState | undefined,
  action: MonitorCommandAction,
): MonitorStateOptions {
  const currentPinned = normalizeMonitorThreadLimit(
    monitor?.pinnedThreadLimit,
    MESSAGING_MONITOR_DEFAULT_PINNED_THREAD_LIMIT,
  );
  const currentIntervalMs = normalizeMonitorIntervalMs(
    monitor?.intervalMs,
    MESSAGING_MONITOR_INTERVAL_MS,
  );
  const currentRecent = normalizeMonitorThreadLimit(
    monitor?.recentThreadLimit,
    MESSAGING_MONITOR_DEFAULT_RECENT_THREAD_LIMIT,
  );
  const currentShowStatusLine = monitor?.showStatusLine === true;
  const currentShowSnippet = monitor?.showLastResponseSnippet === true;

  switch (action.kind) {
    case "cycle-pinned":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: nextMonitorThreadLimit(currentPinned),
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "cycle-recent":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: nextMonitorThreadLimit(currentRecent),
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "cycle-interval":
      return {
        intervalMs: nextMonitorIntervalMs(currentIntervalMs),
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "toggle-status-line":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: !currentShowStatusLine,
      };
    case "toggle-snippet":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: !currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "set-pinned":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: normalizeMonitorThreadLimit(action.count, currentPinned),
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "set-interval":
      return {
        intervalMs: normalizeMonitorIntervalMs(action.intervalMs, currentIntervalMs),
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "set-recent":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: normalizeMonitorThreadLimit(action.count, currentRecent),
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "set-status-line":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: action.enabled,
      };
    case "set-snippet":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: action.enabled,
        showStatusLine: currentShowStatusLine,
      };
    case "refresh":
    case "start":
    case "stop":
    case "topics-adopt":
    case "topics-cleanup":
    case "topics-fanout":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
  }
}

export function buildMonitorSubscriptionId(channel: MessagingChannelRef): string {
  return `monitor:${buildMessagingConversationKey(channel)}`;
}

export function managedTopicRecordFromConversation(params: {
  actorIds: string[];
  channel: MessagingChannelKind;
  conversation: MessagingChannelRef["conversation"];
  now: number;
  routingState?: MessagingAdapterState;
  source: MessagingManagedTopicRecord["source"];
}): MessagingManagedTopicRecord {
  const supergroupId = params.conversation.parentId ?? params.conversation.id;
  const topicId = params.conversation.kind === "topic"
    ? params.conversation.id
    : "";
  return {
    id: `topic:${params.channel}:${supergroupId}:${topicId}`,
    authorizedActorIds: params.actorIds,
    channel: params.channel,
    conversation: params.conversation,
    createdAt: params.now,
    lastObservedAt: params.now,
    lifecycle: "open",
    routingState: params.routingState,
    source: params.source,
    supergroupId,
    title: params.conversation.title,
    topicId,
    updatedAt: params.now,
  };
}

export function topicTitleForThread(thread: NavigationThreadSummary): string {
  const trimmed = thread.title.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 120) : `${thread.source} thread`;
}

export function formatManagedTopicRights(
  operations: readonly MessagingManagedConversationOperationSupport[],
): string[] {
  return operations.map((operation) => {
    const label =
      operation.operation === "create_child"
        ? "create"
        : operation.operation;
    if (operation.supported) {
      return `${label}: available`;
    }
    return `${label}: unavailable${operation.missingPermission ? ` (${operation.missingPermission})` : operation.reason ? ` (${operation.reason})` : ""}`;
  });
}

export function formatTopicCleanupProposalBody(
  items: readonly MessagingTopicCleanupProposalItem[],
): string {
  if (items.length === 0) {
    return [
      "No known topics yet.",
      "",
      "Telegram bots cannot list every historical topic. Adopt topics from inside the topic first, then run cleanup again.",
    ].join("\n");
  }
  const grouped = {
    keep: items.filter((item) => item.action === "keep"),
    close: items.filter((item) => item.action === "close"),
    delete: items.filter((item) => item.action === "delete"),
  };
  return [
    "Dry run only. No topic will be closed or deleted until you approve one of the actions below.",
    "",
    `Keep: ${grouped.keep.length}`,
    ...grouped.keep.slice(0, 5).map((item) => `- ${item.title ?? item.id}: ${item.reason}`),
    `Close candidates: ${grouped.close.length}`,
    ...grouped.close.slice(0, 5).map((item) => `- ${item.title ?? item.id}: ${item.reason}`),
    `Delete candidates: ${grouped.delete.length}`,
    ...grouped.delete.slice(0, 5).map((item) => `- ${item.title ?? item.id}: ${item.reason}`),
  ].join("\n");
}

export function isPermanentMessagingTargetFailure(result: MessagingDeliveryResult): boolean {
  return (
    result.outcome === "failed" &&
    Boolean(
      result.errorMessage?.match(
        /\bUnknown Channel\b|chat not found|message thread not found/i,
      ),
    )
  );
}
