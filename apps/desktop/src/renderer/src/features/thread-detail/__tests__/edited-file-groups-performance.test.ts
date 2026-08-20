import { describe, expect, it } from "vitest";
import type {
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
} from "@pwragent/shared";
import { createEditedFileGroupsCollector } from "../edited-file-groups";

/**
 * Per-delta cost of the edited-file-groups derivation.
 *
 * `session.entries` gets a fresh array identity on every streamed transcript
 * delta, so a derivation that walks the whole transcript costs O(n) per delta
 * and O(n^2) across a turn. These tests measure the *marginal* cost of one
 * delta by counting the input the derivation touches — no wall-clock
 * thresholds, which flake on loaded CI.
 *
 * The assertions are ratios (delta at ~5000 entries vs. delta at ~100), so
 * they hold regardless of machine speed: a full-walk derivation reads ~50x
 * more at 5000 than at 100, an incremental one reads the same either way.
 */

type Counters = {
  /** Index reads of the entries array — "entries visited". */
  entryReads: number;
  /** `entry.details` reads — entries inspected at detail level. */
  detailListReads: number;
  /** `detail.fileDiff` reads — per-file bucketing/merge work. */
  fileDiffReads: number;
};

function createCounters(): Counters {
  return { entryReads: 0, detailListReads: 0, fileDiffReads: 0 };
}

function snapshot(counters: Counters): Counters {
  return { ...counters };
}

function reset(counters: Counters): void {
  counters.entryReads = 0;
  counters.detailListReads = 0;
  counters.fileDiffReads = 0;
}

const ARRAY_INDEX = /^\d+$/;

/**
 * Count what the derivation reads without instrumenting production code: the
 * entries array is proxied (numeric reads counted) and each entry/detail
 * exposes counting getters for the fields the derivation consumes.
 */
