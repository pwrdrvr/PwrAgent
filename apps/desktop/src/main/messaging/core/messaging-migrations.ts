import type {
  MessagingBindingRecord,
  MessagingBrowseSessionRecord,
  MessagingCallbackHandleRecord,
  MessagingDeliveryResult,
  MessagingManagedTopicRecord,
  MessagingMonitorSubscriptionRecord,
  MessagingPendingIntentRecord,
  MessagingThreadTopicLinkRecord,
  MessagingTopicCleanupProposalRecord,
} from "@pwragent/messaging-interface";

// SCHEMA-DRIFT-CHECKPOINT: when bumping CURRENT_MESSAGING_STORE_VERSION,
// also audit `apps/desktop/e2e/fixtures/readme-state-seeding.ts`. Its
// `seedTelegramBinding` / `seedActivityEntries` / `seedPairingEntry`
// helpers write directly to the messaging tables, bypassing
// `SqliteMessagingStore.upsertBinding` and friends — so any new
// required column or sanitization rule introduced with a schema bump
// must also land in the seed module, or the README screenshot capture
// (`pnpm --filter @pwragent/desktop screenshot:readme`) silently
// produces broken UI shots.
export const CURRENT_MESSAGING_STORE_VERSION = 2;

export type MessagingDeliveryRecord = MessagingDeliveryResult & {
  id: string;
  bindingId?: string;
  intentId?: string;
};

export type MessagingStoreData = {
  version: number;
  browseSessions: Record<string, MessagingBrowseSessionRecord>;
  bindings: Record<string, MessagingBindingRecord>;
  callbackHandles: Record<string, MessagingCallbackHandleRecord>;
  monitorSubscriptions: Record<string, MessagingMonitorSubscriptionRecord>;
  topicCleanupProposals: Record<string, MessagingTopicCleanupProposalRecord>;
  topicLinks: Record<string, MessagingThreadTopicLinkRecord>;
  topics: Record<string, MessagingManagedTopicRecord>;
  pendingIntents: Record<string, MessagingPendingIntentRecord>;
  deliveries: Record<string, MessagingDeliveryRecord>;
};

const EMPTY_MESSAGING_STORE_DATA: MessagingStoreData = {
  version: CURRENT_MESSAGING_STORE_VERSION,
  browseSessions: {},
  bindings: {},
  callbackHandles: {},
  monitorSubscriptions: {},
  topicCleanupProposals: {},
  topicLinks: {},
  topics: {},
  pendingIntents: {},
  deliveries: {},
};

export function migrateMessagingStoreData(raw: unknown): MessagingStoreData {
  const record = asRecord(raw);
  if (!record) {
    return structuredClone(EMPTY_MESSAGING_STORE_DATA);
  }

  return {
    version: CURRENT_MESSAGING_STORE_VERSION,
    browseSessions: migrateRecord(record.browseSessions, isMessagingBrowseSessionRecord),
    bindings: migrateBindingRecords(record.bindings),
    callbackHandles: migrateRecord(record.callbackHandles, isMessagingCallbackHandleRecord),
    monitorSubscriptions: migrateRecord(
      record.monitorSubscriptions,
      isMessagingMonitorSubscriptionRecord,
    ),
    topicCleanupProposals: migrateRecord(
      record.topicCleanupProposals,
      isMessagingTopicCleanupProposalRecord,
    ),
    topicLinks: migrateRecord(record.topicLinks, isMessagingThreadTopicLinkRecord),
    topics: migrateRecord(record.topics, isMessagingManagedTopicRecord),
    pendingIntents: migrateRecord(record.pendingIntents, isMessagingPendingIntentRecord),
    deliveries: migrateRecord(record.deliveries, isMessagingDeliveryRecord),
  };
}

function migrateBindingRecords(value: unknown): Record<string, MessagingBindingRecord> {
  const bindings = migrateRecord(value, isMessagingBindingRecord);
  return Object.fromEntries(
    Object.entries(bindings).map(([id, binding]) => [
      id,
      stripCachedThreadState(binding),
    ]),
  );
}

function stripCachedThreadState(
  binding: MessagingBindingRecord,
): MessagingBindingRecord {
  const { activeTurn: _activeTurn, threadDisplay: _threadDisplay, ...rest } = binding;
  return rest;
}

function migrateRecord<T>(
  value: unknown,
  predicate: (value: unknown) => value is T,
): Record<string, T> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, T] => predicate(entry[1])),
  );
}

