import { describe, expect, it } from "vitest";
import type {
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
} from "@pwragent/shared";
import {
  MAX_RETAINED_TURN_GROUPS,
  collectEditedFileGroups,
  createEditedFileGroupsCollector,
  type EditedFileGroupsInput,
} from "../edited-file-groups";

/**
 * The incremental collector must be indistinguishable from a full recompute.
 * `edited-file-groups.test.ts` is the behavioral contract for the derivation
 * itself; this file replays streaming-shaped inputs through the collector and
 * compares every step against `collectEditedFileGroups` on the same input.
 */

let detailCounter = 0;

function fileDiffDetail(params: {
  path: string;
  additions?: number;
  removals?: number;
  kind?: "add" | "delete" | "update";
}): AppServerThreadActivityDetail {
  detailCounter += 1;
  const kind = params.kind ?? "update";
  return {
    id: `detail-${detailCounter}`,
    kind: "write",
    label: `${kind[0].toUpperCase()}${kind.slice(1)} ${params.path.split("/").pop()}`,
    path: params.path,
    fileDiff: {
      kind,
      diff: `diff for ${params.path} (#${detailCounter})`,
      additions: params.additions ?? 1,
      removals: params.removals ?? 0,
    },
  };
}

function activityEntry(params: {
  id: string;
  createdAt?: number;
  turnId?: string;
  details: AppServerThreadActivityDetail[];
}): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: params.id,
    ...(params.createdAt !== undefined ? { createdAt: params.createdAt } : {}),
    summary: "activity",
    details: params.details,
    ...(params.turnId ? { turn: { id: params.turnId } } : {}),
  };
}

/**
 * Replay a transcript one entry at a time, asserting after each delta that the
 * collector agrees with a from-scratch recompute. `snapshot` builds the array
 * the caller would hand us for a given length — streaming always produces a
 * fresh array identity, and some scenarios also re-create entry objects.
 */
function expectIncrementalParity(params: {
  length: number;
  snapshot: (length: number) => AppServerThreadEntry[];
  rest?: (length: number) => Omit<EditedFileGroupsInput, "entries">;
}): void {
  const collector = createEditedFileGroupsCollector();
  for (let length = 1; length <= params.length; length += 1) {
    const rest = params.rest?.(length) ?? {};
    const incremental = collector.collect({
      entries: params.snapshot(length),
      ...rest,
    });
    const recomputed = collectEditedFileGroups({
      entries: params.snapshot(length),
      ...rest,
    });
    expect(incremental, `delta ${length}`).toEqual(recomputed);
  }
}

