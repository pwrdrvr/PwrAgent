import { describe, expect, it } from "vitest";
import type {
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
} from "@pwragent/shared";
import {
  MAX_RETAINED_TURN_GROUPS,
  collectEditedFileGroups,
  editGroupPaths,
  flattenEditedFileGroups,
  summarizeEditedFileGroups,
} from "../edited-file-groups";

let detailCounter = 0;

function fileDiffDetail(params: {
  path: string;
  additions?: number;
  removals?: number;
  kind?: "add" | "delete" | "update";
  diffRefKey?: string;
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
      diff: params.diffRefKey ? "" : `diff for ${params.path} (#${detailCounter})`,
      ...(params.diffRefKey
        ? {
            diffRef: {
              source: "thread" as const,
              key: params.diffRefKey,
              backend: "codex" as const,
              threadId: "thread-1",
              entryId: "entry-1",
              detailId: `detail-${detailCounter}`,
            },
          }
        : {}),
      additions: params.additions ?? 1,
      removals: params.removals ?? 0,
    },
  };
}

function activityEntry(params: {
  createdAt?: number;
  id: string;
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

describe("editGroupPaths", () => {
  it("collects the group's distinct edited file paths", () => {
    const [group] = collectEditedFileGroups({
      entries: [
        activityEntry({
          id: "a1",
          turnId: "turn-1",
          details: [
            fileDiffDetail({ path: "src/a.ts" }),
            fileDiffDetail({ path: "src/b.ts" }),
          ],
        }),
      ],
    });
    expect(editGroupPaths(group).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("collectEditedFileGroups", () => {
  it("groups edits per turn, newest first, merging repeat edits to the same file", () => {
    const groups = collectEditedFileGroups({
      entries: [
        activityEntry({
          id: "a1",
          turnId: "turn-1",
          details: [
            fileDiffDetail({ path: "src/a.ts", additions: 2 }),
            fileDiffDetail({ path: "src/a.ts", additions: 3, removals: 1 }),
          ],
        }),
        activityEntry({
          id: "a2",
          turnId: "turn-2",
          details: [fileDiffDetail({ path: "src/b.ts", additions: 5 })],
        }),
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe("turn-2");
    expect(groups[1].key).toBe("turn-1");
    // turn-1's two edits to src/a.ts merged into one row with summed counts.
    expect(groups[1].details).toHaveLength(1);
    expect(groups[1].details[0].fileDiff?.additions).toBe(5);
    expect(groups[1].details[0].fileDiff?.removals).toBe(1);
    // Summary is count-only; +/- live on the group's additions/removals
    // (rendered via the shared DiffStat chip).
    expect(groups[1].summary).toBe("Edited 1 file");
    expect(groups[1].additions).toBe(5);
    expect(groups[1].removals).toBe(1);
  });

  it("keeps merged lazy diff refs fetchable instead of marking the row omitted", () => {
    const groups = collectEditedFileGroups({
      entries: [
        activityEntry({
          id: "a1",
          turnId: "turn-1",
          details: [
            fileDiffDetail({
              path: "src/a.ts",
              additions: 2,
              diffRefKey: "thread:one",
            }),
            fileDiffDetail({
              path: "src/a.ts",
              additions: 3,
              removals: 1,
              diffRefKey: "thread:two",
            }),
          ],
        }),
      ],
    });

    const fileDiff = groups[0]?.details[0]?.fileDiff;
    expect(fileDiff).toMatchObject({
      diff: "",
      additions: 5,
      removals: 1,
      diffRef: expect.objectContaining({ key: "thread:two" }),
      diffRefs: [
        expect.objectContaining({ key: "thread:one" }),
        expect.objectContaining({ key: "thread:two" }),
      ],
    });
    expect(fileDiff?.omittedReason).toBeUndefined();
  });

  it("prefers a turn's live cumulative diff entry over its per-edit entries", () => {
    const groups = collectEditedFileGroups({
      entries: [
        activityEntry({
          id: "item-1",
          turnId: "turn-1",
          details: [fileDiffDetail({ path: "src/a.ts", additions: 100 })],
        }),
        activityEntry({
          id: "live-diff-turn-1",
          turnId: "turn-1",
          details: [fileDiffDetail({ path: "src/a.ts", additions: 4 })],
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].additions).toBe(4);
  });

  it("accumulates every turn's edits and never clears them on its own", () => {
    // Commit/push lifecycle is resolved against the live worktree
    // (resolveEditCommitStates), not by clearing groups here — so all turns
    // stay viewable regardless of any git commands in the transcript.
    const groups = collectEditedFileGroups({
      entries: [
        activityEntry({
          id: "a1",
          turnId: "turn-1",
          details: [fileDiffDetail({ path: "src/a.ts" })],
        }),
        activityEntry({
          id: "a2",
          turnId: "turn-2",
          details: [fileDiffDetail({ path: "src/b.ts" })],
        }),
        activityEntry({
          id: "a3",
          turnId: "turn-3",
          details: [fileDiffDetail({ path: "src/c.ts" })],
        }),
      ],
    });

    expect(groups.map((group) => group.key)).toEqual([
      "turn-3",
      "turn-2",
      "turn-1",
    ]);
  });

  it("starts forked-thread edit history at the fork boundary", () => {
    const groups = collectEditedFileGroups({
      entries: [
        activityEntry({
          id: "ancestor-a1",
          createdAt: 1_000,
          turnId: "ancestor-turn-1",
          details: [fileDiffDetail({ path: "src/ancestor.ts", additions: 3 })],
        }),
        activityEntry({
          id: "fork-a1",
          createdAt: 2_000,
          turnId: "fork-turn-1",
          details: [fileDiffDetail({ path: "src/fork.ts", additions: 5 })],
        }),
      ],
      forkCreatedAt: 1_500,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("fork-turn-1");
    expect(groups[0].details.map((detail) => detail.path)).toEqual(["src/fork.ts"]);
  });

  it("renders the live pending cumulative diff as the newest group", () => {
    const groups = collectEditedFileGroups({
      entries: [
        activityEntry({
          id: "a1",
          turnId: "turn-1",
          details: [fileDiffDetail({ path: "src/a.ts" })],
        }),
      ],
      activeTurnId: "turn-2",
      livePendingEntry: activityEntry({
        id: "live-diff-turn-2",
        turnId: "turn-2",
        details: [fileDiffDetail({ path: "src/b.ts", additions: 7 })],
      }),
    });

    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe("turn-2");
    expect(groups[0].live).toBe(true);
    expect(groups[0].additions).toBe(7);
    expect(groups[1].live).toBe(false);
  });

  it("ignores activity entries whose details carry no fileDiff", () => {
    const groups = collectEditedFileGroups({
      entries: [
        activityEntry({
          id: "a1",
          turnId: "turn-1",
          details: [
            {
              id: "plain",
              kind: "write",
              label: "Update x.ts",
              path: "src/x.ts",
            },
          ],
        }),
      ],
    });
    expect(groups).toHaveLength(0);
  });

  it("caps retained turn-groups at MAX_RETAINED_TURN_GROUPS, keeping the newest", () => {
    const turnCount = MAX_RETAINED_TURN_GROUPS + 2;
    const groups = collectEditedFileGroups({
      entries: Array.from({ length: turnCount }, (_, index) =>
        activityEntry({
          id: `a${index + 1}`,
          turnId: `turn-${index + 1}`,
          details: [fileDiffDetail({ path: `src/file-${index + 1}.ts` })],
        }),
      ),
    });

    expect(groups).toHaveLength(MAX_RETAINED_TURN_GROUPS);
    // Newest-first: the most recent turn leads, the two oldest dropped off.
    expect(groups[0].key).toBe(`turn-${turnCount}`);
    expect(groups.at(-1)?.key).toBe("turn-3");
    expect(groups.some((group) => group.key === "turn-1")).toBe(false);
    expect(groups.some((group) => group.key === "turn-2")).toBe(false);
  });
});

describe("flattenEditedFileGroups", () => {
  it("merges the same file across turns with summed counts and stacked diffs", () => {
    const groups = collectEditedFileGroups({
      entries: [
        activityEntry({
          id: "a1",
          turnId: "turn-1",
          details: [fileDiffDetail({ path: "src/a.ts", additions: 2, removals: 1 })],
        }),
        activityEntry({
          id: "a2",
          turnId: "turn-2",
          details: [
            fileDiffDetail({ path: "src/a.ts", additions: 3 }),
            fileDiffDetail({ path: "src/b.ts", additions: 4 }),
          ],
        }),
      ],
    });

    const flattened = flattenEditedFileGroups(groups);
    expect(flattened).toHaveLength(2);
    const fileA = flattened.find((detail) => detail.path === "src/a.ts");
    expect(fileA?.fileDiff?.additions).toBe(5);
    expect(fileA?.fileDiff?.removals).toBe(1);
    // Oldest diff first in the stacked text.
    expect(fileA?.fileDiff?.diff.indexOf("(#")).toBeGreaterThanOrEqual(0);
  });
});

describe("summarizeEditedFileGroups", () => {
  it("returns undefined with no groups and appends the turn count with several", () => {
    expect(summarizeEditedFileGroups([])).toBeUndefined();

    const groups = collectEditedFileGroups({
      entries: [
        activityEntry({
          id: "a1",
          turnId: "turn-1",
          details: [fileDiffDetail({ path: "src/a.ts", additions: 2, removals: 1 })],
        }),
        activityEntry({
          id: "a2",
          turnId: "turn-2",
          details: [fileDiffDetail({ path: "src/b.ts", additions: 4 })],
        }),
      ],
    });
    expect(summarizeEditedFileGroups(groups)).toBe(
      "Edited 2 files, +6, -1 · 2 turns",
    );

    const single = collectEditedFileGroups({
      entries: [
        activityEntry({
          id: "a1",
          turnId: "turn-1",
          details: [fileDiffDetail({ path: "src/a.ts", additions: 2, removals: 1 })],
        }),
      ],
    });
    expect(summarizeEditedFileGroups(single)).toBe("Edited 1 file, +2, -1");
  });
});
