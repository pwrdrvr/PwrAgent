import { safeNavigationDiagnosticTrigger, type NavigationDiagnosticCause } from "../../../shared/navigation-diagnostic-cause";

type Event = { at: number; view: number; effect: number;
  phase: "effect" | "dispose" | "demand" | "refresh" | "queued" | "dispatch" | "settled" | "coalesced" | "invalidate" | "cancel" | "retry" | "interaction";
  logical?: number; attempt?: number; count?: number; cause?: NavigationDiagnosticCause; caller?: string; trigger?: string;
  batch?: number; refreshBatch?: number; read?: number; resource?: number; query?: string; source?: "local" | "remote";
  inventory?: "owner" | "viewer"; rows?: number; invalidations?: number; waitMs?: number; durationMs?: number;
  outcome?: "ok" | "error"; cursor?: boolean; invalidatedOnly?: boolean;
  interaction?: "scroll" | "pointerdown" | "keydown"; lastAt?: number;
  retry?: "page-budget" | "cursor-expired" | "anchor-missing" };
let diagnosticOrigin: string | undefined;
export function navigationDiagnosticOrigin(): string { return diagnosticOrigin ??= crypto.randomUUID(); }

const CAPACITY = 1024;
const RETENTION_MS = 120_000;
const PHASES = new Set(["effect", "dispose", "demand", "refresh", "queued", "dispatch", "settled", "coalesced", "invalidate", "cancel", "retry", "interaction"]);
/** No transport on append. Read once through CDP when a CPU artifact is saved. */
export class NavigationListingDiagnostics {
  private readonly events: Array<string | undefined> = new Array(CAPACITY);
  private enabled = false;
  private generation = 0;
  private recorded = 0;
  private next = 0;
  private interactionSlot: number | undefined;
  get recordingGeneration(): number { return this.generation; }
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.generation++;
    if (enabled) return;
    this.events.fill(undefined);
    this.recorded = this.next = 0;
    this.interactionSlot = undefined;
  }
  record(event: Omit<Event, "at">, generation = this.generation): void {
    if (!this.enabled || generation !== this.generation || !PHASES.has(event.phase)) return;
    // Copy fixed scalars only: never stringify the caller or retain its objects.
    const entry: Event = { at: Date.now(), view: 0, effect: 0, phase: event.phase };
    for (const key of ["view", "effect", "logical", "attempt", "count", "batch", "refreshBatch", "read", "resource", "rows", "invalidations", "waitMs", "durationMs", "lastAt"] as const) {
      const value = event[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) entry[key] = value;
    }
    entry.trigger = safeNavigationDiagnosticTrigger(event.trigger);
    entry.caller = safeNavigationDiagnosticTrigger(event.caller);
    if (["demand", "refresh", "continuation", "rebaseline", "pins", "turn", "thread", "metadata", "federation", "messaging-bindings", "timer", "visibility", "event"].includes(event.cause ?? "")) entry.cause = event.cause;
    if (["directory-index", "directory", "children", "exact", "group-members", "model-inventory", "lens", "star-map", "messaging-threads", "messaging-projects"].includes(event.query ?? "")) entry.query = event.query;
    if (event.source === "local" || event.source === "remote") entry.source = event.source;
    if (event.inventory === "owner" || event.inventory === "viewer") entry.inventory = event.inventory;
    if (event.outcome === "ok" || event.outcome === "error") entry.outcome = event.outcome;
    if (event.retry === "page-budget" || event.retry === "cursor-expired" || event.retry === "anchor-missing") entry.retry = event.retry;
    if (event.interaction === "scroll" || event.interaction === "pointerdown" || event.interaction === "keydown") entry.interaction = event.interaction;
    if (typeof event.cursor === "boolean") entry.cursor = event.cursor;
    if (typeof event.invalidatedOnly === "boolean") entry.invalidatedOnly = event.invalidatedOnly;
    this.events[this.next] = JSON.stringify(entry);
    this.next = (this.next + 1) % CAPACITY;
    this.recorded += 1;
  }
  /** Coalesce only adjacent same-kind input within 100 ms, without a timer. */
  recordInteraction(interaction: NonNullable<Event["interaction"]>): void {
    if (!this.enabled) return;
    const at = Date.now();
    const slot = (this.next - 1 + CAPACITY) % CAPACITY;
    const previous: Event | undefined = this.interactionSlot === slot && this.events[slot]
      ? JSON.parse(this.events[slot]!) : undefined;
    if (previous?.interaction === interaction && at >= previous.at && at - previous.at < 100) {
      this.events[slot] = JSON.stringify({ ...previous, count: (previous.count ?? 1) + 1, lastAt: at });
      return;
    }
    this.interactionSlot = this.next;
    this.record({ view: 0, effect: 0, phase: "interaction", interaction, count: 1, lastAt: at });
  }
  snapshot() {
    const capturedAtMs = Date.now();
    const size = Math.min(this.recorded, CAPACITY);
    const events: Event[] = [];
    for (let i = 0; i < size; i += 1) {
      const event: Event = JSON.parse(this.events[(this.next - size + i + CAPACITY) % CAPACITY]!);
      if (event.at >= capturedAtMs - RETENTION_MS && event.at <= capturedAtMs) events.push(event);
    }
    return { schemaVersion: 2, enabled: this.enabled, origin: diagnosticOrigin, capturedAtMs, capacity: CAPACITY, retentionMs: RETENTION_MS,
      recorded: this.recorded, overwritten: Math.max(0, this.recorded - CAPACITY), events };
  }
}
let nextView = 0;
export function createNavigationDiagnosticView(): number { return ++nextView; }

export const navigationListingDiagnostics = new NavigationListingDiagnostics();
const inputKinds = ["scroll", "pointerdown", "keydown"] as const;
const recordInput = (event: globalThis.Event): void => {
  if (event.type === "scroll" || event.type === "pointerdown" || event.type === "keydown") navigationListingDiagnostics.recordInteraction(event.type);
};
export function setNavigationListingDiagnosticsEnabled(enabled: boolean): void {
  navigationListingDiagnostics.setEnabled(enabled);
  if (typeof window === "undefined") return;
  for (const kind of inputKinds) {
    window.removeEventListener(kind, recordInput, true);
    if (enabled) window.addEventListener(kind, recordInput, { capture: true, passive: true });
  }
}
// Fixed diagnostic-only surface; no thread data or controls are exposed.
Object.defineProperty(globalThis, "__pwragentNavigationListingDiagnostics", {
  value: () => navigationListingDiagnostics.snapshot(), configurable: true,
});
Object.defineProperty(globalThis, "__pwragentSetNavigationListingDiagnosticsEnabled", {
  value: setNavigationListingDiagnosticsEnabled, configurable: true,
});
