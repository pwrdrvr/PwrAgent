import type {
  MessagingAdapterState,
  MessagingBindingRecord,
  MessagingBrowseSessionRecord,
  MessagingCallbackHandleRecord,
  MessagingChannelRef,
  MessagingJsonValue,
  MessagingPendingIntentRecord,
} from "@pwragent/messaging-interface";
import type { StateDb } from "./state-db.js";
import type {
  MessagingDeliveryRecord,
  MessagingStoreData,
} from "../messaging/core/messaging-migrations.js";
import { CURRENT_MESSAGING_STORE_VERSION } from "../messaging/core/messaging-migrations.js";

const SECRET_KEY_PATTERN = /token|secret|password|authorization|api[_-]?key/i;

export class SqliteMessagingStore {
  constructor(private readonly stateDb: StateDb) {}

  async upsertBinding(
    binding: MessagingBindingRecord,
  ): Promise<MessagingBindingRecord> {
    const sanitized = sanitizeBinding(binding);
    const channel = sanitized.channel;
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO bindings(binding_id, channel_kind, channel_id, thread_id, status, created_at, updated_at, revoked_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        channel.channel,
        buildChannelId(channel),
        sanitized.threadId,
        sanitized.revokedAt ? "revoked" : "active",
        sanitized.createdAt,
        sanitized.updatedAt,
        sanitized.revokedAt ?? null,
        JSON.stringify(sanitized),
      );
    return structuredClone(sanitized);
  }

  async getBinding(id: string): Promise<MessagingBindingRecord | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM bindings WHERE binding_id = ?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  async findActiveBindingForChannel(
    channel: MessagingChannelRef,
  ): Promise<MessagingBindingRecord | undefined> {
    const channelKey = buildMessagingConversationKey(channel);
    const rows = this.stateDb.raw
      .prepare(
        "SELECT payload FROM bindings WHERE status = 'active' AND channel_kind = ?",
      )
      .all(channel.channel) as { payload: string }[];
    for (const row of rows) {
      const binding: MessagingBindingRecord = JSON.parse(row.payload);
      if (
        !binding.revokedAt &&
        buildMessagingConversationKey(binding.channel) === channelKey
      ) {
        return binding;
      }
    }
    return undefined;
  }