function instrumentEntries(
  entries: readonly AppServerThreadEntry[],
  counters: Counters,
): AppServerThreadEntry[] {
  return new Proxy(entries as AppServerThreadEntry[], {
    get(target, property, receiver) {
      if (typeof property === "string" && ARRAY_INDEX.test(property)) {
        counters.entryReads += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function instrumentDetail(
  detail: AppServerThreadActivityDetail,
  counters: Counters,
): AppServerThreadActivityDetail {
  const fileDiff = detail.fileDiff;
  return {
    ...detail,
    get fileDiff() {
      counters.fileDiffReads += 1;
      return fileDiff;
    },
  };
}

function instrumentEntry(
  entry: AppServerThreadActivityEntry,
  counters: Counters,
): AppServerThreadActivityEntry {
  const details = entry.details.map((detail) =>
    instrumentDetail(detail, counters),
  );
  return {
    ...entry,
    get details() {
      counters.detailListReads += 1;
      return details;
    },
  };
}

/** Entries per turn, so a long transcript carries many turn groups. */
const ENTRIES_PER_TURN = 5;
/** Distinct files a turn touches, so repeat edits to a file merge. */
const FILES_PER_TURN = 3;

function transcriptEntry(
  index: number,
  counters: Counters,
): AppServerThreadActivityEntry {
  const turnIndex = Math.floor(index / ENTRIES_PER_TURN);
  const fileIndex = index % FILES_PER_TURN;
  return instrumentEntry(
    {
      type: "activity",
      id: `entry-${index}`,
      createdAt: 1_000 + index,
      summary: "activity",
      turn: { id: `turn-${turnIndex}` },
      details: [
        {
          id: `detail-${index}`,
          kind: "write",
          label: `Update file-${fileIndex}.ts`,
          path: `/repo/src/file-${turnIndex}-${fileIndex}.ts`,
          fileDiff: {
            kind: "update",
            diff: `@@ -1 +1 @@\n-old ${index}\n+new ${index}`,
            additions: 1,
            removals: 1,
          },
        },
      ],
    },
    counters,
  );
}

function buildTranscript(
  length: number,
  counters: Counters,
): AppServerThreadEntry[] {
  return Array.from({ length }, (_, index) => transcriptEntry(index, counters));
}

/**
 * Cost of the single `collect` call that follows one appended entry, with the
 * collector already warmed to `length` entries. Streaming hands the derivation
 * a new array identity every delta, so each call slices a fresh array over the
 * same entry objects — exactly what `session.entries` does.
 */
function measureAppendCost(params: {
  length: number;
  /**
   * Entries at the very end of the transcript that are re-created (new object
   * identity, same content) on every delta — the churn a streaming tail
   * produces as pending entries resolve.
   */
  churnTail?: number;
}): Counters {
  const counters = createCounters();
  const transcript = buildTranscript(params.length + 1, counters);
  const churnTail = params.churnTail ?? 0;

  const snapshotAt = (length: number): AppServerThreadEntry[] => {
    const slice = transcript.slice(0, length);
    for (let index = Math.max(0, length - churnTail); index < length; index += 1) {
      slice[index] = instrumentEntry(
        transcript[index] as AppServerThreadActivityEntry,
        counters,
      );
    }
    return instrumentEntries(slice, counters);
  };

  const collector = createEditedFileGroupsCollector();
  collector.collect({ entries: snapshotAt(params.length) });

  const measured = snapshotAt(params.length + 1);
  reset(counters);
  collector.collect({ entries: measured });
  return snapshot(counters);
}

describe("edited-file-groups per-delta cost", () => {
  it("reads a flat amount of the transcript per appended entry", () => {
    const small = measureAppendCost({ length: 100 });
    const large = measureAppendCost({ length: 5_000 });

    // A full walk reads ~50x more at 5000 entries than at 100. Incremental
    // work reads the same either way; allow generous slack for bookkeeping.
    expect(large.entryReads).toBeLessThanOrEqual(small.entryReads * 2);
    expect(large.detailListReads).toBeLessThanOrEqual(
      small.detailListReads * 2,
    );
    expect(large.fileDiffReads).toBeLessThanOrEqual(small.fileDiffReads * 2);
  });

  it("stays flat when the streaming tail is re-created every delta", () => {
    const small = measureAppendCost({ length: 100, churnTail: 8 });
    const large = measureAppendCost({ length: 5_000, churnTail: 8 });

    expect(large.entryReads).toBeLessThanOrEqual(small.entryReads * 2);
    expect(large.detailListReads).toBeLessThanOrEqual(
      small.detailListReads * 2,
    );
    expect(large.fileDiffReads).toBeLessThanOrEqual(small.fileDiffReads * 2);
  });

  it("keeps a live cumulative diff overlay off the transcript walk", () => {
    const measureLiveDiffCost = (length: number): Counters => {
      const counters = createCounters();
      const transcript = buildTranscript(length, counters);

      const livePendingEntry = (
        revision: number,
      ): AppServerThreadActivityEntry =>
        instrumentEntry(
          {
            type: "activity",
            id: "live-diff-turn-live",
            createdAt: 9_000 + revision,
            summary: "activity",
            turn: { id: "turn-live" },
            details: [
              {
                id: "live-diff-turn-live-1",
                kind: "write",
                label: "Update live.ts",
                path: "/repo/src/live.ts",
                fileDiff: {
                  kind: "update",
                  diff: `@@ -1 +1 @@\n-old\n+new ${revision}`,
                  additions: revision,
                  removals: 0,
                },
              },
            ],
          },
          counters,
        );

      const collector = createEditedFileGroupsCollector();
      collector.collect({
        entries: instrumentEntries(transcript.slice(0), counters),
        activeTurnId: "turn-live",
        livePendingEntry: livePendingEntry(1),
      });

      // A live-diff delta changes only the overlay — no entry is appended.
      const measured = instrumentEntries(transcript.slice(0), counters);
      reset(counters);
      collector.collect({
        entries: measured,
        activeTurnId: "turn-live",
        livePendingEntry: livePendingEntry(2),
      });
      return snapshot(counters);
    };

    const small = measureLiveDiffCost(200);
    const large = measureLiveDiffCost(5_000);

    expect(large.entryReads).toBeLessThanOrEqual(small.entryReads * 2);
    expect(large.detailListReads).toBeLessThanOrEqual(
      small.detailListReads * 2,
    );
    expect(large.fileDiffReads).toBeLessThanOrEqual(small.fileDiffReads * 2);
  });
});
