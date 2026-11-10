import { createHash } from "node:crypto";
import {
  canonicalDurableTurnRequest,
  canonicalDurableSteerRequest,
  DURABLE_TURN_REQUEST_RETENTION_MS,
  type DurableTurnPayload,
  type DurableTurnReceipt,
  type GetDurableTurnRequest,
  type SubmitDurableTurnRequest,
  type StartTurnResponse,
  type DurableSteerPayload,
  type DurableSteerReceipt,
  type SubmitDurableSteerRequest,
  type ControlActiveTurnResponse,
  DurableTurnRequestError,
} from "@pwragent/shared";
import type { DurableTurnRequestStorage } from "./durable-turn-request-storage";

export { DurableTurnRequestError } from "@pwragent/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STALE_DISPATCH_MS = 5 * 60_000;
type Receipt = DurableTurnReceipt | DurableSteerReceipt;

/** Owner-side inbox. No network/provider call runs inside a SQLite transaction.
 * A durable claim precedes the nontransactional dispatch; claims are never
 * reclaimed for automatic dispatch because provider acceptance is ambiguous.
 */
export class DurableTurnRequestService {
  constructor(private readonly options: {
    storage: DurableTurnRequestStorage;
    ownerInstanceId: string;
    queueEntryId?: (scope: string, requestId: string) => string;
    authorize: (scope: string, request: GetDurableTurnRequest) => Promise<void>;
    dispatch: (request: DurableTurnPayload & { queueEntryId: string }, scope: string) => Promise<StartTurnResponse>;
    steer?: (request: DurableSteerPayload & { requestId: string }, scope: string) => Promise<ControlActiveTurnResponse>;
    isQueued?: (receipt: DurableTurnReceipt) => Promise<boolean>;
    now?: () => number;
    maxPerCaller?: number;
    maxTotal?: number;
  }) {}

  async submit(scope: string, submission: SubmitDurableTurnRequest): Promise<DurableTurnReceipt> {
    return this.submitOperation(scope, submission, "startTurn") as Promise<DurableTurnReceipt>;
  }

  async submitSteer(scope: string, submission: SubmitDurableSteerRequest): Promise<DurableSteerReceipt> {
    if (!this.options.steer) this.fail("request_unsupported");
    return this.submitOperation(this.steerScope(scope), submission, "steerTurn") as Promise<DurableSteerReceipt>;
  }