describe("createEditedFileGroupsCollector", () => {
  it("matches a full recompute while a transcript streams in", () => {
    const transcript = Array.from({ length: 60 }, (_, index) =>
      activityEntry({
        id: `entry-${index}`,
        createdAt: 1_000 + index,
        turnId: `turn-${Math.floor(index / 4)}`,
        details: [
          fileDiffDetail({
            path: `/repo/src/file-${index % 3}.ts`,
            additions: index,
            removals: index % 2,
          }),
        ],
      }),
    );

    expectIncrementalParity({
      length: transcript.length,
      snapshot: (length) => transcript.slice(0, length),
    });
  });

  it("matches a full recompute past the retained turn-group cap", () => {
    const turnCount = MAX_RETAINED_TURN_GROUPS * 3;
    const transcript = Array.from({ length: turnCount }, (_, index) =>
      activityEntry({
        id: `entry-${index}`,
        createdAt: 1_000 + index,
        turnId: `turn-${index}`,
        details: [fileDiffDetail({ path: `/repo/src/file-${index}.ts` })],
      }),
    );

    expectIncrementalParity({
      length: transcript.length,
      snapshot: (length) => transcript.slice(0, length),
    });
  });

  it("matches a full recompute for stacked add/delete/update on one file", () => {
    // `mergeFileDiffDetail` is order-sensitive (a delete wins, an add sticks),
    // so a collector that folds in a different order than a single pass would
    // diverge here even though counts still add up.
    const kinds = ["add", "update", "delete", "update", "add"] as const;
    const transcript = kinds.map((kind, index) =>
      activityEntry({
        id: `entry-${index}`,
        createdAt: 1_000 + index,
        turnId: "turn-1",
        details: [fileDiffDetail({ path: "/repo/src/one.ts", kind })],
      }),
    );

    expectIncrementalParity({
      length: transcript.length,
      snapshot: (length) => transcript.slice(0, length),
    });
  });

  it("matches a full recompute when the streaming tail is re-created", () => {
    const transcript = Array.from({ length: 40 }, (_, index) =>
      activityEntry({
        id: `entry-${index}`,
        createdAt: 1_000 + index,
        turnId: `turn-${Math.floor(index / 4)}`,
        details: [fileDiffDetail({ path: `/repo/src/file-${index % 5}.ts` })],
      }),
    );

    expectIncrementalParity({
      length: transcript.length,
      snapshot: (length) => {
        const slice = transcript.slice(0, length);
        // The last few entries arrive as fresh objects every delta, the way
        // pending entries do as they resolve against the persisted replay.
        for (let index = Math.max(0, length - 5); index < length; index += 1) {
          slice[index] = { ...(slice[index] as AppServerThreadActivityEntry) };
        }
        return slice;
      },
    });
  });

  it("matches a full recompute across a live cumulative diff overlay", () => {
    const transcript = Array.from({ length: 12 }, (_, index) =>
      activityEntry({
        id: `entry-${index}`,
        createdAt: 1_000 + index,
        turnId: `turn-${Math.floor(index / 4)}`,
        details: [fileDiffDetail({ path: `/repo/src/file-${index % 3}.ts` })],
      }),
    );

    expectIncrementalParity({
      length: transcript.length,
      snapshot: (length) => transcript.slice(0, length),
      rest: (length) => ({
        activeTurnId: "turn-live",
        livePendingEntry: activityEntry({
          id: "live-diff-turn-live",
          createdAt: 5_000 + length,
          turnId: "turn-live",
          details: Array.from({ length: (length % 3) + 1 }, (_, fileIndex) =>
            fileDiffDetail({
              path: `/repo/src/live-${fileIndex}.ts`,
              additions: length,
            }),
          ),
        }),
      }),
    });
  });

  it("matches a full recompute when the live turn also has per-item entries", () => {
    // The live cumulative entry is authoritative for its turn; per-item
    // entries from the same turn must stay ignored as they stream in.
    const transcript = [
      activityEntry({
        id: "entry-0",
        createdAt: 1_000,
        turnId: "turn-1",
        details: [fileDiffDetail({ path: "/repo/src/a.ts", additions: 100 })],
      }),
      activityEntry({
        id: "live-diff-turn-1",
        createdAt: 1_001,
        turnId: "turn-1",
        details: [fileDiffDetail({ path: "/repo/src/a.ts", additions: 4 })],
      }),
      activityEntry({
        id: "entry-2",
        createdAt: 1_002,
        turnId: "turn-1",
        details: [fileDiffDetail({ path: "/repo/src/b.ts", additions: 7 })],
      }),
    ];

    expectIncrementalParity({
      length: transcript.length,
      snapshot: (length) => transcript.slice(0, length),
    });
  });

  it("matches a full recompute past a fork boundary", () => {
    const transcript = [
      ...Array.from({ length: 6 }, (_, index) =>
        activityEntry({
          id: `ancestor-${index}`,
          createdAt: 1_000 + index,
          turnId: `ancestor-turn-${index}`,
          details: [fileDiffDetail({ path: `/repo/src/ancestor-${index}.ts` })],
        }),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        activityEntry({
          id: `fork-${index}`,
          createdAt: 3_000 + index,
          turnId: `fork-turn-${index}`,
          details: [fileDiffDetail({ path: `/repo/src/fork-${index}.ts` })],
        }),
      ),
    ];

    expectIncrementalParity({
      length: transcript.length,
      snapshot: (length) => transcript.slice(0, length),
      rest: () => ({ forkCreatedAt: 2_000 }),
    });
  });

  it("recomputes when the transcript is replaced wholesale", () => {
    const original = Array.from({ length: 8 }, (_, index) =>
      activityEntry({
        id: `entry-${index}`,
        createdAt: 1_000 + index,
        turnId: `turn-${index}`,
        details: [fileDiffDetail({ path: `/repo/src/file-${index}.ts` })],
      }),
    );
    const collector = createEditedFileGroupsCollector();
    collector.collect({ entries: original });

    // A fresh read of a different thread: same shape, all-new identities and
    // different content. Nothing of the previous fold may survive.
    const replacement = Array.from({ length: 3 }, (_, index) =>
      activityEntry({
        id: `other-${index}`,
        createdAt: 7_000 + index,
        turnId: `other-turn-${index}`,
        details: [fileDiffDetail({ path: `/repo/src/other-${index}.ts` })],
      }),
    );

    expect(collector.collect({ entries: replacement })).toEqual(
      collectEditedFileGroups({ entries: replacement }),
    );
  });

  it("keeps unchanged groups referentially stable across deltas", () => {
    const transcript = Array.from({ length: 12 }, (_, index) =>
      activityEntry({
        id: `entry-${index}`,
        createdAt: 1_000 + index,
        turnId: `turn-${index}`,
        details: [fileDiffDetail({ path: `/repo/src/file-${index}.ts` })],
      }),
    );
    const collector = createEditedFileGroupsCollector();

    const before = collector.collect({ entries: transcript.slice(0, 6) });
    const after = collector.collect({ entries: transcript.slice(0, 7) });

    // Only the newest group is new; the settled ones keep their identity so
    // the rail's rows do not re-render (let alone remount) per delta.
    expect(after[0]).not.toBe(before[0]);
    expect(after.slice(1)).toEqual(before);
    for (const [index, group] of before.entries()) {
      expect(after[index + 1]).toBe(group);
    }
  });

  it("returns the identical array when a delta changes nothing", () => {
    const transcript = Array.from({ length: 5 }, (_, index) =>
      activityEntry({
        id: `entry-${index}`,
        createdAt: 1_000 + index,
        turnId: `turn-${index}`,
        details: [fileDiffDetail({ path: `/repo/src/file-${index}.ts` })],
      }),
    );
    const collector = createEditedFileGroupsCollector();

    const first = collector.collect({ entries: transcript.slice(0) });
    // A re-render with a fresh array identity over the same entries — every
    // streamed delta that touches no file does exactly this.
    const second = collector.collect({ entries: transcript.slice(0) });
    expect(second).toBe(first);
  });
});
