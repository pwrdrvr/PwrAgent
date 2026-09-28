import type { PrActivityEvent, PrActivitySnapshot, PrActivityTone } from "@pwragent/shared";

type RecordedEvent = Omit<PrActivityEvent, "id" | "occurredAt">;

/** No per-check persistence: diagnostic recording makes zero SQLite commits. */
export class PrActivityJournal {
  private readonly startedAt = Date.now();
  private sequence = 0;
  private dropped = 0;
  private readonly events: PrActivityEvent[] = [];
  /** The newest check or repair event per PR/thread stream, for coalescing. */
  private readonly latestByStream = new Map<string, PrActivityEvent>();

  constructor(private readonly capacity = 2_000) {}

  /**
   * A healthy PR is observed by the poller, the selected-thread tick, and
   * hover prefetches, and each observation also yields a repair decision. An
   * observation that repeats the stream's latest event therefore moves that
   * event to the top with a count instead of appending, so steady state costs
   * one row per PR and category and never evicts the history that matters.
   * A different result in between starts a new row, so order is preserved.
   * Budget events are never coalesced; each one moves a balance.
   */
  record(event: RecordedEvent): void {
    const occurredAt = Date.now();
    const stream = streamKey(event);
    const previous = stream ? this.latestByStream.get(stream) : undefined;
    if (previous && sameOutcome(previous, event)) {
      this.events.splice(this.events.indexOf(previous), 1);
      const merged: PrActivityEvent = {
        ...previous,
        source: event.source,
        id: ++this.sequence,
        occurredAt,
        firstOccurredAt: previous.firstOccurredAt ?? previous.occurredAt,
        repeats: (previous.repeats ?? 1) + 1,
      };
      this.events.push(merged);
      this.latestByStream.set(stream!, merged);
      return;
    }
    const recorded: PrActivityEvent = { ...event, id: ++this.sequence, occurredAt };
    this.events.push(recorded);
    if (stream) this.latestByStream.set(stream, recorded);
    if (this.events.length > this.capacity) {
      const evicted = this.events.shift()!;
      this.dropped += 1;
      const evictedStream = streamKey(evicted);
      if (evictedStream && this.latestByStream.get(evictedStream) === evicted) {
        this.latestByStream.delete(evictedStream);
      }
    }
  }

  snapshot(): PrActivitySnapshot {
    return {
      startedAt: this.startedAt,
      droppedEvents: this.dropped,
      events: this.events.slice().reverse(),
    };
  }
}

function streamKey(event: RecordedEvent): string | undefined {
  if (event.category === "budget") return undefined;
  return [
    event.category,
    [...event.prKeys].sort().join(","),
    [...event.threadKeys].sort().join(","),
  ].join("|");
}

function sameOutcome(left: RecordedEvent, right: RecordedEvent): boolean {
  return left.message === right.message && left.tone === right.tone;
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
