import type { PrActivityEvent, PrActivitySnapshot, PrActivityTone } from "@pwragent/shared";

/** No per-check persistence: diagnostic recording makes zero SQLite commits. */
export class PrActivityJournal {
  private readonly startedAt = Date.now();
  private sequence = 0;
  private readonly events: PrActivityEvent[] = [];

  constructor(private readonly capacity = 2_000) {}

  record(event: Omit<PrActivityEvent, "id" | "occurredAt">): void {
    this.events.push({ ...event, id: ++this.sequence, occurredAt: Date.now() });
    if (this.events.length > this.capacity) this.events.shift();
  }

  snapshot(): PrActivitySnapshot {
    return {
      startedAt: this.startedAt,
      droppedEvents: this.sequence - this.events.length,
      events: this.events.slice().reverse(),
    };
  }
}

export function describePrRepairDecision(status: string): string {
  switch (status) {
    case "scheduled": return "Repair scheduled: 30-second countdown";
    case "pending": return "Repair already queued";
    case "dispatched": return "Repair started";
    case "not-actionable": return "No repair needed: no settled failure or merge conflict";
    case "deferred": return "Waiting for running checks to finish";
    case "missing-head": return "Waiting for the PR head commit";
    case "disabled": return "Auto-fix is off for this thread";
    case "busy": return "Waiting for the current turn to finish";
    case "duplicate": return "No new repair queued: this PR event already has a recorded decision";
    case "attempt-limit": return "Repair attempt limit reached for this incident";
    case "cancelled": return "Repair cancelled by the operator";
    case "stale": return "Skipped: a newer PR observation or another instance owns this event";
    case "failed": return "Repair scheduling failed";
    default: return status;
  }
}

export function prRepairDecisionTone(status: string): PrActivityTone | undefined {
  switch (status) {
    case "scheduled":
    case "dispatched":
      return "active";
    case "deferred":
    case "missing-head":
    case "disabled":
    case "busy":
    case "attempt-limit":
    case "stale":
    case "gate-off":
      return "warning";
    case "failed":
      return "error";
    default:
      return undefined;
  }
}

export function describePrCheck(
  pr: { mergeState?: string; checkState?: string },
  incomplete: boolean,
): string {
  const merge = pr.mergeState === "conflicting" ? "Merge conflict"
    : pr.mergeState === "mergeable" ? "No conflicts"
    : "Merge state unknown";
  const checks = pr.checkState === "failing" ? "checks failing"
    : pr.checkState === "passing" ? "checks passing"
    : pr.checkState === "pending" ? "checks running"
    : "check status unknown";
  return `${incomplete ? "Partial check: " : ""}${merge}, ${checks}`;
}

/** Conflicts and failing checks are what Auto-fix exists to repair. */
export function prCheckTone(
  pr: { mergeState?: string; checkState?: string },
): PrActivityTone | undefined {
  if (pr.mergeState === "conflicting" || pr.checkState === "failing") return "error";
  if (pr.checkState === "passing" && pr.mergeState === "mergeable") return "ok";
  return undefined;
}