  async findActiveBindingsForThread(params: {
    backend: MessagingBindingRecord["backend"];
    threadId: MessagingBindingRecord["threadId"];
  }): Promise<MessagingBindingRecord[]> {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT payload FROM bindings WHERE status = 'active' AND thread_id = ?",
      )
      .all(params.threadId) as { payload: string }[];
    return rows
      .map((row) => JSON.parse(row.payload) as MessagingBindingRecord)
      .filter((binding) => {
        if (binding.revokedAt) return false;
        // Backend-strict matching used to drop bindings whose stored
        // backend disagreed with the thread's current source — a real
        // problem when an older binding lacks a backend at all, or
        // when a thread migrated between backends. Accept the row when
        // the backends match OR when the binding has no backend
        // recorded; trust thread_id otherwise (it's already PK-unique
        // enough across the user's history).
        if (!binding.backend) return true;
        return binding.backend === params.backend;
      });
  }

  async findActiveBindingsForBackend(params: {
    backend: MessagingBindingRecord["backend"];
  }): Promise<MessagingBindingRecord[]> {
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM bindings WHERE status = 'active'")
      .all() as { payload: string }[];
    return rows
      .map((row) => JSON.parse(row.payload) as MessagingBindingRecord)
      .filter((binding) => {
        if (binding.revokedAt) return false;
        if (!binding.backend) return true;
        return binding.backend === params.backend;
      });
  }

  async revokeBinding(params: {
    bindingId: string;
    revokedAt?: number;
  }): Promise<MessagingBindingRecord | undefined> {
    const current = await this.getBinding(params.bindingId);
    if (!current) return undefined;

    const revokedAt = params.revokedAt ?? Date.now();
    const revoked: MessagingBindingRecord = {
      ...current,
      revokedAt,
      updatedAt: revokedAt,
    };
    await this.upsertBinding(revoked);

    this.stateDb.raw
      .prepare("DELETE FROM pending_intents WHERE binding_id = ?")
      .run(params.bindingId);
    this.stateDb.raw
      .prepare("DELETE FROM browse_sessions WHERE binding_id = ?")
      .run(params.bindingId);
    await this.deletePendingIntentsForChannel({ channel: current.channel });
    await this.deleteCallbackHandlesForBinding({ bindingId: params.bindingId });

    return structuredClone(revoked);
  }

  async upsertPendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
  ): Promise<MessagingPendingIntentRecord> {
    const sanitized = sanitizePendingIntent(pendingIntent);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO pending_intents(intent_id, binding_id, created_at, expires_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        sanitized.bindingId ?? "",
        sanitized.createdAt,
        sanitized.expiresAt,
        JSON.stringify(sanitized),
      );
    return structuredClone(sanitized);
  }

  async getPendingIntent(
    id: string,
    options?: { now?: number },
  ): Promise<MessagingPendingIntentRecord | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM pending_intents WHERE intent_id = ?")
      .get(id) as { payload: string } | undefined;
    if (!row) return undefined;
    const intent: MessagingPendingIntentRecord = JSON.parse(row.payload);
    if (intent.expiresAt <= (options?.now ?? Date.now())) return undefined;
    return intent;
  }

  async findActivePendingIntentForChannel(params: {
    actorId: string;
    channel: MessagingChannelRef;
    now?: number;
  }): Promise<MessagingPendingIntentRecord | undefined> {
    const channelKey = buildMessagingConversationKey(params.channel);
    const now = params.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM pending_intents WHERE expires_at > ?")
      .all(now) as { payload: string }[];
    const matches = rows
      .map((r) => JSON.parse(r.payload) as MessagingPendingIntentRecord)
      .filter(
        (intent) =>
          intent.allowedActorIds.includes(params.actorId) &&
          intent.channel &&
          buildMessagingConversationKey(intent.channel) === channelKey,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    return matches[0];
  }

  async findActivePendingIntentsForRequest(params: {
    backend: MessagingBindingRecord["backend"];
    threadId: MessagingBindingRecord["threadId"];
    requestId: string;
    now?: number;
  }): Promise<MessagingPendingIntentRecord[]> {
    const now = params.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM pending_intents WHERE expires_at > ?")
      .all(now) as { payload: string }[];
    return rows
      .map((r) => JSON.parse(r.payload) as MessagingPendingIntentRecord)
      .filter((intent) => {
        const ctx = intent.intent.requestContext;
        return (
          ctx?.backend === params.backend &&
          ctx.threadId === params.threadId &&
          ctx.requestId === params.requestId
        );
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async deletePendingIntent(id: string): Promise<void> {
    this.stateDb.raw
      .prepare("DELETE FROM pending_intents WHERE intent_id = ?")
      .run(id);
  }

  /**
   * Retire every channel-scoped pending intent on a channel that is
   * NOT tied to a specific binding. Used by `bindChannelToThread` to
   * clean up the resume browser's pending intent (and any other
   * pre-binding picker intent) the moment a successful bind lands —
   * otherwise the next inbound text on that channel matches the stale
   * picker intent and the bot bounces "Choose an option" instead of
   * routing to the new binding.
   *
   * Binding-scoped pending intents (binding_id != '') are kept — they
   * belong to the binding's status surface, approval flows, etc.
   */
  async deletePendingIntentsForChannel(params: {
    channel: MessagingChannelRef;
  }): Promise<string[]> {
    const channelKey = buildMessagingConversationKey(params.channel);
    // Only consider channel-only intents (binding_id stored as ''). The
    // matching channel ref is JSON-encoded inside the payload, so we
    // parse and compare in JS rather than wrestle with sqlite JSON
    // extraction. The pending_intents table is small (capped TTL,
    // pruned by GC) so this is cheap.
    const rows = this.stateDb.raw
      .prepare(
        "SELECT intent_id, payload FROM pending_intents WHERE binding_id = ''",
      )
      .all() as { intent_id: string; payload: string }[];
    const removed: string[] = [];
    for (const row of rows) {
      try {
        const record = JSON.parse(row.payload) as MessagingPendingIntentRecord;
        if (
          record.channel &&
          buildMessagingConversationKey(record.channel) === channelKey
        ) {
          removed.push(row.intent_id);
        }
      } catch {
        // Malformed payload — skip; the row will be cleaned up by GC
        // on its expiry.
      }
    }
    if (removed.length === 0) return [];
    const deleteIntent = this.stateDb.raw.prepare(
      "DELETE FROM pending_intents WHERE intent_id = ?",
    );
    const deleteIntents = this.stateDb.raw.transaction((ids: string[]) => {
      for (const id of ids) {
        deleteIntent.run(id);
      }
    });
    deleteIntents(removed);
    return removed;
  }

  async deletePendingIntentsForThread(params: {
    backend: MessagingBindingRecord["backend"];
    threadId: MessagingBindingRecord["threadId"];
  }): Promise<string[]> {
    const bindingRows = this.stateDb.raw
      .prepare("SELECT payload FROM bindings WHERE thread_id = ?")
      .all(params.threadId) as { payload: string }[];
    const bindingIds = new Set<string>();
    for (const row of bindingRows) {
      try {
        const binding = JSON.parse(row.payload) as MessagingBindingRecord;
        if (!binding.backend || binding.backend === params.backend) {
          bindingIds.add(binding.id);
        }
      } catch {
        // Malformed binding payloads should not block intent cleanup.
      }
    }

    const rows = this.stateDb.raw
      .prepare("SELECT intent_id, binding_id, payload FROM pending_intents")
      .all() as { intent_id: string; binding_id: string; payload: string }[];
    const removed: string[] = [];
    for (const row of rows) {
      try {
        const intent = JSON.parse(row.payload) as MessagingPendingIntentRecord;
        const requestContext = intent.intent.requestContext;
        if (
          (requestContext?.backend === params.backend &&
            requestContext.threadId === params.threadId) ||
          (row.binding_id && bindingIds.has(row.binding_id))
        ) {
          removed.push(row.intent_id);
        }
      } catch {
        // Malformed payloads are left for expiry cleanup.
      }
    }
    if (removed.length === 0) return [];

    const deleteIntent = this.stateDb.raw.prepare(
      "DELETE FROM pending_intents WHERE intent_id = ?",
    );
    const deleteIntents = this.stateDb.raw.transaction((ids: string[]) => {
      for (const id of ids) {
        deleteIntent.run(id);
      }
    });
    deleteIntents(removed);
    return removed;
  }

  async cleanupExpiredPendingIntents(options?: {
    now?: number;
  }): Promise<string[]> {
    const now = options?.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare(
        "SELECT intent_id FROM pending_intents WHERE expires_at <= ?",
      )
      .all(now) as { intent_id: string }[];
    const removed = rows.map((r) => r.intent_id);
    if (removed.length > 0) {
      this.stateDb.raw
        .prepare("DELETE FROM pending_intents WHERE expires_at <= ?")
        .run(now);
    }
    return removed;
  }

  async upsertBrowseSession(
    browseSession: MessagingBrowseSessionRecord,
  ): Promise<MessagingBrowseSessionRecord> {
    const sanitized = sanitizeBrowseSession(browseSession);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO browse_sessions(session_id, binding_id, created_at, expires_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        sanitized.bindingId ?? null,
        sanitized.createdAt,
        sanitized.expiresAt,
        JSON.stringify(sanitized),
      );
    return structuredClone(sanitized);
  }

  async getBrowseSession(
    id: string,
    options?: { now?: number },
  ): Promise<MessagingBrowseSessionRecord | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM browse_sessions WHERE session_id = ?")
      .get(id) as { payload: string } | undefined;
    if (!row) return undefined;
    const session: MessagingBrowseSessionRecord = JSON.parse(row.payload);
    if (session.expiresAt <= (options?.now ?? Date.now())) return undefined;
    return session;
  }

  async findActiveBrowseSessionForChannel(params: {
    actorId: string;
    channel: MessagingChannelRef;
    now?: number;
  }): Promise<MessagingBrowseSessionRecord | undefined> {
    const channelKey = buildMessagingConversationKey(params.channel);
    const now = params.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM browse_sessions WHERE expires_at > ?")
      .all(now) as { payload: string }[];
    const matches = rows
      .map((r) => JSON.parse(r.payload) as MessagingBrowseSessionRecord)
      .filter(
        (session) =>
          session.allowedActorIds.includes(params.actorId) &&
          buildMessagingConversationKey(session.channel) === channelKey,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return matches[0];
  }

  async deleteBrowseSession(id: string): Promise<void> {
    this.stateDb.raw
      .prepare("DELETE FROM browse_sessions WHERE session_id = ?")
      .run(id);
    this.stateDb.raw
      .prepare("DELETE FROM callback_handles WHERE session_id = ?")
      .run(id);
  }

  async cleanupExpiredBrowseSessions(options?: {
    now?: number;
  }): Promise<string[]> {
    const now = options?.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare(
        "SELECT session_id FROM browse_sessions WHERE expires_at <= ?",
      )
      .all(now) as { session_id: string }[];
    const removed = rows.map((r) => r.session_id);
    if (removed.length > 0) {
      this.stateDb.raw
        .prepare("DELETE FROM browse_sessions WHERE expires_at <= ?")
        .run(now);
      for (const sessionId of removed) {
        this.stateDb.raw
          .prepare("DELETE FROM callback_handles WHERE session_id = ?")
          .run(sessionId);
      }
    }
    return removed;
  }

  async upsertCallbackHandle(
    callbackHandle: MessagingCallbackHandleRecord,
  ): Promise<MessagingCallbackHandleRecord> {
    const sanitized = sanitizeCallbackHandle(callbackHandle);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO callback_handles(handle_id, session_id, created_at, expires_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        sanitized.browseSessionId ?? null,
        sanitized.createdAt,
        sanitized.expiresAt,
        JSON.stringify(sanitized),
      );
    return structuredClone(sanitized);
  }

  async getCallbackHandle(
    id: string,
    options?: { now?: number },
  ): Promise<MessagingCallbackHandleRecord | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM callback_handles WHERE handle_id = ?")
      .get(id) as { payload: string } | undefined;
    if (!row) return undefined;
    const handle: MessagingCallbackHandleRecord = JSON.parse(row.payload);
    if (handle.expiresAt <= (options?.now ?? Date.now())) return undefined;
    return handle;
  }

  async resolveCallbackHandle(params: {
    actorId: string;
    channel: MessagingChannelRef;
    handle: string;
    now?: number;
  }): Promise<MessagingCallbackHandleRecord | undefined> {
    const channelKey = buildMessagingConversationKey(params.channel);
    const now = params.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM callback_handles WHERE expires_at > ?")
      .all(now) as { payload: string }[];
    const matches = rows
      .map((r) => JSON.parse(r.payload) as MessagingCallbackHandleRecord)
      .filter(
        (handle) =>
          handle.handle === params.handle &&
          handle.allowedActorIds.includes(params.actorId) &&
          buildMessagingConversationKey(handle.channel) === channelKey,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return matches[0];
  }

  async deleteCallbackHandle(id: string): Promise<void> {
    this.stateDb.raw
      .prepare("DELETE FROM callback_handles WHERE handle_id = ?")
      .run(id);
  }

  async deleteCallbackHandlesForBinding(params: {
    bindingId: string;
  }): Promise<string[]> {
    const rows = this.stateDb.raw
      .prepare("SELECT handle_id, payload FROM callback_handles")
      .all() as { handle_id: string; payload: string }[];
    const removed: string[] = [];
    for (const row of rows) {
      try {
        const handle = JSON.parse(row.payload) as MessagingCallbackHandleRecord;
        if (handle.bindingId === params.bindingId) {
          removed.push(row.handle_id);
        }
      } catch {
        // Malformed payload — skip; the row will be cleaned up by GC
        // on its expiry.
      }
    }
    if (removed.length === 0) return [];
    const deleteHandle = this.stateDb.raw.prepare(
      "DELETE FROM callback_handles WHERE handle_id = ?",
    );
    const deleteHandles = this.stateDb.raw.transaction((ids: string[]) => {
      for (const id of ids) {
        deleteHandle.run(id);
      }
    });
    deleteHandles(removed);
    return removed;
  }

  async cleanupExpiredCallbackHandles(options?: {
    now?: number;
  }): Promise<string[]> {
    const now = options?.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare(
        "SELECT handle_id FROM callback_handles WHERE expires_at <= ?",
      )
      .all(now) as { handle_id: string }[];
    const removed = rows.map((r) => r.handle_id);
    if (removed.length > 0) {
      this.stateDb.raw
        .prepare("DELETE FROM callback_handles WHERE expires_at <= ?")
        .run(now);
    }
    return removed;
  }

  async recordDelivery(
    delivery: MessagingDeliveryRecord,
  ): Promise<MessagingDeliveryRecord> {
    const sanitized = sanitizeDelivery(delivery);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO deliveries(delivery_id, binding_id, created_at, payload)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        sanitized.bindingId ?? "",
        sanitized.deliveredAt ?? Date.now(),
        JSON.stringify(sanitized),
      );
    return structuredClone(sanitized);
  }

  async getDelivery(id: string): Promise<MessagingDeliveryRecord | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM deliveries WHERE delivery_id = ?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  async readSnapshot(): Promise<MessagingStoreData> {
    const bindings: Record<string, MessagingBindingRecord> = {};
    const pendingIntents: Record<string, MessagingPendingIntentRecord> = {};
    const browseSessions: Record<string, MessagingBrowseSessionRecord> = {};
    const callbackHandles: Record<string, MessagingCallbackHandleRecord> = {};
    const deliveries: Record<string, MessagingDeliveryRecord> = {};

    for (const row of this.stateDb.raw
      .prepare("SELECT binding_id, payload FROM bindings")
      .all() as { binding_id: string; payload: string }[]) {
      bindings[row.binding_id] = JSON.parse(row.payload);
    }
    for (const row of this.stateDb.raw
      .prepare("SELECT intent_id, payload FROM pending_intents")
      .all() as { intent_id: string; payload: string }[]) {
      pendingIntents[row.intent_id] = JSON.parse(row.payload);
    }
    for (const row of this.stateDb.raw
      .prepare("SELECT session_id, payload FROM browse_sessions")
      .all() as { session_id: string; payload: string }[]) {
      browseSessions[row.session_id] = JSON.parse(row.payload);
    }
    for (const row of this.stateDb.raw
      .prepare("SELECT handle_id, payload FROM callback_handles")
      .all() as { handle_id: string; payload: string }[]) {
      callbackHandles[row.handle_id] = JSON.parse(row.payload);
    }
    for (const row of this.stateDb.raw
      .prepare("SELECT delivery_id, payload FROM deliveries")
      .all() as { delivery_id: string; payload: string }[]) {
      deliveries[row.delivery_id] = JSON.parse(row.payload);
    }

    return {
      version: CURRENT_MESSAGING_STORE_VERSION,
      bindings,
      pendingIntents,
      browseSessions,
      callbackHandles,
      deliveries,
    };
  }
}

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
    intent: sanitizeJsonValue(
      intent.intent as unknown as MessagingJsonValue,
    ) as unknown as MessagingPendingIntentRecord["intent"],
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

export type MessagingStoreLike = Pick<
  SqliteMessagingStore,
  | "upsertBinding"
  | "getBinding"
  | "findActiveBindingForChannel"
  | "findActiveBindingsForBackend"
  | "findActiveBindingsForThread"
  | "revokeBinding"
  | "upsertPendingIntent"
  | "getPendingIntent"
  | "findActivePendingIntentForChannel"
  | "findActivePendingIntentsForRequest"
  | "deletePendingIntent"
  | "deletePendingIntentsForChannel"
  | "deletePendingIntentsForThread"
  | "cleanupExpiredPendingIntents"
  | "upsertBrowseSession"
  | "getBrowseSession"
  | "findActiveBrowseSessionForChannel"
  | "deleteBrowseSession"
  | "cleanupExpiredBrowseSessions"
  | "upsertCallbackHandle"
  | "getCallbackHandle"
  | "resolveCallbackHandle"
  | "deleteCallbackHandle"
  | "deleteCallbackHandlesForBinding"
  | "cleanupExpiredCallbackHandles"
  | "recordDelivery"
  | "getDelivery"
  | "readSnapshot"
>;
