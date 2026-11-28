import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { safeNavigationDiagnosticTrigger } from "../../shared/navigation-diagnostic-cause";
import type { NavigationQueryRequest } from "@pwragent/shared/contracts/navigation";

export type ListingStage = "ipc" | "navigation" | "owner-page" | "owner-read" | "index" | "viewer-index" | "registry" | "provider" | "provider-rpc" | "workflow" | "federation";
type Phase = "start" | "end" | "coalesced" | "cache-hit" | "invalidate" | "overtaken" | "cancel" | "cursor-hit" | "send" | "receive";
export type ListingFields = {
  subjectTag?: number;
  ownerTag?: number;
  peerTag?: number;
  frameTag?: number;
  detailOnly?: boolean;
  compact?: boolean;
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
  "transcript", "thread-detail", "selected-detail", "submit-acceptance", "provider-turn-start", "first-send", "thread-start", "input-preparation", "mcp-registration", "mcp-inventory", "usage-durability", "workspace-preparation", "environment-setup",
  "main-sidebar", "star-map", "exact-link", "messaging-browse", "settings", "unknown", "remote-window", "search", "mentions", "agent-tool",
  "directory-index", "directory", "children", "exact", "group-members", "model-inventory", "lens", "star-map-geometry", "messaging-threads", "messaging-projects",
  "demand", "refresh", "continuation", "rebaseline", "pins", "turn", "thread", "metadata", "federation", "messaging-bindings", "timer", "visibility", "event", "cursor-expired", "page-budget", "owner-invalidated", "provider-fallback",
  "turn-cwd", "branch-drift", "transcript-image-roots", "workspace-handoff", "thread-dependency-titles", "retained-owner-membership",
  "durable-turn-ownership",
  "thread-list", "renderer-navigation-query", "federation-navigation-query", "owner-navigation-metadata", "navigation-snapshot", "startup-prewarm", "startup-provider-refresh", "authentication-recovery", "archive-cleanup", "thread-id-lookup", "agent-thread-inspection", "notification-context", "title-generation", "federation-thread-search",
]);
/** Caller suffixes are fixed code vocabulary, not arbitrary request text. */
function safeListingCaller(caller: string): string {
  if (caller.length > 100) return "unknown";
  if (LABELS.has(caller) || safeNavigationDiagnosticTrigger(caller) === caller) return caller;
  const suffix = ":archived-metadata";
  return caller.endsWith(suffix) && LABELS.has(caller.slice(0, -suffix.length)) ? caller : "unknown";
}

const NUMBER_FIELDS = ["subjectTag", "ownerTag", "peerTag", "frameTag", "targetId", "view", "effect", "logical", "attempt", "invalidations", "sender", "rows", "page", "durationMs"] as const;

/** O(1) append, fixed storage, no timers, stack captures, logging or persistence. */
export class ListingDiagnostics {
  private readonly ring: Array<string | undefined> = new Array(CAPACITY);
  private next = 0;
  private recorded = 0;
  private sequence = 0;
  private readonly context = new AsyncLocalStorage<{ id: number; generation: number }>();
  private identities = new WeakMap<object, number>();
  private readonly recordingSources = new Set<"cpu-monitor" | "replay">();
  private enabled = false;
  private launchTagKey?: Buffer;
  private generation = 0;
  private readonly totals: Record<string, number> = {};

  constructor(private readonly now: () => number = Date.now) {}

  setEnabled(enabled: boolean, source: "cpu-monitor" | "replay" = "cpu-monitor"): void {
    if (enabled) this.recordingSources.add(source);
    else this.recordingSources.delete(source);
    if (!this.recordingSources.has("cpu-monitor")) this.launchTagKey = undefined;
    const recording = this.recordingSources.size > 0;
    if (this.enabled === recording) return;
    this.enabled = recording;
    this.generation++;
    if (recording) return;
    this.ring.fill(undefined);
    this.next = this.recorded = 0;
    this.identities = new WeakMap();
    for (const key of Object.keys(this.totals)) delete this.totals[key];
  }

  /** Opaque equality tags within one CPU-monitor session. No identifier map,
   * request traces, or content in the ring. Only the two launch leads pay
   * for hashing, and oversized or missing identities carry no evidence. */
  launchFields(event?: AgentEvent, owner?: string, peer?: string, frame?: string): ListingFields | undefined {
    if (!this.recordingSources.has("cpu-monitor") || !event) return undefined;
    const { method, params } = event.notification;
    const compact = method === "navigation/invalidated";
    const trigger = compact ? params?.sourceMethod : method;
    if (trigger !== "thread/started" && trigger !== "thread/subAgents/updated") return undefined;
    const fields = params as { threadId?: unknown; thread?: { id?: unknown }; navigationChanged?: unknown };
    const key = this.launchTagKey ??= randomBytes(32);
    const tag = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 1024
      ? createHmac("sha256", key).update(value).digest().readUIntBE(0, 6) : undefined;
    return { trigger, compact, provider: event.backend === "codex" ? "codex" : undefined,
      detailOnly: fields?.navigationChanged === false, subjectTag: tag(fields?.threadId ?? fields?.thread?.id),
      ownerTag: tag(owner), peerTag: tag(peer), frameTag: tag(frame) };
  }

