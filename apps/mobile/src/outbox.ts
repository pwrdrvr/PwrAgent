import type { MobileTarget } from "../../../packages/shared/src/mobile-gateway";

export type OutboxState = "pending" | "accepted" | "dispatching" | "dispatched" | "completed" | "uncertain" | "failed";
export type OutboxEntry = {
  id: string;
  operation: "startTurn" | "steerTurn";
  payloadHash: string;
  gatewayId: string;
  deviceId: string;
  target: MobileTarget;
  request: { backend: MobileTarget["backend"]; threadId: string; input: Array<{ type: "text"; text: string }>; expectedTurnId?: string };
  createdAt: number;
  state: OutboxState;
  error?: string;
  turnId?: string;
};
export type OutboxStorage = { read(): Promise<OutboxEntry[]>; write(entries: OutboxEntry[]): Promise<void> };
export type Receipt = { id: string; payloadHash: string; state: Exclude<OutboxState, "pending" | "failed">; result?: { turnId?: string; turn?: { id?: string } } };
export class Outbox {
  entries: OutboxEntry[] = [];
  private serial: Promise<unknown> = Promise.resolve();
  private sending = new Set<string>();
  constructor(private readonly storage: OutboxStorage, private readonly uuid: () => string,
    private readonly hash: (target: MobileTarget, request: OutboxEntry["request"], createdAt: number, operation: OutboxEntry["operation"]) => Promise<string>) {}
  async load(): Promise<void> {
    const entries = await this.storage.read();
    if (!Array.isArray(entries)) throw new Error("Outbox is unreadable; sending is disabled.");
    for (const entry of entries) {
      if (!entry || typeof entry.id !== "string" || !Number.isSafeInteger(entry.createdAt)
        || !["startTurn", "steerTurn"].includes(entry.operation)
        || await this.hash(entry.target, entry.request, entry.createdAt, entry.operation) !== entry.payloadHash) {
        throw new Error("Outbox integrity check failed; sending is disabled.");
      }
    }
    this.entries = entries;
  }
  private mutate(fn: (entries: OutboxEntry[]) => OutboxEntry[]): Promise<void> {
    const next = this.serial.then(async () => {
      const entries = fn(this.entries);
      if (JSON.stringify(entries) === JSON.stringify(this.entries)) return;
      await this.storage.write(entries);
      this.entries = entries;
    });
    this.serial = next.catch(() => undefined);
    return next;
  }
  async enqueue(target: MobileTarget, text: string, identity: { gatewayId: string; deviceId: string }, expectedTurnId?: string): Promise<OutboxEntry> {
    if (!text.trim() || text.length > 16_000) throw new Error("Enter between 1 and 16,000 characters.");
    const request: OutboxEntry["request"] = { backend: target.backend, threadId: target.threadId, input: [{ type: "text", text }], ...(expectedTurnId ? { expectedTurnId } : {}) };
    const createdAt = Date.now();
    const operation = expectedTurnId ? "steerTurn" : "startTurn";
    const entry: OutboxEntry = { ...identity, operation, id: this.uuid(), payloadHash: await this.hash(target, request, createdAt, operation), target, request, createdAt, state: "pending" };
    await this.mutate((entries) => [...entries, entry]);
    return entry;
  }
  async reconcile(receipt: Receipt): Promise<void> {
    await this.mutate((entries) => entries.map((entry) => {
      if (entry.id !== receipt.id) return entry;
      if (entry.payloadHash !== receipt.payloadHash) throw new Error("Gateway receipt hash mismatch; sending stopped.");
      const rank: Record<OutboxState, number> = { pending: 0, failed: 0, accepted: 1, dispatching: 2, dispatched: 3, uncertain: 4, completed: 5 };
      if (rank[receipt.state] < rank[entry.state]) return entry;
      return { ...entry, state: receipt.state, error: undefined, turnId: receipt.result?.turnId ?? receipt.result?.turn?.id ?? entry.turnId };
    }));
  }
  async deliver(entry: OutboxEntry, submit: (entry: OutboxEntry) => Promise<Receipt>): Promise<void> {
    if (this.sending.has(entry.id) || !["pending", "failed"].includes(entry.state)) return;
    this.sending.add(entry.id);
    try { await this.reconcile(await submit(entry)); }
    catch (error) {
      // A transport failure does not mean dispatch failed. Keep the original
      // identity for receipt lookup/retry; never mint a replacement request.
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const permanent = ["request_invalid", "request_expired", "request_conflict", "request_hash_mismatch", "request_too_large"].includes(String(code));
      await this.mutate((entries) => entries.map((row) => row.id === entry.id
        ? { ...row, state: permanent ? "failed" : "pending", error: error instanceof Error ? error.message : "Acknowledgment unavailable" } : row));
    } finally { this.sending.delete(entry.id); }
  }
}
