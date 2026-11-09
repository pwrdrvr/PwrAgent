import type { MessagingRequestSource, MessagingRequestStore } from "../messaging/core/messaging-storage";
export type { MessagingRequestSource, MessagingRequestStore } from "../messaging/core/messaging-storage";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type Database from "better-sqlite3";
import type { MessagingCausalSourceRef, PwrAgentMessagingResponse } from "@pwragent/shared";
import type { MessagingChannelRef, MessagingInboundEvent } from "@pwragent/messaging-interface";

export { MESSAGING_REQUEST_SCHEMA } from "@pwragent/sqlite-storage/state-schema";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function messagingDestinationIdentity(channel: MessagingChannelRef): string {
  const c = channel.conversation;
  return JSON.stringify([channel.channel, c.workspaceId ?? null, c.kind, c.id,
    c.parentId ?? null, c.parentConversationId ?? null]);
}

function routingSnapshot(event: MessagingInboundEvent): MessagingInboundEvent {
  // Retaining the complete inbound event would copy user text and attachment data
  // at every delegation. Only this bounded routing snapshot belongs in provenance.
  const snapshot: MessagingInboundEvent = {
    id: event.id,
    kind: "lifecycle",
    lifecycle: "bound",
    actor: { platformUserId: event.actor.platformUserId, isBot: false },
    channel: event.channel,
    receivedAt: event.receivedAt,
    routingState: event.routingState,
    sourceSurface: event.sourceSurface,
  };
  const json = JSON.stringify(snapshot, (key, value: unknown) =>
    /token|secret|password|authorization|api[_-]?key/i.test(key) ? undefined : value);
  if (Buffer.byteLength(json) > 16 * 1024) throw new Error("Messaging source routing exceeds 16 KiB.");
  return JSON.parse(json) as MessagingInboundEvent;
}

/** Immutable requests plus one latest-human pointer per actor/agent/surface.
 * No history replay, ancestry traversal, background writes or startup backfill.
 */
export class SqliteMessagingRequestStore implements MessagingRequestStore {
  private readonly ownerId: string;

  constructor(private readonly db: Database.Database) {
    // Setup is outside the feature write budget; concurrent profile users share it.
    db.prepare("INSERT OR IGNORE INTO messaging_request_owner(singleton, owner_id) VALUES (1, ?)").run(randomUUID());
    const persistedOwner = (db.prepare("SELECT owner_id FROM messaging_request_owner WHERE singleton = 1").get() as { owner_id: string }).owner_id;
    // Copying a profile database must not copy its messaging authority into a
    // different profile. Processes opening this same file still share identity.
    this.ownerId = digest([persistedOwner, db.name === ":memory:" ? db.name : realpathSync(db.name)]);
  }

  remember(params: {
    agent: MessagingRequestSource["agent"];
    bindingId?: string;
    connectionId?: string;
    event: MessagingInboundEvent;
    instanceId?: string;
  }): MessagingRequestSource | undefined {
    if (params.event.actor.isBot || params.event.observedOnly
      || !["text", "media", "command", "callback"].includes(params.event.kind)) return undefined;
    const event = routingSnapshot(params.event);
    const principalScope = digest([this.ownerId, event.channel.channel,
      event.channel.conversation.workspaceId ?? null, params.connectionId ?? null,
      params.agent.backend, params.agent.threadId, event.actor.platformUserId]);
    const selector = digest([principalScope, messagingDestinationIdentity(event.channel)]);
    const requestId = digest([selector, event.id]);
    const existing = this.get({ ownerId: this.ownerId, requestId });
    if (existing) return existing;
    const source: MessagingRequestSource = {
      ref: { ownerId: this.ownerId, requestId, surfaceSelector: selector, ...(params.instanceId ? { instanceId: params.instanceId } : {}) },
      selector,
      principalScope,
      agent: params.agent,
      ...(params.bindingId ? { bindingId: params.bindingId } : {}),
      ...(params.connectionId ? { connectionId: params.connectionId } : {}),
      route: params.bindingId ? "binding" : "default",
      event,
    };
    this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO messaging_requests(request_id, payload) VALUES (?, ?)")
        .run(requestId, JSON.stringify(source));
      this.db.prepare(`INSERT INTO messaging_human_destinations(selector, principal_scope, interacted_at, request_id)
        VALUES (?, ?, ?, ?) ON CONFLICT(selector) DO UPDATE SET
          interacted_at = excluded.interacted_at, request_id = excluded.request_id
        WHERE excluded.interacted_at > messaging_human_destinations.interacted_at`)
        .run(selector, principalScope, event.receivedAt, requestId);
    })();
    return source;
  }

  get(ref: MessagingCausalSourceRef): MessagingRequestSource | undefined {
    if (ref.ownerId !== this.ownerId) return undefined;
    const row = this.db.prepare("SELECT payload FROM messaging_requests WHERE request_id = ?")
      .get(ref.requestId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as MessagingRequestSource : undefined;
  }

  destination(source: MessagingRequestSource, selector: string): MessagingRequestSource | undefined {
    const row = this.db.prepare(`SELECT r.payload FROM messaging_human_destinations d
      JOIN messaging_requests r ON r.request_id = d.request_id WHERE d.principal_scope = ? AND d.selector = ?`)
      .get(source.principalScope, selector) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as MessagingRequestSource : undefined;
  }

  list(source: MessagingRequestSource, limit: number, before?: { at: number; selector: string }): MessagingRequestSource[] {
    const rows = this.db.prepare(`SELECT r.payload FROM messaging_human_destinations d
      JOIN messaging_requests r ON r.request_id = d.request_id WHERE d.principal_scope = ?
      AND d.interacted_at <= ? AND (d.interacted_at < ? OR d.selector > ?)
      ORDER BY d.interacted_at DESC, d.selector LIMIT ?`)
      .all(source.principalScope, before?.at ?? Number.MAX_SAFE_INTEGER,
        before?.at ?? Number.MAX_SAFE_INTEGER, before?.selector ?? "", Math.min(26, Math.max(1, limit))) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as MessagingRequestSource);
  }

  claimAttachment(operation: unknown): { id: string; claimed: boolean; result?: PwrAgentMessagingResponse } {
    const id = digest(operation);
    const existing = this.db.prepare("SELECT result FROM messaging_attachment_operations WHERE operation_id = ?").get(id) as { result: string | null } | undefined;
    if (existing) return { id, claimed: false, ...(existing.result ? { result: JSON.parse(existing.result) as PwrAgentMessagingResponse } : {}) };
    const claimed = this.db.prepare("INSERT OR IGNORE INTO messaging_attachment_operations(operation_id) VALUES (?)").run(id).changes !== 0;
    const row = this.db.prepare("SELECT result FROM messaging_attachment_operations WHERE operation_id = ?").get(id) as { result: string | null };
    return { id, claimed, ...(row.result ? { result: JSON.parse(row.result) as PwrAgentMessagingResponse } : {}) };
  }

  finishAttachment(id: string, result: PwrAgentMessagingResponse): void {
    this.db.prepare("UPDATE messaging_attachment_operations SET result = ? WHERE operation_id = ? AND result IS NULL")
      .run(JSON.stringify(result), id);
  }
}