  recordLaunchDelivery(phase: "send" | "receive", event: AgentEvent, owner: string, peer: string, frame: string): void {
    const fields = this.launchFields(event, owner, peer, frame);
    if (fields) this.record("federation", phase, fields);
  }

  record(stage: ListingStage, phase: Phase, fields: ListingFields = {}, id?: number, parentId?: number): number {
    if (!this.enabled) return 0;
    const context = this.context.getStore();
    id ??= context?.generation === this.generation ? context.id : ++this.sequence;
    const event: Event = { id, parentId, at: this.now(), stage, phase };
    // Explicit copy is also the runtime boundary for untrusted IPC metadata.
    for (const key of NUMBER_FIELDS) {
      const value = fields[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) event[key] = value;
    }
    for (const key of ["consumer", "query", "reason"] as const) {
      if (fields[key] !== undefined) event[key] = LABELS.has(fields[key]!) ? fields[key] : "unknown";
    }
    if (typeof fields.caller === "string") event.caller = safeListingCaller(fields.caller);
    if (typeof fields.origin === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fields.origin)) event.origin = fields.origin;
    event.trigger = safeNavigationDiagnosticTrigger(fields.trigger);
    if (["codex", "acp", "all"].includes(fields.provider ?? "")) event.provider = fields.provider;
    if (["local", "remote", "owner"].includes(fields.source ?? "")) event.source = fields.source;
    if (fields.inventory === "owner" || fields.inventory === "viewer") event.inventory = fields.inventory;
    if (["ok", "error", "aborted"].includes(fields.outcome ?? "")) event.outcome = fields.outcome;
    if (typeof fields.compact === "boolean") event.compact = fields.compact;
    if (typeof fields.detailOnly === "boolean") event.detailOnly = fields.detailOnly;
    if (typeof fields.archived === "boolean") event.archived = fields.archived;
    if (typeof fields.cursor === "boolean") event.cursor = fields.cursor;
    this.ring[this.next] = JSON.stringify(event);
    this.next = (this.next + 1) % CAPACITY;
    this.recorded += 1;
    const key = `${stage}:${phase}`;
    this.totals[key] = (this.totals[key] ?? 0) + 1;
    return id;
  }

  /** The returned Promise is the physical identity reused by coalescers. */
  trace<T>(stage: ListingStage, fields: ListingFields, operation: () => Promise<T>): Promise<T> {
    if (!this.enabled) {
      // Preserve the existing completion boundary even without accounting.
      return (async () => await operation())();
    }
    const generation = this.generation;
    const id = ++this.sequence;
    const started = this.now();
    const parent = this.context.getStore();
    this.record(stage, "start", fields, id, parent?.generation === generation ? parent.id : undefined);
    const promise = this.context.run({ id, generation }, async () => {
      try {
        const result = await operation();
        if (generation === this.generation) this.record(stage, "end", { durationMs: this.now() - started, outcome: "ok" }, id);
        return result;
      } catch (error) {
        if (generation === this.generation) this.record(stage, "end", { durationMs: this.now() - started, outcome: "error" }, id);
        throw error;
      }
    });
    this.identities.set(promise, id);
    return promise;
  }

  link(stage: ListingStage, phase: "coalesced" | "cache-hit" | "cancel", object: object, fields: ListingFields = {}): void {
    if (!this.enabled) return;
    this.record(stage, phase, { ...fields, targetId: this.identities.get(object) });
  }

  remember(object: object, promise: object): void {
    if (!this.enabled) return;
    const id = this.identities.get(promise);
    if (id !== undefined) this.identities.set(object, id);
  }

  snapshot() {
    const capturedAtMs = this.now();
    const events: Event[] = [];
    const size = Math.min(this.recorded, CAPACITY);
    for (let i = 0; i < size; i += 1) {
      const event: Event = JSON.parse(this.ring[(this.next - size + i + CAPACITY) % CAPACITY]!);
      if (event.at >= capturedAtMs - RETENTION_MS && event.at <= capturedAtMs) events.push({ ...event });
    }
    return { schemaVersion: 2, enabled: this.enabled, processId: process.pid, capturedAtMs, capacity: CAPACITY,
      retentionMs: RETENTION_MS, recorded: this.recorded, overwritten: Math.max(0, this.recorded - CAPACITY),
      totals: { ...this.totals }, events };
  }
}

export const listingDiagnostics = new ListingDiagnostics();

export function listingRequestFields(request: NavigationQueryRequest): ListingFields {
  const diagnostic = request.diagnostic;
  return { consumer: request.consumer, query: request.query.kind, reason: diagnostic?.cause ?? request.readReason,
    source: request.federationTarget?.scope === "remote" ? "remote" : "local", inventory: request.inventory ?? "owner",
    caller: diagnostic?.caller, trigger: diagnostic?.trigger, cursor: Boolean(request.cursor), rows: request.pageSize,
    origin: diagnostic?.origin, view: diagnostic?.view, effect: diagnostic?.effect, logical: diagnostic?.logical,
    attempt: diagnostic?.attempt, invalidations: diagnostic?.invalidations };
}
