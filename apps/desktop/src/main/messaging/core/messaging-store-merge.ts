import type {
  MessagingAdapterState,
  MessagingBindingRecord,
  MessagingChannelRef,
  MessagingManagedTopicRecord,
} from "@pwragent/messaging-interface";

export type MessagingBindingChannelMetadataUpdate = {
  ancestorTitle?: string;
  bindingId: string;
  channel: MessagingChannelRef;
  observedAt: number;
  parentTitle?: string;
  routingState?: MessagingAdapterState;
  title?: string;
};

export type MessagingBindingChannelMetadataMerge = {
  binding: MessagingBindingRecord;
  changed: boolean;
};

export function mergeMessagingBindingChannelMetadata(
  current: MessagingBindingRecord | undefined,
  update: MessagingBindingChannelMetadataUpdate,
): MessagingBindingChannelMetadataMerge | undefined {
  if (
    !current
    || current.revokedAt
    || current.id !== update.bindingId
    || messagingConversationKey(current.channel)
      !== messagingConversationKey(update.channel)
  ) {
    return undefined;
  }
  if (current.updatedAt > update.observedAt) {
    return { binding: current, changed: false };
  }
  const stored = current.channel.conversation;
  const conversation = {
    ...stored,
    title: update.title ?? stored.title,
    parentTitle: update.parentTitle ?? stored.parentTitle,
    ancestorTitle: update.ancestorTitle ?? stored.ancestorTitle,
  };
  const routingState = update.routingState ?? current.routingState;
  const changed =
    conversation.title !== stored.title
    || conversation.parentTitle !== stored.parentTitle
    || conversation.ancestorTitle !== stored.ancestorTitle
    || !messagingAdapterStateEqual(routingState, current.routingState);
  if (!changed) {
    return { binding: current, changed: false };
  }
  return {
    binding: {
      ...current,
      channel: { ...current.channel, conversation },
      routingState,
      updatedAt: Math.max(current.updatedAt, update.observedAt),
    },
    changed: true,
  };
}

export type MessagingManagedTopicObservationMerge = {
  changed: boolean;
  topic: MessagingManagedTopicRecord;
};

export function mergeMessagingManagedTopicObservation(
  current: MessagingManagedTopicRecord | undefined,
  observation: MessagingManagedTopicRecord,
): MessagingManagedTopicObservationMerge {
  if (!current) {
    return { changed: true, topic: observation };
  }
  const lastObservedAt = Math.max(
    current.lastObservedAt ?? 0,
    observation.lastObservedAt ?? observation.updatedAt,
  );
  if (current.updatedAt >= observation.updatedAt) {
    if (lastObservedAt === current.lastObservedAt) {
      return { changed: false, topic: current };
    }
    return {
      changed: true,
      topic: { ...current, lastObservedAt },
    };
  }
  return {
    changed: true,
    topic: {
      ...observation,
      ...current,
      authorizedActorIds: current.authorizedActorIds.length
        ? current.authorizedActorIds
        : observation.authorizedActorIds,
      lastObservedAt,
      lifecycle: observation.lifecycle,
      recommendation: observation.recommendation ?? current.recommendation,
      routingState: observation.routingState ?? current.routingState,
      source: current.source === "owned" || current.source === "linked"
        ? current.source
        : observation.source,
      updatedAt: observation.updatedAt,
    },
  };
}

function messagingAdapterStateEqual(
  left: MessagingAdapterState | undefined,
  right: MessagingAdapterState | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function messagingConversationKey(channel: MessagingChannelRef): string {
  return [
    channel.channel,
    channel.conversation.kind,
    channel.conversation.parentId ?? "",
    channel.conversation.id,
  ].join(":");
}
