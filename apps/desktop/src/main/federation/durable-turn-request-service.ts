import { createHash } from "node:crypto";
import {
  canonicalDurableTurnRequest,
  DURABLE_TURN_REQUEST_RETENTION_MS,
  type DurableTurnPayload,
  type DurableTurnReceipt,
  type GetDurableTurnRequest,
  type SubmitDurableTurnRequest,
  type StartTurnResponse,
} from "@pwragent/shared";
import type { StateDb } from "../state/state-db";

export class DurableTurnRequestError extends Error {
  constructor(readonly code: string) { super(code); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STALE_DISPATCH_MS = 5 * 60_000;

/** Owner-side inbox. No network/provider call runs inside a SQLite transaction.
 * A durable claim precedes the nontransactional dispatch; claims are never
 * reclaimed for automatic dispatch because provider acceptance is ambiguous.
 */
export class DurableTurnRequestService {
  constructor(private readonly options: {
    stateDb: StateDb;
    ownerInstanceId: string;
    authorize: (scope: string, request: GetDurableTurnRequest) => Promise<void>;
    dispatch: (request: DurableTurnPayload & { queueEntryId: string }, scope: string) => Promise<StartTurnResponse>;
    isQueued?: (receipt: DurableTurnReceipt) => Promise<boolean>;
    now?: () => number;
    maxPerCaller?: number;
    maxTotal?: number;
  }) {}

  async submit(scope: string, submission: SubmitDurableTurnRequest): Promise<DurableTurnReceipt> {
    this.validateScope(scope);
    if (!submission || typeof submission !== "object") this.fail("request_invalid");
    const { clientRequest, request } = submission;
    if (!clientRequest || clientRequest.version !== 1 || !UUID.test(clientRequest.id)
      || !Number.isSafeInteger(clientRequest.createdAt)
      || !/^[0-9a-f]{64}$/.test(clientRequest.payloadHash)) this.fail("request_invalid");
    if (!request || typeof request.threadId !== "string" || !request.threadId
      || request.threadId.length > 512 || !Array.isArray(request.input)
      || "queueEntryId" in request || "federationTarget" in request
      || request.input.some((item) => !item || typeof item !== "object" || item.type === ("federationBlob" as string))) this.fail("request_invalid");
    const allowed = new Set(["backend", "threadId", "input", "executionMode", "approvalPolicy", "sandbox", "model", "collaborationMode", "serviceTier", "reasoningEffort", "fastMode", "acpRuntime", "messageOrigin", "delivery"]);
    if (Object.keys(request).some((key) => !allowed.has(key))
      || (request.delivery !== undefined && request.delivery !== "new_turn")) this.fail("request_invalid");
    await this.options.authorize(scope, { id: clientRequest.id, backend: request.backend, threadId: request.threadId });
    const now = this.now();
    const expiresAt = clientRequest.createdAt + DURABLE_TURN_REQUEST_RETENTION_MS;
    if (expiresAt <= now) this.fail("request_expired");
    if (clientRequest.createdAt > now + 5 * 60_000) this.fail("request_invalid");
    let canonical: string;
    try { canonical = canonicalDurableTurnRequest(this.options.ownerInstanceId, submission); }
    catch { return this.fail("request_invalid"); }
    if (Buffer.byteLength(canonical, "utf8") > 64 * 1024) this.fail("request_too_large");
    if (createHash("sha256").update(canonical).digest("hex") !== clientRequest.payloadHash) this.fail("request_hash_mismatch");

    const replay = this.read(scope, clientRequest.id);
    if (replay) {
      if (replay.payloadHash !== clientRequest.payloadHash) this.fail("request_conflict");
      if (replay.state !== "accepted" || replay.result) return this.reconcile(scope, replay);
    }

    const db = this.options.stateDb.raw;
    const admitted = this.transaction(() => {
      const existing = this.read(scope, clientRequest.id);
      if (existing) {
        if (existing.payloadHash !== clientRequest.payloadHash) this.fail("request_conflict");
        return existing;
      }
      // Prune only expired records. Never evict a still-valid deduplication key.
      db.prepare("DELETE FROM durable_turn_requests WHERE expires_at <= ?").run(now);
      const total = (db.prepare("SELECT count(*) AS n FROM durable_turn_requests").get() as { n: number }).n;
      const caller = (db.prepare("SELECT count(*) AS n FROM durable_turn_requests WHERE caller_scope = ?").get(scope) as { n: number }).n;
      if (total >= (this.options.maxTotal ?? 4096) || caller >= (this.options.maxPerCaller ?? 1024)) this.fail("request_quota_exceeded");
      const receipt: DurableTurnReceipt = {
        version: 1, id: clientRequest.id, payloadHash: clientRequest.payloadHash,
        ownerInstanceId: this.options.ownerInstanceId, backend: request.backend, threadId: request.threadId,
        queueEntryId: `durable-turn:${createHash("sha256").update(JSON.stringify([scope, clientRequest.id])).digest("hex")}`,
        state: "accepted", acceptedAt: now, updatedAt: now, expiresAt,
      };
      db.prepare(`INSERT INTO durable_turn_requests
        (caller_scope, request_id, payload_hash, expires_at, receipt_json, queue_entry_id)
        VALUES (?, ?, ?, ?, ?, ?)`).run(scope, receipt.id, receipt.payloadHash, expiresAt, JSON.stringify(receipt), receipt.queueEntryId);
      return receipt;
    });
    const claimed = this.transaction(() => {
      const current = this.read(scope, admitted.id)!;
      if (current.state !== "accepted" || current.result) return false;
      this.write(scope, { ...current, state: "dispatching", updatedAt: this.now() });
      return true;
    });
    if (!claimed) return this.reconcile(scope, this.read(scope, admitted.id)!);
    try {
      const result = await this.options.dispatch({ ...request, delivery: "new_turn", queueEntryId: admitted.queueEntryId }, scope);
      return this.transaction(() => {
        const current = this.read(scope, admitted.id)!;
        // Queue lifecycle can reach terminal before the submission promise settles.
        const receipt: DurableTurnReceipt = {
          ...current, result,
          state: current.state === "completed" ? "completed" : result.queueStatus === "queued" ? "accepted" : "dispatched",
          updatedAt: this.now(),
        };
        this.write(scope, receipt);
        return receipt;
      });
    } catch {
      // Do not persist provider errors (may contain prompts, paths or secrets).
      return this.transaction(() => {
        const current = this.read(scope, admitted.id)!;
        if (current.state !== "completed" && current.state !== "dispatched") {
          this.write(scope, { ...current, state: "uncertain", updatedAt: this.now() });
        }
        return this.read(scope, admitted.id)!;
      });
    }
  }

  async get(scope: string, request: GetDurableTurnRequest): Promise<DurableTurnReceipt | null> {
    this.validateScope(scope);
    if (!request || !UUID.test(request.id)) this.fail("request_invalid");
    await this.options.authorize(scope, request);
    const receipt = this.read(scope, request.id);
    if (!receipt || receipt.expiresAt <= this.now()) return null;
    if (receipt.backend !== request.backend || receipt.threadId !== request.threadId) this.fail("request_conflict");
    return this.reconcile(scope, receipt);
  }

  /** Proven owner queue lifecycle boundaries only; no writes per streamed item. */
  observeQueueEvent(event: {
    backend: DurableTurnReceipt["backend"];
    threadId: string;
    queueEntryId: string;
    status: string;
    turnId?: string;
    terminalStatus?: string;
  }): void {
    if (!["started", "terminal", "failed", "cancelled"].includes(event.status)) return;
    const db = this.options.stateDb.raw;
    const match = db.prepare("SELECT receipt_json FROM durable_turn_requests WHERE queue_entry_id = ?").get(event.queueEntryId) as { receipt_json: string } | undefined;
    if (!match) return;
    const existing = JSON.parse(match.receipt_json) as DurableTurnReceipt;
    if (existing.state === "completed" || (event.status === "started" && existing.state === "dispatched")) return;
    this.transaction(() => {
      const row = db.prepare("SELECT caller_scope, receipt_json FROM durable_turn_requests WHERE queue_entry_id = ?").get(event.queueEntryId) as { caller_scope: string; receipt_json: string } | undefined;
      if (!row) return;
      const receipt = JSON.parse(row.receipt_json) as DurableTurnReceipt;
      if (receipt.backend !== event.backend || receipt.threadId !== event.threadId || receipt.state === "completed") return;
      if (event.status === "started") {
        if (!event.turnId || receipt.state === "dispatched") return;
        this.write(row.caller_scope, { ...receipt, state: "dispatched", updatedAt: this.now(), result: {
          backend: event.backend, threadId: event.threadId, queueEntryId: event.queueEntryId, turnId: event.turnId, queueStatus: "started",
        } });
      } else if (event.status === "failed") {
        // A submission failure is not proof that the provider rejected it.
        if (receipt.state !== "dispatched" && receipt.state !== "uncertain") {
          this.write(row.caller_scope, { ...receipt, state: "uncertain", updatedAt: this.now() });
        }
      } else {
        const outcome = event.status === "cancelled" || event.terminalStatus === "turn/cancelled" ? "cancelled"
          : event.terminalStatus === "failed" || event.terminalStatus === "turn/failed" ? "failed" : "completed";
        this.write(row.caller_scope, { ...receipt, state: "completed", outcome, updatedAt: this.now() });
      }
    });
  }

  private async reconcile(scope: string, receipt: DurableTurnReceipt): Promise<DurableTurnReceipt> {
    if (receipt.state === "accepted" && receipt.result?.queueStatus === "queued" && this.options.isQueued) {
      const queued = await this.options.isQueued(receipt).catch(() => false);
      if (!queued) return this.transaction(() => {
        const current = this.read(scope, receipt.id)!;
        if (current.state !== "accepted") return current;
        const uncertain: DurableTurnReceipt = { ...current, state: "uncertain", updatedAt: this.now() };
        this.write(scope, uncertain);
        return uncertain;
      });
    }
    return this.reconcileStale(scope, receipt);
  }

  private reconcileStale(scope: string, receipt: DurableTurnReceipt): DurableTurnReceipt {
    if (receipt.state !== "dispatching" || receipt.updatedAt > this.now() - STALE_DISPATCH_MS) return receipt;
    return this.transaction(() => {
      const current = this.read(scope, receipt.id)!;
      if (current.state !== "dispatching" || current.updatedAt > this.now() - STALE_DISPATCH_MS) return current;
      const uncertain: DurableTurnReceipt = { ...current, state: "uncertain", updatedAt: this.now() };
      this.write(scope, uncertain);
      return uncertain;
    });
  }

  private transaction<T>(work: () => T): T {
    const db = this.options.stateDb.raw;
    const synchronous = db.pragma("synchronous", { simple: true }) as number;
    // Receipt and claim commits must survive OS/power loss before dispatch.
    // No await here: other application writes cannot interleave on this handle.
    db.pragma("synchronous = FULL");
    try { return db.transaction(work).immediate(); }
    finally { db.pragma(`synchronous = ${synchronous}`); }
  }

  private read(scope: string, id: string): DurableTurnReceipt | undefined {
    const row = this.options.stateDb.raw.prepare("SELECT receipt_json FROM durable_turn_requests WHERE caller_scope = ? AND request_id = ?").get(scope, id) as { receipt_json: string } | undefined;
    return row ? JSON.parse(row.receipt_json) as DurableTurnReceipt : undefined;
  }

  private write(scope: string, receipt: DurableTurnReceipt): void {
    this.options.stateDb.raw.prepare("UPDATE durable_turn_requests SET receipt_json = ? WHERE caller_scope = ? AND request_id = ?").run(JSON.stringify(receipt), scope, receipt.id);
  }

  private validateScope(scope: string): void {
    if (typeof scope !== "string" || !scope || scope.length > 512) this.fail("request_invalid");
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private fail(code: string): never { throw new DurableTurnRequestError(code); }
}
