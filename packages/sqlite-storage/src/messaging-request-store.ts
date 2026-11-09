import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type Database from "better-sqlite3";
import type { MessagingCausalSourceRef, PwrAgentMessagingResponse } from "@pwragent/shared";
import type { MessagingRequestSource, MessagingRequestStorage } from "@pwragent/owner-core/messaging-request-storage";

export { MESSAGING_REQUEST_SCHEMA } from "./state-schema";

/** Host-admitted routing payload and the scalar fields used by storage indexes. */
export type MessagingRequestProjection<InboundEvent> = {
  event: InboundEvent;
  eventId: string;
  platform: string;
  workspaceId?: string;
  actorId: string;
  destinationIdentity: string;
  receivedAt: number;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Immutable requests plus one latest-human pointer per actor/agent/surface.
 * No history replay, ancestry traversal, background writes or startup backfill.
 */
export class SqliteMessagingRequestStore<InboundEvent> implements MessagingRequestStorage<InboundEvent> {
  private readonly ownerId: string;

  constructor(
    private readonly db: Database.Database,
    private readonly projectEvent: (event: InboundEvent) => MessagingRequestProjection<InboundEvent> | undefined,
  ) {
    // Setup is outside the feature write budget; concurrent profile users share it.
    db.prepare("INSERT OR IGNORE INTO messaging_request_owner(singleton, owner_id) VALUES (1, ?)").run(randomUUID());
    const persistedOwner = (db.prepare("SELECT owner_id FROM messaging_request_owner WHERE singleton = 1").get() as { owner_id: string }).owner_id;
    // Copying a profile database must not copy its messaging authority into a
    // different profile. Processes opening this same file still share identity.
    this.ownerId = digest([persistedOwner, db.name === ":memory:" ? db.name : realpathSync(db.name)]);
  }

  remember(params: {
    agent: MessagingRequestSource<InboundEvent>["agent"];
    bindingId?: string;
    connectionId?: string;
    event: InboundEvent;
    instanceId?: string;
  }): MessagingRequestSource<InboundEvent> | undefined {
    const projection = this.projectEvent(params.event);
    if (!projection) return undefined;
    const { event } = projection;
    const principalScope = digest([this.ownerId, projection.platform,
      projection.workspaceId ?? null, params.connectionId ?? null,
      params.agent.backend, params.agent.threadId, projection.actorId]);
    const selector = digest([principalScope, projection.destinationIdentity]);
    const requestId = digest([selector, projection.eventId]);
    const existing = this.get({ ownerId: this.ownerId, requestId });
    if (existing) return existing;
    const source: MessagingRequestSource<InboundEvent> = {
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
        .run(selector, principalScope, projection.receivedAt, requestId);
    })();
    return source;
  }

  get(ref: MessagingCausalSourceRef): MessagingRequestSource<InboundEvent> | undefined {
    if (ref.ownerId !== this.ownerId) return undefined;
    const row = this.db.prepare("SELECT payload FROM messaging_requests WHERE request_id = ?")
      .get(ref.requestId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as MessagingRequestSource<InboundEvent> : undefined;
  }

  destination(source: MessagingRequestSource<InboundEvent>, selector: string): MessagingRequestSource<InboundEvent> | undefined {
    const row = this.db.prepare(`SELECT r.payload FROM messaging_human_destinations d
      JOIN messaging_requests r ON r.request_id = d.request_id WHERE d.principal_scope = ? AND d.selector = ?`)
      .get(source.principalScope, selector) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as MessagingRequestSource<InboundEvent> : undefined;
  }

  list(source: MessagingRequestSource<InboundEvent>, limit: number, before?: { at: number; selector: string }): MessagingRequestSource<InboundEvent>[] {
    const rows = this.db.prepare(`SELECT r.payload FROM messaging_human_destinations d
      JOIN messaging_requests r ON r.request_id = d.request_id WHERE d.principal_scope = ?
      AND d.interacted_at <= ? AND (d.interacted_at < ? OR d.selector > ?)
      ORDER BY d.interacted_at DESC, d.selector LIMIT ?`)
      .all(source.principalScope, before?.at ?? Number.MAX_SAFE_INTEGER,
        before?.at ?? Number.MAX_SAFE_INTEGER, before?.selector ?? "", Math.min(26, Math.max(1, limit))) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as MessagingRequestSource<InboundEvent>);
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
