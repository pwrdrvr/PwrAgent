import type { DurableTurnReceipt } from "@pwragent/shared";
import type { DurableRequestReceipt, DurableTurnRequestStorage } from "@pwragent/owner-core/durable-turn-request-storage";
import type { StateDb } from "./state-db";

export class SqliteDurableTurnRequestStore implements DurableTurnRequestStorage {
  constructor(private readonly stateDb: StateDb) {}

  transaction<T>(work: () => T): T {
    const db = this.stateDb.raw;
    const synchronous = db.pragma("synchronous", { simple: true }) as number;
    // Receipt and claim commits must survive OS/power loss before dispatch.
    // No await here: other application writes cannot interleave on this handle.
    db.pragma("synchronous = FULL");
    try { return db.transaction(work).immediate(); }
    finally { db.pragma(`synchronous = ${synchronous}`); }
  }

  read(scope: string, id: string): DurableRequestReceipt | undefined {
    const row = this.stateDb.raw.prepare("SELECT receipt_json FROM durable_turn_requests WHERE caller_scope = ? AND request_id = ?").get(scope, id) as { receipt_json: string } | undefined;
    return row ? JSON.parse(row.receipt_json) as DurableRequestReceipt : undefined;
  }

  write(scope: string, receipt: DurableRequestReceipt): void {
    this.stateDb.raw.prepare("UPDATE durable_turn_requests SET receipt_json = ? WHERE caller_scope = ? AND request_id = ?").run(JSON.stringify(receipt), scope, receipt.id);
  }

  pruneExpired(now: number): void {
    this.stateDb.raw.prepare("DELETE FROM durable_turn_requests WHERE expires_at <= ?").run(now);
  }

  count(scope?: string): number {
    const db = this.stateDb.raw;
    return scope === undefined
      ? (db.prepare("SELECT count(*) AS n FROM durable_turn_requests").get() as { n: number }).n
      : (db.prepare("SELECT count(*) AS n FROM durable_turn_requests WHERE caller_scope = ?").get(scope) as { n: number }).n;
  }

  insert(scope: string, receipt: DurableRequestReceipt): void {
    this.stateDb.raw.prepare(`INSERT INTO durable_turn_requests
        (caller_scope, request_id, payload_hash, expires_at, receipt_json, queue_entry_id)
        VALUES (?, ?, ?, ?, ?, ?)`).run(scope, receipt.id, receipt.payloadHash, receipt.expiresAt, JSON.stringify(receipt), receipt.queueEntryId);
  }

  readQueueReceipt(queueEntryId: string): DurableTurnReceipt | undefined {
    const row = this.stateDb.raw.prepare("SELECT receipt_json FROM durable_turn_requests WHERE queue_entry_id = ?").get(queueEntryId) as { receipt_json: string } | undefined;
    return row ? JSON.parse(row.receipt_json) as DurableTurnReceipt : undefined;
  }

  findQueueReceipt(queueEntryId: string): { scope: string; receipt: DurableTurnReceipt } | undefined {
    const row = this.stateDb.raw.prepare("SELECT caller_scope, receipt_json FROM durable_turn_requests WHERE queue_entry_id = ?").get(queueEntryId) as { caller_scope: string; receipt_json: string } | undefined;
    return row ? { scope: row.caller_scope, receipt: JSON.parse(row.receipt_json) as DurableTurnReceipt } : undefined;
  }
}
