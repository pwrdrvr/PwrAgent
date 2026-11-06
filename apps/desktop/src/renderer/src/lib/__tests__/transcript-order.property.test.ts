import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerReadThreadResponse, AppServerThreadEntry } from "@pwragent/shared";
import { injectPermissionTransitions } from "../../features/thread-detail/permission-transition-entries";
import { insertSyntheticEntriesByTime } from "../../features/thread-detail/synthetic-transcript-entries";
import {
  combineTranscriptEntries,
  createTranscriptHistoryIndex,
  prependTranscriptHistoryPage,
  type LoadedTranscriptHistory,
} from "../segmented-transcript";

// Array position is the provider's (turn, item sequence) order. In particular,
// missing times and second-truncated times are not a second ordering oracle.
const timestamp = fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined });
const row = (id: string, createdAt?: number): AppServerThreadEntry => ({
  type: "message", id, role: "assistant", text: id, createdAt,
});
const ids = (entries: AppServerThreadEntry[]) => Array.from(entries, (entry) => entry.id);

function ledgerPage(
  entries: AppServerThreadEntry[],
  before = 0,
): AppServerReadThreadResponse {
  return {
    backend: "codex", threadId: "ledger-thread", fetchedAt: Date.now(), threadStatus: "idle",
    replay: {
      entries,
      messages: entries.flatMap((entry) => entry.type === "message" ? [entry] : []),
      pagination: {
        supportsPagination: true,
        hasPreviousPage: before > 0,
        ...(before > 0 ? { previousCursor: String(before) } : {}),
      },
    },
  };
}

describe("provider transcript order", () => {
  it("inserting synthetic rows preserves every provider row, regardless of its clock", () => {
    fc.assert(fc.property(
      fc.array(timestamp, { maxLength: 25 }),
      fc.array(timestamp, { maxLength: 10 }),
      (times, syntheticTimes) => {
        const entries = times.map((time, index) => row(`provider-${index}`, time));
        const synthetic = syntheticTimes.map((time, index) => row(`synthetic-${index}`, time));
        const result = insertSyntheticEntriesByTime(entries, synthetic);
        expect(ids(result.filter((entry) => entry.id.startsWith("provider-")))).toEqual(ids(entries));
        expect(new Set(ids(result)).size).toBe(entries.length + synthetic.length);
        expect(ids(result).sort()).toEqual([...ids(entries), ...ids(synthetic)].sort());
        expect(ids(entries)).toEqual(times.map((_, index) => `provider-${index}`));
      },
    ));
  });

  it("permission injection preserves provider order with missing, tied and coarse timestamps", () => {
    fc.assert(fc.property(
      fc.array(timestamp, { minLength: 2, maxLength: 20 }),
      fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 8 }),
      (times, transitionTimes) => {
        const entries = times.map((time, index) => row(`provider-${index}`, time));
        const transitions = transitionTimes.map((occurredAt, index) => ({
          id: `change-${index}`, occurredAt,
          fromExecutionMode: "default" as const, toExecutionMode: "full-access" as const,
          status: "applied" as const,
        }));
        const result = injectPermissionTransitions(entries, transitions);
        expect(ids(result.filter((entry) => entry.id.startsWith("provider-")))).toEqual(ids(entries));
        expect(new Set(ids(result)).size).toBe(entries.length + transitions.length);
      },
    ));
  });

  it("keeps an untimed provider row after its predecessor when permissions change at time zero", () => {
    const entries = [row("provider-0", 1), row("provider-1")];
    expect(ids(injectPermissionTransitions(entries, [{
      id: "change", occurredAt: 0, fromExecutionMode: "default",
      toExecutionMode: "full-access", status: "applied",
    }]).filter((entry) => entry.type === "message"))).toEqual(ids(entries));
  });

  it("combines overlapping pages in ledger order without duplicate logical keys", () => {
    fc.assert(fc.property(
      fc.array(timestamp, { minLength: 1, maxLength: 30 }),
      fc.integer({ min: 1, max: 6 }),
      fc.nat({ max: 5 }),
      (times, pageSize, overlap) => {
        const ledger = times.map((time, index) => row(`provider-${index}`, time));
        const split = Math.max(0, ledger.length - pageSize);
        const tail = ledger.slice(split);
        const index = createTranscriptHistoryIndex();
        let history: LoadedTranscriptHistory | undefined;
        for (let end = split; end > 0;) {
          const start = Math.max(0, end - pageSize);
          history = prependTranscriptHistoryPage({
            history, index, tailEntries: tail,
            page: ledgerPage(ledger.slice(start, Math.min(ledger.length, end + overlap)), start),
          });
          const result = combineTranscriptEntries(history, index, tail);
          expect(ids(result)).toEqual(ids(ledger.slice(start)));
          expect(new Set(ids(result)).size).toBe(result.length);
          end = start;
        }
        expect(ids(combineTranscriptEntries(history, index, tail))).toEqual(ids(ledger));
      },
    ));
  });
});
