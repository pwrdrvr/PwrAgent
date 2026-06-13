import { describe, expect, it } from "vitest";
import type {
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
} from "@pwragent/shared";
import {
  collectEditedFileGroups,
  commandLooksLikeGitCommit,
  flattenEditedFileGroups,
  summarizeEditedFileGroups,
} from "../edited-file-groups";

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
  turnId?: string;
  details: AppServerThreadActivityDetail[];
}): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: params.id,
    summary: "activity",
    details: params.details,
    ...(params.turnId ? { turn: { id: params.turnId } } : {}),
  };
}

function commitDetail(params?: {
  command?: string;
  exitCode?: number;
  status?: "completed" | "failed";
}): AppServerThreadActivityDetail {
  detailCounter += 1;
  return {
    id: `commit-${detailCounter}`,
    kind: "command",
    label: "git commit",
    status: params?.status ?? "completed",
    command: {
      displayCommand: params?.command ?? 'git commit -m "checkpoint"',
      ...(params?.exitCode !== undefined ? { exitCode: params.exitCode } : {}),
    },
  };
}

function messageEntry(turnId: string): AppServerThreadEntry {
  return {
    type: "message",
    id: `message-${turnId}`,
    role: "assistant",
    text: "done",
    turn: { id: turnId },
  };
}

describe("commandLooksLikeGitCommit", () => {
  it.each([
    ['git commit -m "fix"', true],
    ["git add -A && git commit -m fix", true],
    ["git -C /repo commit --amend", true],
    ["git -c user.name=x commit", true],
    ["git log --oneline", false],
    ["echo commit", false],
    ["git status", false],
    ["pnpm test && git push", false],
  ])("%s → %s", (command, expected) => {
    expect(commandLooksLikeGitCommit(command)).toBe(expected);
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
    expect(groups[1].summary).toBe("Edited 1 file, +5, -1");
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

  it("clears groups up to and including a committed turn once a later turn exists", () => {
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
          details: [fileDiffDetail({ path: "src/b.ts" }), commitDetail()],
        }),
        activityEntry({
          id: "a3",
          turnId: "turn-3",
          details: [fileDiffDetail({ path: "src/c.ts" })],
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("turn-3");
  });

  it("keeps committed groups visible while the commit turn is still the last turn", () => {
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
          details: [fileDiffDetail({ path: "src/b.ts" }), commitDetail()],
        }),
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe("turn-2");
    expect(groups[0].committed).toBe(true);
    expect(groups[1].key).toBe("turn-1");
  });

  it("treats a message-only later turn as 'next turn started' for clearing", () => {
    const groups = collectEditedFileGroups({
      entries: [
        activityEntry({
          id: "a1",
          turnId: "turn-1",
          details: [fileDiffDetail({ path: "src/a.ts" }), commitDetail()],
        }),
        messageEntry("turn-2"),
      ],
    });

    expect(groups).toHaveLength(0);
  });

  it("treats an active turn id as 'next turn started' for clearing", () => {
    const entries = [
      activityEntry({
        id: "a1",
        turnId: "turn-1",
        details: [fileDiffDetail({ path: "src/a.ts" }), commitDetail()],
      }),
    ];

    expect(collectEditedFileGroups({ entries })).toHaveLength(1);
    expect(
      collectEditedFileGroups({ entries, activeTurnId: "turn-2" }),
    ).toHaveLength(0);
    // The commit turn itself being active must NOT clear its own group.
    expect(
      collectEditedFileGroups({ entries, activeTurnId: "turn-1" }),
    ).toHaveLength(1);
  });

  it("does not clear on a failed git commit", () => {
    const groups = collectEditedFileGroups({
      entries: [
        activityEntry({
          id: "a1",
          turnId: "turn-1",
          details: [
            fileDiffDetail({ path: "src/a.ts" }),
            commitDetail({ exitCode: 1, status: "failed" }),
          ],
        }),
        activityEntry({
          id: "a2",
          turnId: "turn-2",
          details: [fileDiffDetail({ path: "src/b.ts" })],
        }),
      ],
    });

    expect(groups).toHaveLength(2);
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