function isMessagingBindingRecord(value: unknown): value is MessagingBindingRecord {
  const record = asRecord(value);
  const channel = asRecord(record?.channel);
  const conversation = asRecord(channel?.conversation);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.backend === "string" &&
      typeof record.threadId === "string" &&
      Array.isArray(record.authorizedActorIds) &&
      typeof channel?.channel === "string" &&
      typeof conversation?.id === "string" &&
      typeof conversation?.kind === "string" &&
      typeof record.createdAt === "number" &&
      typeof record.updatedAt === "number",
  );
}

function isMessagingPendingIntentRecord(
  value: unknown,
): value is MessagingPendingIntentRecord {
  const record = asRecord(value);
  const intent = asRecord(record?.intent);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      intent &&
      typeof intent.id === "string" &&
      typeof intent.kind === "string" &&
      Array.isArray(record.allowedActorIds) &&
      typeof record.createdAt === "number" &&
      typeof record.expiresAt === "number",
  );
}

function isMessagingMonitorSubscriptionRecord(
  value: unknown,
): value is MessagingMonitorSubscriptionRecord {
  const record = asRecord(value);
  const channel = asRecord(record?.channel);
  const conversation = asRecord(channel?.conversation);
  const monitor = asRecord(record?.monitor);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      Array.isArray(record.authorizedActorIds) &&
      typeof channel?.channel === "string" &&
      typeof conversation?.id === "string" &&
      typeof conversation?.kind === "string" &&
      typeof record.createdAt === "number" &&
      typeof record.updatedAt === "number" &&
      monitor &&
      typeof monitor.enabled === "boolean" &&
      typeof monitor.intervalMs === "number" &&
      typeof monitor.updatedAt === "number",
  );
}

function isMessagingManagedTopicRecord(
  value: unknown,
): value is MessagingManagedTopicRecord {
  const record = asRecord(value);
  const conversation = asRecord(record?.conversation);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.channel === "string" &&
      typeof record.supergroupId === "string" &&
      typeof record.topicId === "string" &&
      typeof conversation?.id === "string" &&
      typeof conversation?.kind === "string" &&
      Array.isArray(record.authorizedActorIds) &&
      typeof record.createdAt === "number" &&
      typeof record.updatedAt === "number" &&
      typeof record.lifecycle === "string" &&
      typeof record.source === "string",
  );
}

function isMessagingThreadTopicLinkRecord(
  value: unknown,
): value is MessagingThreadTopicLinkRecord {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.backend === "string" &&
      typeof record.channel === "string" &&
      typeof record.supergroupId === "string" &&
      typeof record.threadId === "string" &&
      typeof record.topicRecordId === "string" &&
      typeof record.createdAt === "number" &&
      typeof record.updatedAt === "number",
  );
}

function isMessagingTopicCleanupProposalRecord(
  value: unknown,
): value is MessagingTopicCleanupProposalRecord {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.channel === "string" &&
      typeof record.supergroupId === "string" &&
      Array.isArray(record.authorizedActorIds) &&
      Array.isArray(record.items) &&
      typeof record.createdAt === "number" &&
      typeof record.updatedAt === "number" &&
      typeof record.status === "string",
  );
}

function isMessagingBrowseSessionRecord(
  value: unknown,
): value is MessagingBrowseSessionRecord {
  const record = asRecord(value);
  const channel = asRecord(record?.channel);
  const conversation = asRecord(channel?.conversation);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      Array.isArray(record.allowedActorIds) &&
      typeof channel?.channel === "string" &&
      typeof conversation?.id === "string" &&
      typeof conversation?.kind === "string" &&
      typeof record.createdAt === "number" &&
      typeof record.updatedAt === "number" &&
      typeof record.expiresAt === "number" &&
      typeof record.launchAction === "string" &&
      typeof record.mode === "string" &&
      typeof record.pageIndex === "number" &&
      typeof record.pageSize === "number",
  );
}

function isMessagingCallbackHandleRecord(
  value: unknown,
): value is MessagingCallbackHandleRecord {
  const record = asRecord(value);
  const channel = asRecord(record?.channel);
  const conversation = asRecord(channel?.conversation);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.handle === "string" &&
      typeof record.actionId === "string" &&
      Array.isArray(record.allowedActorIds) &&
      typeof channel?.channel === "string" &&
      typeof conversation?.id === "string" &&
      typeof conversation?.kind === "string" &&
      typeof record.createdAt === "number" &&
      typeof record.updatedAt === "number" &&
      typeof record.expiresAt === "number",
  );
}

function isMessagingDeliveryRecord(value: unknown): value is MessagingDeliveryRecord {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.channel === "string" &&
      typeof record.outcome === "string" &&
      typeof record.deliveredAt === "number",
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
