import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  MessagingAdapterState,
  MessagingBindingRecord,
  MessagingChannelRef,
  MessagingJsonValue,
  MessagingPendingIntentRecord,
} from "@pwragnt/shared";
import {
  CURRENT_MESSAGING_STORE_VERSION,
  migrateMessagingStoreData,
  type MessagingDeliveryRecord,
  type MessagingStoreData,
} from "./messaging-migrations.js";

const SECRET_KEY_PATTERN = /token|secret|password|authorization|api[_-]?key/i;

export class MessagingStore {
  private static readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly filePath: string) {}

  async upsertBinding(
    binding: MessagingBindingRecord,
  ): Promise<MessagingBindingRecord> {
    const sanitized = sanitizeBinding(binding);
    return await this.withData((data) => {
      data.bindings[sanitized.id] = sanitized;
      return structuredClone(sanitized);
    });
  }

  async getBinding(id: string): Promise<MessagingBindingRecord | undefined> {
    return await this.withReadData((data) => cloneOptional(data.bindings[id]));
  }

  async findActiveBindingForChannel(
    channel: MessagingChannelRef,
  ): Promise<MessagingBindingRecord | undefined> {
    const channelKey = buildMessagingConversationKey(channel);
    return await this.withReadData((data) =>
      cloneOptional(
        Object.values(data.bindings).find(
          (binding) =>
            !binding.revokedAt &&
            buildMessagingConversationKey(binding.channel) === channelKey,
        ),
      ),
    );
  }

  async revokeBinding(params: {
    bindingId: string;
    revokedAt?: number;
  }): Promise<MessagingBindingRecord | undefined> {
    return await this.withData((data) => {
      const current = data.bindings[params.bindingId];
      if (!current) {
        return undefined;
      }

      const revoked: MessagingBindingRecord = {
        ...current,
        revokedAt: params.revokedAt ?? Date.now(),
        updatedAt: params.revokedAt ?? Date.now(),
      };
      data.bindings[params.bindingId] = revoked;

      for (const [intentId, intent] of Object.entries(data.pendingIntents)) {
        if (intent.bindingId === params.bindingId) {
          delete data.pendingIntents[intentId];
        }
      }

      return structuredClone(revoked);
    });
  }

  async upsertPendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
  ): Promise<MessagingPendingIntentRecord> {
    const sanitized = sanitizePendingIntent(pendingIntent);
    return await this.withData((data) => {
      data.pendingIntents[sanitized.id] = sanitized;
      return structuredClone(sanitized);
    });
  }

  async getPendingIntent(
    id: string,
    options?: { now?: number },
  ): Promise<MessagingPendingIntentRecord | undefined> {
    return await this.withReadData((data) => {
      const intent = data.pendingIntents[id];
      if (!intent || intent.expiresAt <= (options?.now ?? Date.now())) {
        return undefined;
      }

      return structuredClone(intent);
    });
  }

  async deletePendingIntent(id: string): Promise<void> {
    await this.withData((data) => {
      delete data.pendingIntents[id];
    });
  }

  async cleanupExpiredPendingIntents(options?: { now?: number }): Promise<string[]> {
    const now = options?.now ?? Date.now();
    return await this.withData((data) => {
      const removed: string[] = [];
      for (const [intentId, intent] of Object.entries(data.pendingIntents)) {
        if (intent.expiresAt <= now) {
          delete data.pendingIntents[intentId];
          removed.push(intentId);
        }
      }
      return removed;
    });
  }

  async recordDelivery(
    delivery: MessagingDeliveryRecord,
  ): Promise<MessagingDeliveryRecord> {
    const sanitized = sanitizeDelivery(delivery);
    return await this.withData((data) => {
      data.deliveries[sanitized.id] = sanitized;
      return structuredClone(sanitized);
    });
  }

  async getDelivery(id: string): Promise<MessagingDeliveryRecord | undefined> {
    return await this.withReadData((data) => cloneOptional(data.deliveries[id]));
  }

  async readSnapshot(): Promise<MessagingStoreData> {
    return await this.withReadData((data) => structuredClone(data));
  }

  private async withData<T>(
    operation: (data: MessagingStoreData) => Promise<T> | T,
  ): Promise<T> {
    const currentQueue = MessagingStore.queues.get(this.filePath) ?? Promise.resolve();
    const next = currentQueue.then(async () => {
      const data = await this.readData();
      const result = await operation(data);
      await this.writeData(data);
      return result;
    });

    MessagingStore.queues.set(
      this.filePath,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );

    return (await next) as T;
  }

  private async withReadData<T>(
    operation: (data: MessagingStoreData) => Promise<T> | T,
  ): Promise<T> {
    await (MessagingStore.queues.get(this.filePath) ?? Promise.resolve());
    return await operation(await this.readData());
  }

  private async readData(): Promise<MessagingStoreData> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      return migrateMessagingStoreData(JSON.parse(contents));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return migrateMessagingStoreData({
          version: CURRENT_MESSAGING_STORE_VERSION,
          bindings: {},
          pendingIntents: {},
          deliveries: {},
        });
      }

      throw error;
    }
  }

  private async writeData(data: MessagingStoreData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    await rename(tempPath, this.filePath);
  }
}

export function buildMessagingConversationKey(channel: MessagingChannelRef): string {
  return [
    channel.channel,
    channel.conversation.kind,
    channel.conversation.parentId ?? "",
    channel.conversation.id,
  ].join(":");
}

function sanitizeBinding(binding: MessagingBindingRecord): MessagingBindingRecord {
  return {
    ...binding,
    authorizedActorIds: [...new Set(binding.authorizedActorIds)],
    routingState: sanitizeAdapterState(binding.routingState),
  };
}

function sanitizePendingIntent(
  intent: MessagingPendingIntentRecord,
): MessagingPendingIntentRecord {
  return {
    ...intent,
    allowedActorIds: [...new Set(intent.allowedActorIds)],
    intent: sanitizeJsonValue(intent.intent as unknown as MessagingJsonValue) as unknown as
      MessagingPendingIntentRecord["intent"],
    surface: intent.surface
      ? {
          ...intent.surface,
          state: sanitizeAdapterState(intent.surface.state),
        }
      : undefined,
  };
}

function sanitizeDelivery(delivery: MessagingDeliveryRecord): MessagingDeliveryRecord {
  return {
    ...delivery,
    surface: delivery.surface
      ? {
          ...delivery.surface,
          state: sanitizeAdapterState(delivery.surface.state),
        }
      : undefined,
  };
}

function sanitizeAdapterState(
  state: MessagingAdapterState | undefined,
): MessagingAdapterState | undefined {
  if (!state) {
    return undefined;
  }

  return {
    opaque: sanitizeJsonValue(state.opaque),
  };
}

function sanitizeJsonValue(value: MessagingJsonValue): MessagingJsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitizeJsonValue(entryValue),
      ]),
    );
  }

  return value;
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value ? structuredClone(value) : undefined;
}
