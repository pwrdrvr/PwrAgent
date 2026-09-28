import { safeNavigationDiagnosticTrigger } from "../../shared/navigation-diagnostic-cause";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NavigationQueryRequest } from "@pwragent/shared";

export type ListingStage = "ipc" | "navigation" | "owner-page" | "owner-read" | "index" | "registry" | "provider" | "provider-rpc";
type Phase = "start" | "end" | "coalesced" | "cache-hit" | "invalidate" | "retry" | "cancel" | "cursor-hit";
export type ListingFields = {
  origin?: string;
  targetId?: number;
  trigger?: string;
  provider?: "codex" | "acp" | "all";
  source?: "local" | "remote" | "owner";
  inventory?: "owner" | "viewer";
  consumer?: string;
  query?: string;
  reason?: string;
  caller?: string;
  view?: number;
  effect?: number;
  logical?: number;
  attempt?: number;
  invalidations?: number;
  sender?: number;
  rows?: number;
  page?: number;
  archived?: boolean;
  cursor?: boolean;
  durationMs?: number;
  outcome?: "ok" | "error" | "aborted";
};
type Event = ListingFields & { id: number; parentId?: number; at: number; stage: ListingStage; phase: Phase };
const CAPACITY = 4096;
const RETENTION_MS = 120_000;
// Strings are code vocabulary, never request text, error messages, paths or IDs.
const LABELS = new Set([
  "main-sidebar", "star-map", "exact-link", "messaging-browse", "settings", "unknown", "remote-window", "search", "mentions", "agent-tool",
  "directory-index", "directory", "children", "exact", "group-members", "model-inventory", "lens", "star-map-geometry", "messaging-threads", "messaging-projects",
  "demand", "refresh", "continuation", "rebaseline", "pins", "turn", "thread", "metadata", "federation", "messaging-bindings", "timer", "visibility", "event", "cursor-expired", "page-budget", "owner-invalidated", "provider-fallback",
  "thread-list", "renderer-navigation-query", "federation-navigation-query", "navigation-snapshot", "startup-prewarm", "startup-provider-refresh", "authentication-recovery", "archive-cleanup", "thread-id-lookup", "agent-thread-inspection", "notification-context", "title-generation", "federation-thread-search",
]);
const NUMBER_FIELDS = ["targetId", "view", "effect", "logical", "attempt", "invalidations", "sender", "rows", "page", "durationMs"] as const;

/** O(1) append, fixed storage, no timers, stack captures, logging or persistence. */
export class ListingDiagnostics {
  private readonly ring: Array<Event | undefined> = new Array(CAPACITY);
  private next = 0;
  private recorded = 0;
  private sequence = 0;
  private readonly context = new AsyncLocalStorage<number>();
  private readonly identities = new WeakMap<object, number>();
  private readonly totals: Record<string, number> = {};

  constructor(private readonly now: () => number = Date.now) {}

  record(stage: ListingStage, phase: Phase, fields: ListingFields = {}, id = this.context.getStore() ?? ++this.sequence, parentId?: number): number {
    const event: Event = { id, parentId, at: this.now(), stage, phase };
    // Explicit copy is also the runtime boundary for untrusted IPC metadata.
    for (const key of NUMBER_FIELDS) {
      const value = fields[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) event[key] = value;
    }
    for (const key of ["consumer", "query", "reason", "caller"] as const) {
      if (fields[key] !== undefined) event[key] = LABELS.has(fields[key]!) ? fields[key] : "unknown";
    }
    if (typeof fields.origin === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fields.origin)) event.origin = fields.origin;
    event.trigger = safeNavigationDiagnosticTrigger(fields.trigger);
    if (["codex", "acp", "all"].includes(fields.provider ?? "")) event.provider = fields.provider;
    if (["local", "remote", "owner"].includes(fields.source ?? "")) event.source = fields.source;
    if (fields.inventory === "owner" || fields.inventory === "viewer") event.inventory = fields.inventory;
    if (["ok", "error", "aborted"].includes(fields.outcome ?? "")) event.outcome = fields.outcome;
    if (typeof fields.archived === "boolean") event.archived = fields.archived;
    if (typeof fields.cursor === "boolean") event.cursor = fields.cursor;
    this.ring[this.next] = event;
    this.next = (this.next + 1) % CAPACITY;
    this.recorded += 1;
    const key = `${stage}:${phase}`;
    this.totals[key] = (this.totals[key] ?? 0) + 1;
    return id;
  }

  /** The returned Promise is the physical identity reused by coalescers. */
  trace<T>(stage: ListingStage, fields: ListingFields, operation: () => Promise<T>): Promise<T> {
    const id = ++this.sequence;
    const started = this.now();
    this.record(stage, "start", fields, id, this.context.getStore());
    const promise = this.context.run(id, async () => {
      try {
        const result = await operation();
        this.record(stage, "end", { durationMs: this.now() - started, outcome: "ok" }, id);
        return result;
      } catch (error) {
        this.record(stage, "end", { durationMs: this.now() - started, outcome: "error" }, id);
        throw error;
      }
    });
    this.identities.set(promise, id);
    return promise;
  }

  link(stage: ListingStage, phase: "coalesced" | "cache-hit" | "cancel", object: object, fields: ListingFields = {}): void {
    this.record(stage, phase, { ...fields, targetId: this.identities.get(object) });
  }

  remember(object: object, promise: object): void {
    const id = this.identities.get(promise);
    if (id !== undefined) this.identities.set(object, id);
  }

  snapshot() {
    const capturedAtMs = this.now();
    const events: Event[] = [];
    const size = Math.min(this.recorded, CAPACITY);
    for (let i = 0; i < size; i += 1) {
      const event = this.ring[(this.next - size + i + CAPACITY) % CAPACITY]!;
      if (event.at >= capturedAtMs - RETENTION_MS && event.at <= capturedAtMs) events.push({ ...event });
    }
    return { schemaVersion: 1, processId: process.pid, capturedAtMs, capacity: CAPACITY,
      retentionMs: RETENTION_MS, recorded: this.recorded, overwritten: Math.max(0, this.recorded - CAPACITY),
      totals: { ...this.totals }, events };
  }
}

export const listingDiagnostics = new ListingDiagnostics();

export function listingRequestFields(request: NavigationQueryRequest): ListingFields {
  const diagnostic = request.diagnostic;
  return { consumer: request.consumer, query: request.query.kind, reason: diagnostic?.cause ?? request.readReason,
    source: request.federationTarget?.scope === "remote" ? "remote" : "local", inventory: request.inventory ?? "owner",
    trigger: diagnostic?.trigger, cursor: Boolean(request.cursor), rows: request.pageSize,
    origin: diagnostic?.origin, view: diagnostic?.view, effect: diagnostic?.effect, logical: diagnostic?.logical,
    attempt: diagnostic?.attempt, invalidations: diagnostic?.invalidations };
}
