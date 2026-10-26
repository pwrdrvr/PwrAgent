import { describe, expect, it } from "vitest";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadTurnMetadata,
} from "@pwragent/shared";
import { withRendererSequence } from "../live-transcript-activity";
import {
  insertRowsAboveTurnAnswers,
  lateWorkBelongsAboveAnswer,
  turnAnswerIndexForLateWork,
} from "../turn-answer-placement";

// Codex stamps the final reply with its second-truncated completion; the
// renderer stamps a late work row with the millisecond it saw it.
const turnT = {
  id: "turn-t",
  status: "completed",
  startedAt: 1_792_852_051_000,
  completedAt: 1_792_852_200_000,
} satisfies AppServerThreadTurnMetadata;
const liveTurnT = {
  id: "turn-t",
  status: "in_progress",
  startedAt: 1_792_852_051_000,
} satisfies AppServerThreadTurnMetadata;
const turnV = {
  id: "turn-v",
  status: "completed",
  startedAt: 1_792_853_600_000,
  completedAt: 1_792_853_760_000,
} satisfies AppServerThreadTurnMetadata;

const tUser: AppServerThreadEntry = {
  type: "message", id: "t-user", role: "user", text: "Authorize one packet",
  createdAt: turnT.startedAt, turn: turnT,
};
const tTools: AppServerThreadEntry = {
  type: "activity", id: "activity-exec-t", summary: "Ran 6 commands",
  status: "completed", details: [], turn: turnT,
};
const tFinal: AppServerThreadEntry = {
  type: "message", id: "t-final", role: "assistant", phase: "final",
  text: "The probe is running.", createdAt: turnT.completedAt, turn: turnT,
};
const tTotal: AppServerThreadEntry = {
  type: "activity", id: "live-turn-usage-turn-t", summary: "Turn usage: 26,512 uncached in",
  status: "completed", details: [], createdAt: turnT.completedAt - 300, turn: turnT,
};
const vUser: AppServerThreadEntry = {
  type: "message", id: "v-user", role: "user", text: "Monitor finished",
  createdAt: turnV.startedAt, turn: turnV,
};

function lateWork(
  overrides: Partial<AppServerThreadActivityEntry> = {},
): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: "live-protocol-t",
    summary: "Used 2 tools",
    status: "completed",
    details: [],
    createdAt: turnT.completedAt + 400,
    turn: turnT,
    ...overrides,
  };
}

function ids(entries: AppServerThreadEntry[]): string[] {
  return entries.map((entry) => entry.id);
}

describe("turnAnswerIndexForLateWork", () => {
  it("places a finished turn's late work row above the turn's answer", () => {
    expect(turnAnswerIndexForLateWork([tUser, tTools, tFinal, tTotal], lateWork())).toBe(2);
  });

  it("uses the turn's last reply when an agent tags every reply final", () => {
    const firstReply: AppServerThreadEntry = { ...tFinal, id: "t-first-reply", createdAt: turnT.startedAt + 10_000 };

    expect(turnAnswerIndexForLateWork([tUser, firstReply, tTools, tFinal], lateWork())).toBe(3);
  });

  it("finds a finished turn through its answer when the row carries a live turn", () => {
    const answer = withRendererSequence(tFinal, 4);

    expect(turnAnswerIndexForLateWork([tUser, answer], lateWork({ turn: liveTurnT }))).toBe(1);
  });

  it("leaves work after a reply in a turn that is still running", () => {
    const liveReply: AppServerThreadEntry = { ...tFinal, turn: liveTurnT };

    expect(turnAnswerIndexForLateWork([tUser, liveReply], lateWork({ turn: liveTurnT }))).toBe(-1);
  });

  it("leaves work the renderer saw after the reply below it", () => {
    const answer = withRendererSequence(tFinal, 4);
    const row = withRendererSequence(lateWork(), 5);

    expect(turnAnswerIndexForLateWork([tUser, answer], row)).toBe(-1);
  });

  it("places work the renderer saw before the reply above it", () => {
    const answer = withRendererSequence(tFinal, 6);
    const row = withRendererSequence(lateWork(), 5);

    expect(turnAnswerIndexForLateWork([tUser, answer], row)).toBe(1);
  });

  it("leaves rows that do not fold the answer where they are", () => {
    const entries = [tUser, tFinal];
    const fileDiff = lateWork({
      id: "live-file-change-t",
      details: [{
        id: "diff-1",
        kind: "write",
        label: "src/a.ts",
        fileDiff: { kind: "update", diff: "+a", additions: 1, removals: 0 },
      }],
    });
    const total = lateWork({ id: "live-turn-usage-turn-t", summary: "Turn usage: 1 uncached in" });
    const note: AppServerThreadEntry = {
      type: "message", id: "t-note", role: "assistant", phase: "commentary",
      text: "Noted.", createdAt: turnT.completedAt + 400, turn: turnT,
    };

    expect(turnAnswerIndexForLateWork(entries, fileDiff)).toBe(-1);
    expect(turnAnswerIndexForLateWork(entries, total)).toBe(-1);
    expect(turnAnswerIndexForLateWork(entries, note)).toBe(-1);
  });

  it("returns -1 when the turn has no answer on the list", () => {
    expect(turnAnswerIndexForLateWork([tUser, tTools, vUser], lateWork())).toBe(-1);
  });
});

describe("lateWorkBelongsAboveAnswer", () => {
  it("accepts only a final reply of the row's own turn", () => {
    const vFinal: AppServerThreadEntry = { ...tFinal, id: "v-final", turn: turnV };

    expect(lateWorkBelongsAboveAnswer(lateWork(), tFinal)).toBe(true);
    expect(lateWorkBelongsAboveAnswer(lateWork(), vFinal)).toBe(false);
    expect(lateWorkBelongsAboveAnswer(lateWork(), tTools)).toBe(false);
  });
});

describe("insertRowsAboveTurnAnswers", () => {
  it("inserts each turn's rows above its answer, in order", () => {
    const second = lateWork({ id: "live-tools-t-2", createdAt: turnT.completedAt + 500 });

    expect(ids(insertRowsAboveTurnAnswers(
      [tUser, tTools, tFinal, tTotal, vUser],
      new Map([[turnT.id, [lateWork(), second]]]),
    ))).toEqual([
      "t-user", "activity-exec-t", "live-protocol-t", "live-tools-t-2", "t-final", "live-turn-usage-turn-t", "v-user",
    ]);
  });

  it("appends a row whose turn has no answer on the list", () => {
    const orphan = lateWork({ id: "orphan", turn: { ...turnT, id: "turn-gone" } });

    expect(ids(insertRowsAboveTurnAnswers(
      [tUser, tFinal],
      new Map([["turn-gone", [orphan]]]),
    ))).toEqual(["t-user", "t-final", "orphan"]);
  });

  it("returns the same array when there is nothing to insert", () => {
    const entries = [tUser, tFinal];

    expect(insertRowsAboveTurnAnswers(entries, new Map())).toBe(entries);
  });
});
