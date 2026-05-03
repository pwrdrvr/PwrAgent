import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  MessagingAdapterState,
  MessagingBindingRecord,
  MessagingBrowseSessionRecord,
  MessagingCallbackHandleRecord,
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
    const channelKey = buildMessagingConversationKey(sanitized.channel);
    return await this.withData((data) => {
      for (const existing of Object.values(data.bindings)) {
        if (
          existing.id !== sanitized.id &&
          !existing.revokedAt &&
          buildMessagingConversationKey(existing.channel) === channelKey
        ) {
          revokeBindingInData(data, existing.id, sanitized.updatedAt);
        }
      }

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
        Object.values(data.bindings)
          .filter(
            (binding) =>
              !binding.revokedAt &&
              buildMessagingConversationKey(binding.channel) === channelKey,
          )
          .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0],
      ),
    );
  }

  async findActiveBindingsForThread(params: {
    backend: MessagingBindingRecord["backend"];
    threadId: MessagingBindingRecord["threadId"];
  }): Promise<MessagingBindingRecord[]> {
    return await this.withReadData((data) =>
      Object.values(data.bindings)
        .filter(
          (binding) =>
            !binding.revokedAt &&
            binding.backend === params.backend &&
            binding.threadId === params.threadId,
        )
        .map((binding) => structuredClone(binding)),
    );
  }

  async revokeBinding(params: {
    bindingId: string;
    revokedAt?: number;
  }): Promise<MessagingBindingRecord | undefined> {
    return await this.withData((data) => {
      const revoked = revokeBindingInData(
        data,
        params.bindingId,
        params.revokedAt ?? Date.now(),
      );
      return revoked ? structuredClone(revoked) : undefined;
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

  async findActivePendingIntentForChannel(params: {
    actorId: string;
    channel: MessagingChannelRef;
    now?: number;
  }): Promise<MessagingPendingIntentRecord | undefined> {
    const channelKey = buildMessagingConversationKey(params.channel);
    const now = params.now ?? Date.now();
    return await this.withReadData((data) =>
      cloneOptional(
        Object.values(data.pendingIntents)
          .filter(
            (intent) =>
              intent.expiresAt > now &&
              intent.allowedActorIds.includes(params.actorId) &&
              intent.channel &&
              buildMessagingConversationKey(intent.channel) === channelKey,
          )
          .sort((a, b) => b.createdAt - a.createdAt)[0],
      ),
    );
  }

  async findActivePendingIntentsForRequest(params: {
    backend: MessagingBindingRecord["backend"];
    threadId: MessagingBindingRecord["threadId"];
    requestId: string;
    now?: number;
  }): Promise<MessagingPendingIntentRecord[]> {
    const now = params.now ?? Date.now();
    return await this.withReadData((data) =>
      Object.values(data.pendingIntents)
        .filter((intent) => {
          const requestContext = intent.intent.requestContext;
          return (
            intent.expiresAt > now &&
            requestContext?.backend === params.backend &&
            requestContext.threadId === params.threadId &&
            requestContext.requestId === params.requestId
          );
        })
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((intent) => structuredClone(intent)),
    );
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

  async upsertBrowseSession(
    browseSession: MessagingBrowseSessionRecord,
  ): Promise<MessagingBrowseSessionRecord> {
    const sanitized = sanitizeBrowseSession(browseSession);
    return await this.withData((data) => {
      data.browseSessions[sanitized.id] = sanitized;
      return structuredClone(sanitized);
    });
  }

  async getBrowseSession(
    id: string,
    options?: { now?: number },
  ): Promise<MessagingBrowseSessionRecord | undefined> {
    return await this.withReadData((data) => {
      const session = data.browseSessions[id];
      if (!session || session.expiresAt <= (options?.now ?? Date.now())) {
        return undefined;
      }

      return structuredClone(session);
    });
  }

  async findActiveBrowseSessionForChannel(params: {
    actorId: string;
    channel: MessagingChannelRef;
    now?: number;
  }): Promise<MessagingBrowseSessionRecord | undefined> {
    const channelKey = buildMessagingConversationKey(params.channel);
    const now = params.now ?? Date.now();
    return await this.withReadData((data) =>
      cloneOptional(
        Object.values(data.browseSessions)
          .filter(
            (session) =>
              session.expiresAt > now &&
              session.allowedActorIds.includes(params.actorId) &&
              buildMessagingConversationKey(session.channel) === channelKey,
          )
          .sort((a, b) => b.updatedAt - a.updatedAt)[0],
      ),
    );
  }

  async deleteBrowseSession(id: string): Promise<void> {
    await this.withData((data) => {
      delete data.browseSessions[id];
      for (const [handleId, handle] of Object.entries(data.callbackHandles)) {
        if (handle.browseSessionId === id) {
          delete data.callbackHandles[handleId];
        }
      }
    });
  }

  async cleanupExpiredBrowseSessions(options?: { now?: number }): Promise<string[]> {
    const now = options?.now ?? Date.now();
    return await this.withData((data) => {
      const removed: string[] = [];
      for (const [sessionId, session] of Object.entries(data.browseSessions)) {
        if (session.expiresAt <= now) {
          delete data.browseSessions[sessionId];
          removed.push(sessionId);
        }
      }
      for (const [handleId, handle] of Object.entries(data.callbackHandles)) {
        if (handle.browseSessionId && !data.browseSessions[handle.browseSessionId]) {
          delete data.callbackHandles[handleId];
        }
      }
      return removed;
    });
  }

  async upsertCallbackHandle(
    callbackHandle: MessagingCallbackHandleRecord,
  ): Promise<MessagingCallbackHandleRecord> {
    const sanitized = sanitizeCallbackHandle(callbackHandle);
    return await this.withData((data) => {
      data.callbackHandles[sanitized.id] = sanitized;
      return structuredClone(sanitized);
    });
  }

  async getCallbackHandle(
    id: string,
    options?: { now?: number },
  ): Promise<MessagingCallbackHandleRecord | undefined> {
    return await this.withReadData((data) => {
      const handle = data.callbackHandles[id];
      if (!handle || handle.expiresAt <= (options?.now ?? Date.now())) {
        return undefined;
      }

      return structuredClone(handle);
    });
  }

  async resolveCallbackHandle(params: {
    actorId: string;
    channel: MessagingChannelRef;
    handle: string;
    now?: number;
  }): Promise<MessagingCallbackHandleRecord | undefined> {
    const channelKey = buildMessagingConversationKey(params.channel);
    const now = params.now ?? Date.now();
    return await this.withReadData((data) =>
      cloneOptional(
        Object.values(data.callbackHandles)
          .filter(
            (handle) =>
              handle.handle === params.handle &&
              handle.expiresAt > now &&
              handle.allowedActorIds.includes(params.actorId) &&
              buildMessagingConversationKey(handle.channel) === channelKey,
          )
          .sort((a, b) => b.updatedAt - a.updatedAt)[0],
      ),
    );
  }

  async deleteCallbackHandle(id: string): Promise<void> {
    await this.withData((data) => {
      delete data.callbackHandles[id];
    });
  }

  async cleanupExpiredCallbackHandles(options?: { now?: number }): Promise<string[]> {
    const now = options?.now ?? Date.now();
    return await this.withData((data) => {
      const removed: string[] = [];
      for (const [handleId, handle] of Object.entries(data.callbackHandles)) {
        if (handle.expiresAt <= now) {
          delete data.callbackHandles[handleId];
          removed.push(handleId);
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
          browseSessions: {},
          bindings: {},
          callbackHandles: {},
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
  const { activeTurn: _activeTurn, threadDisplay: _threadDisplay, ...rest } = binding;
  return {
    ...rest,
    authorizedActorIds: [...new Set(binding.authorizedActorIds)],
    pinnedStatusSurface: sanitizeSurfaceRef(binding.pinnedStatusSurface),
    routingState: sanitizeAdapterState(binding.routingState),
    statusSurface: sanitizeSurfaceRef(binding.statusSurface),
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
    surface: sanitizeSurfaceRef(intent.surface),
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
      handle.value === undefined
        ? undefined
        : sanitizeJsonValue(handle.value),
  };
}

function sanitizeDelivery(delivery: MessagingDeliveryRecord): MessagingDeliveryRecord {
  return {
    ...delivery,
    surface: sanitizeSurfaceRef(delivery.surface),
  };
}

function revokeBindingInData(
  data: MessagingStoreData,
  bindingId: string,
  revokedAt: number,
): MessagingBindingRecord | undefined {
  const current = data.bindings[bindingId];
  if (!current) {
    return undefined;
  }

  const revoked: MessagingBindingRecord = {
    ...current,
    revokedAt,
    updatedAt: revokedAt,
  };
  data.bindings[bindingId] = revoked;

  for (const [intentId, intent] of Object.entries(data.pendingIntents)) {
    if (intent.bindingId === bindingId) {
      delete data.pendingIntents[intentId];
    }
  }
  for (const [sessionId, session] of Object.entries(data.browseSessions)) {
    if (session.bindingId === bindingId) {
      delete data.browseSessions[sessionId];
    }
  }
  for (const [handleId, handle] of Object.entries(data.callbackHandles)) {
    if (handle.bindingId === bindingId) {
      delete data.callbackHandles[handleId];
    }
  }

  return revoked;
}

function sanitizeSurfaceRef<T extends { state?: MessagingAdapterState }>(
  surface: T | undefined,
): T | undefined {
  if (!surface) {
    return undefined;
  }

  return {
    ...surface,
    state: sanitizeAdapterState(surface.state),
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