  private async submitOperation(
    scope: string,
    submission: SubmitDurableTurnRequest | SubmitDurableSteerRequest,
    operation: "startTurn" | "steerTurn",
  ): Promise<Receipt> {
    this.validateScope(scope);
    if (!submission || typeof submission !== "object") this.fail("request_invalid");
    const { clientRequest, request } = submission;
    if (!clientRequest || clientRequest.version !== 1 || !UUID.test(clientRequest.id)
      || !Number.isSafeInteger(clientRequest.createdAt)
      || !/^[0-9a-f]{64}$/.test(clientRequest.payloadHash)) this.fail("request_invalid");
    if (!request || typeof request.backend !== "string" || !request.backend || request.backend.length > 128
      || typeof request.threadId !== "string" || !request.threadId
      || request.threadId.length > 512 || !Array.isArray(request.input)
      || "queueEntryId" in request || "federationTarget" in request
      || request.input.some((item) => !item || typeof item !== "object" || item.type === ("federationBlob" as string))) this.fail("request_invalid");
    const allowed = operation === "steerTurn"
      ? new Set(["backend", "threadId", "input", "expectedTurnId"])
      : new Set(["backend", "threadId", "input", "executionMode", "approvalPolicy", "sandbox", "model", "collaborationMode", "serviceTier", "reasoningEffort", "fastMode", "acpRuntime", "messageOrigin", "delivery"]);
    if (Object.keys(request).some((key) => !allowed.has(key))
      || ("delivery" in request && request.delivery !== undefined && request.delivery !== "new_turn")) this.fail("request_invalid");
    if (operation === "steerTurn" && (!("expectedTurnId" in request)
      || typeof request.expectedTurnId !== "string" || !request.expectedTurnId
      || request.expectedTurnId.length > 512 || request.input.length === 0)) this.fail("request_invalid");
    await this.options.authorize(operation === "steerTurn" ? this.originalScope(scope) : scope, { id: clientRequest.id, backend: request.backend, threadId: request.threadId });
    const now = this.now();
    const expiresAt = clientRequest.createdAt + DURABLE_TURN_REQUEST_RETENTION_MS;
    if (expiresAt <= now) this.fail("request_expired");
    if (clientRequest.createdAt > now + 5 * 60_000) this.fail("request_invalid");
    let canonical: string;
    try {
      canonical = operation === "steerTurn"
        ? canonicalDurableSteerRequest(this.options.ownerInstanceId, submission as SubmitDurableSteerRequest)
        : canonicalDurableTurnRequest(this.options.ownerInstanceId, submission as SubmitDurableTurnRequest);
    }
    catch { return this.fail("request_invalid"); }
    if (Buffer.byteLength(canonical, "utf8") > 64 * 1024) this.fail("request_too_large");
    if (createHash("sha256").update(canonical).digest("hex") !== clientRequest.payloadHash) this.fail("request_hash_mismatch");

    const replay = this.read(scope, clientRequest.id);
    if (replay) {
      if (replay.payloadHash !== clientRequest.payloadHash) this.fail("request_conflict");
      if (replay.state !== "accepted" || replay.result) return this.reconcile(scope, replay);
    }

    const admitted = this.transaction(() => {
      const existing = this.read(scope, clientRequest.id);
      if (existing) {
        if (existing.payloadHash !== clientRequest.payloadHash) this.fail("request_conflict");
        return existing;
      }
      // Prune only expired records. Never evict a still-valid deduplication key.
      this.options.storage.pruneExpired(now);
      const total = this.options.storage.count();
      const caller = this.options.storage.count(scope);
      if (total >= (this.options.maxTotal ?? 4096) || caller >= (this.options.maxPerCaller ?? 1024)) this.fail("request_quota_exceeded");
      const receipt: Receipt = {
        version: 1, id: clientRequest.id, payloadHash: clientRequest.payloadHash,
        ownerInstanceId: this.options.ownerInstanceId, backend: request.backend, threadId: request.threadId,
        queueEntryId: this.options.queueEntryId?.(scope, clientRequest.id) ?? `durable-${operation === "steerTurn" ? "steer" : "turn"}:${createHash("sha256").update(JSON.stringify([scope, clientRequest.id])).digest("hex")}`,
        state: "accepted", acceptedAt: now, updatedAt: now, expiresAt,
        ...(operation === "steerTurn" ? { operation: "steerTurn" as const } : {}),
      };
      this.options.storage.insert(scope, receipt);
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
      const response = operation === "steerTurn"
        ? await this.options.steer!({ ...(request as DurableSteerPayload), requestId: admitted.queueEntryId }, this.originalScope(scope))
        : await this.options.dispatch({ ...(request as DurableTurnPayload), delivery: "new_turn", queueEntryId: admitted.queueEntryId }, scope);
      // Control error text may contain provider/private details. Keep only its code.
      const sanitized = "ok" in response && !response.ok
        ? { ...response, error: { code: response.error.code, message: `Steering could not be proved: ${response.error.code}.` } }
        : response;
      const settled = this.transaction(() => {
        const current = this.read(scope, admitted.id)!;
        // Queue lifecycle can reach terminal before the submission promise settles.
        const result = operation === "startTurn" && "queueStatus" in sanitized && sanitized.queueStatus === "queued"
          && (current.state === "dispatched" || current.state === "completed") && current.result
          ? current.result : sanitized;
        const state = operation === "steerTurn"
          ? ("ok" in result && result.ok ? "dispatched" : "uncertain")
          : current.state === "uncertain" ? "uncertain" : current.state === "completed" ? "completed" : current.state === "dispatched" ? "dispatched"
            : "queueStatus" in result && result.queueStatus === "queued" ? "accepted" : "dispatched";
        const receipt = {
          ...current, result,
          state,
          updatedAt: this.now(),
        } as Receipt;
        this.write(scope, receipt);
        return receipt;
      });
      // Shutdown may have retired a committed queued acceptance before the
      // dispatch promise settled. Do not acknowledge a FIFO that no longer exists.
      return await this.reconcile(scope, settled);
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
    return this.getReceipt(scope, request) as Promise<DurableTurnReceipt | null>;
  }

  async getSteer(scope: string, request: GetDurableTurnRequest): Promise<DurableSteerReceipt | null> {
    return this.getReceipt(this.steerScope(scope), request, scope) as Promise<DurableSteerReceipt | null>;
  }

  private async getReceipt(scope: string, request: GetDurableTurnRequest, authorizeScope = scope): Promise<Receipt | null> {
    this.validateScope(scope);
    if (!request || !UUID.test(request.id) || typeof request.backend !== "string" || !request.backend
      || typeof request.threadId !== "string" || !request.threadId || request.threadId.length > 512) this.fail("request_invalid");
    await this.options.authorize(authorizeScope, request);
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
    // Queue availability (idle/notLoaded/unknown) is not a turn outcome.
    const outcome = event.status === "cancelled" || event.terminalStatus === "turn/cancelled" ? "cancelled"
      : event.terminalStatus === "turn/failed" ? "failed"
        : event.terminalStatus === "turn/completed" ? "completed" : undefined;
    if (event.status === "terminal" && !outcome) return;
    const existing = this.options.storage.readQueueReceipt(event.queueEntryId);
    if (!existing) return;
    if (existing.state === "completed" || (event.status === "started" && existing.state === "dispatched")) return;
    this.transaction(() => {
      const row = this.options.storage.findQueueReceipt(event.queueEntryId);
      if (!row) return;
      const receipt = row.receipt;
      if (receipt.backend !== event.backend || receipt.threadId !== event.threadId || receipt.state === "completed") return;
      if (event.status === "started") {
        if (!event.turnId || receipt.state === "dispatched") return;
        this.write(row.scope, { ...receipt, state: "dispatched", updatedAt: this.now(), result: {
          backend: event.backend, threadId: event.threadId, queueEntryId: event.queueEntryId, turnId: event.turnId, queueStatus: "started",
        } });
      } else if (event.status === "failed") {
        // A submission failure is not proof that the provider rejected it.
        if (receipt.state !== "dispatched" && receipt.state !== "uncertain") {
          this.write(row.scope, { ...receipt, state: "uncertain", updatedAt: this.now() });
        }
      } else {
        this.write(row.scope, { ...receipt, state: "completed", outcome, updatedAt: this.now() });
      }
    });
  }

  private async reconcile(scope: string, receipt: Receipt): Promise<Receipt> {
    if (receipt.state === "accepted" && receipt.result && "queueStatus" in receipt.result && receipt.result.queueStatus === "queued" && this.options.isQueued) {
      const queued = await this.options.isQueued(receipt as DurableTurnReceipt).catch(() => false);
      if (!queued) return this.transaction(() => {
        const current = this.read(scope, receipt.id)!;
        if (current.state !== "accepted") return current;
        const uncertain: Receipt = { ...current, state: "uncertain", updatedAt: this.now() };
        this.write(scope, uncertain);
        return uncertain;
      });
    }
    return this.reconcileStale(scope, receipt);
  }

  private reconcileStale(scope: string, receipt: Receipt): Receipt {
    if (receipt.state !== "dispatching" || receipt.updatedAt > this.now() - STALE_DISPATCH_MS) return receipt;
    return this.transaction(() => {
      const current = this.read(scope, receipt.id)!;
      if (current.state !== "dispatching" || current.updatedAt > this.now() - STALE_DISPATCH_MS) return current;
      const uncertain: Receipt = { ...current, state: "uncertain", updatedAt: this.now() };
      this.write(scope, uncertain);
      return uncertain;
    });
  }

  private transaction<T>(work: () => T): T {
    return this.options.storage.transaction(work);
  }

  private read(scope: string, id: string): Receipt | undefined {
    return this.options.storage.read(scope, id);
  }

  private write(scope: string, receipt: Receipt): void {
    this.options.storage.write(scope, receipt);
  }

  private validateScope(scope: string): void {
    if (typeof scope !== "string" || !scope || scope.length > 512) this.fail("request_invalid");
  }
  private steerScope(scope: string): string {
    this.validateScope(scope);
    return JSON.stringify(["steerTurn", scope]);
  }
  private originalScope(scope: string): string {
    return (JSON.parse(scope) as string[])[1]!;
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private fail(code: string): never { throw new DurableTurnRequestError(code); }
}
