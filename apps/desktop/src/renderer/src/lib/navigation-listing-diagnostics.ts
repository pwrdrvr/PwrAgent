import type { NavigationDiagnosticCause } from "../../../shared/navigation-diagnostic-cause";

type Event = { at: number; view: number; effect: number; phase: "effect" | "dispose" | "demand" | "dispatch" | "coalesced" | "invalidate" | "cancel" | "retry"; logical?: number; attempt?: number; count?: number; cause?: NavigationDiagnosticCause; retry?: "page-budget" | "cursor-expired" };
let diagnosticOrigin: string | undefined;
export function navigationDiagnosticOrigin(): string { return diagnosticOrigin ??= crypto.randomUUID(); }

const CAPACITY = 1024;
const RETENTION_MS = 120_000;
/** No transport on append. Read once through CDP when a CPU artifact is saved. */
export class NavigationListingDiagnostics {
  private readonly events: Array<Event | undefined> = new Array(CAPACITY);
  private recorded = 0;
  private next = 0;
  record(event: Omit<Event, "at">): void {
    this.events[this.next] = { ...event, at: Date.now() };
    this.next = (this.next + 1) % CAPACITY;
    this.recorded += 1;
  }
  snapshot() {
    const capturedAtMs = Date.now();
    const size = Math.min(this.recorded, CAPACITY);
    const events: Event[] = [];
    for (let i = 0; i < size; i += 1) {
      const event = this.events[(this.next - size + i + CAPACITY) % CAPACITY]!;
      if (event.at >= capturedAtMs - RETENTION_MS && event.at <= capturedAtMs) events.push({ ...event });
    }
    return { schemaVersion: 1, origin: diagnosticOrigin, capturedAtMs, capacity: CAPACITY, retentionMs: RETENTION_MS,
      recorded: this.recorded, overwritten: Math.max(0, this.recorded - CAPACITY), events };
  }
}
let nextView = 0;
export function createNavigationDiagnosticView(): number { return ++nextView; }

export const navigationListingDiagnostics = new NavigationListingDiagnostics();
// Fixed diagnostic-only surface; no thread data or controls are exposed.
Object.defineProperty(globalThis, "__pwragentNavigationListingDiagnostics", {
  value: () => navigationListingDiagnostics.snapshot(), configurable: true,
});
