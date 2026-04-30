import type {
  MessagingBindingRecord,
  MessagingDeliveryResult,
  MessagingPendingIntentRecord,
} from "@pwragnt/shared";

export const CURRENT_MESSAGING_STORE_VERSION = 1;

export type MessagingDeliveryRecord = MessagingDeliveryResult & {
  id: string;
  bindingId?: string;
  intentId?: string;
};

export type MessagingStoreData = {
  version: number;
  bindings: Record<string, MessagingBindingRecord>;
  pendingIntents: Record<string, MessagingPendingIntentRecord>;
  deliveries: Record<string, MessagingDeliveryRecord>;
};

const EMPTY_MESSAGING_STORE_DATA: MessagingStoreData = {
  version: CURRENT_MESSAGING_STORE_VERSION,
  bindings: {},
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
    bindings: migrateRecord(record.bindings, isMessagingBindingRecord),
    pendingIntents: migrateRecord(record.pendingIntents, isMessagingPendingIntentRecord),
    deliveries: migrateRecord(record.deliveries, isMessagingDeliveryRecord),
  };
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
