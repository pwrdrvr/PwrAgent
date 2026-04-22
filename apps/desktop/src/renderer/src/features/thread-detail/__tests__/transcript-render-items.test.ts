import { describe, expect, it } from "vitest";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
} from "@pwragnt/shared";
import { buildTranscriptRenderItems } from "../transcript-render-items";

describe("buildTranscriptRenderItems", () => {
  it("collapses completed commentary before a final answer", () => {
    const entries = [
      commentary("c1", "First scan."),
      commentary("c2", "Narrowing."),
      commentary("c3", "Found the answer."),
      final("f1", "Final answer."),
    ];

    const items = buildTranscriptRenderItems({ entries });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "workPhaseGroup",
      entries: entries.slice(0, 3),
      label: "3 previous messages",
    });
    expect(items[1]).toMatchObject({ type: "entry", entry: entries[3] });
  });

  it("shows active commentary messages without an elider", () => {
    const entries = [
      commentary("c1", "First scan."),
      commentary("c2", "Narrowing."),
      commentary("c3", "Still working."),
    ];

    const items = buildTranscriptRenderItems({ entries, activeMessageId: "c3" });

    expect(items).toEqual([
      { type: "entry", entry: entries[0] },
      { type: "entry", entry: entries[1] },
      { type: "entry", entry: entries[2] },
    ]);
  });

  it("shows all active commentary messages without an elider", () => {
    const entries = [
      commentary("c1", "First scan."),
      commentary("c2", "Narrowing."),
      commentary("c3", "Still working."),
      commentary("c4", "Checking one more thing."),
      commentary("c5", "Almost done."),
    ];

    const items = buildTranscriptRenderItems({ entries, activeMessageId: "c5" });

    expect(items).toEqual([
      { type: "entry", entry: entries[0] },
      { type: "entry", entry: entries[1] },
      { type: "entry", entry: entries[2] },
      { type: "entry", entry: entries[3] },
      { type: "entry", entry: entries[4] },
    ]);
  });

  it("collapses completed work activity with commentary by turn", () => {
    const turn = completedTurn("turn-1", 524_447);
    const first = commentary("c1", "First scan.", turn);
    const activity: AppServerThreadActivityEntry = {
      type: "activity",
      id: "tool-1",
      summary: "Read one file",
      details: [],
      turn,
    };
    const second = commentary("c2", "Second scan.", turn);
    const finalAnswer = final("f1", "Final answer.", turn);

    const items = buildTranscriptRenderItems({
      entries: [first, activity, second, finalAnswer],
    });

    expect(items).toEqual([
      {
        type: "workPhaseGroup",
        id: "work:turn-1:complete",
        collapsible: true,
        entries: [first, activity, second],
        label: "Worked for 8m 44s",
      },
      { type: "entry", entry: finalAnswer },
    ]);
  });

  it("uses completed turn metadata when live entries have mixed turn status", () => {
    const inProgressTurn = {
      id: "turn-1",
      status: "in_progress" as const,
    };
    const completed = completedTurn("turn-1", 524_447);
    const first = commentary("c1", "First scan.", inProgressTurn);
    const activity: AppServerThreadActivityEntry = {
      type: "activity",
      id: "tool-1",
      summary: "Read one file",
      details: [],
      turn: completed,
    };
    const finalAnswer = final("f1", "Final answer.", completed);

    const items = buildTranscriptRenderItems({
      entries: [first, activity, finalAnswer],
    });

    expect(items).toEqual([
      {
        type: "workPhaseGroup",
        id: "work:turn-1:complete",
        collapsible: true,
        entries: [first, activity],
        label: "Worked for 8m 44s",
      },
      { type: "entry", entry: finalAnswer },
    ]);
  });

  it("shows active work with an elapsed label without collapsing it", () => {
    const turn = {
      id: "turn-1",
      status: "in_progress" as const,
      startedAt: 1_000,
    };
    const first = commentary("c1", "First scan.", turn);
    const activity: AppServerThreadActivityEntry = {
      type: "activity",
      id: "tool-1",
      summary: "Read one file",
      details: [],
      turn,
    };

    const items = buildTranscriptRenderItems({
      entries: [first, activity],
      activeTurnId: "turn-1",
      now: 62_000,
    });

    expect(items).toEqual([
      {
        type: "workPhaseGroup",
        id: "work:turn-1:active",
        collapsible: false,
        entries: [first, activity],
        label: "Working for 1m 01s",
      },
    ]);
  });

  it("uses the active turn start fallback for live work labels", () => {
    const turn = {
      id: "turn-1",
      status: "in_progress" as const,
    };
    const activity: AppServerThreadActivityEntry = {
      type: "activity",
      id: "tool-1",
      summary: "Read one file",
      details: [],
      turn,
    };

    const items = buildTranscriptRenderItems({
      entries: [activity],
      activeTurnId: "turn-1",
      activeTurnStartedAt: 1_000,
      now: 62_000,
    });

    expect(items).toEqual([
      {
        type: "workPhaseGroup",
        id: "work:turn-1:active",
        collapsible: false,
        entries: [activity],
        label: "Working for 1m 01s",
      },
    ]);
  });

  it("keeps completed work collapsed while another turn is active", () => {
    const completed = completedTurn("turn-1", 70_000);
    const active = {
      id: "turn-2",
      status: "in_progress" as const,
      startedAt: 1_000,
    };
    const oldCommentary = commentary("c1", "Earlier scan.", completed);
    const oldActivity: AppServerThreadActivityEntry = {
      type: "activity",
      id: "tool-1",
      summary: "Read one file",
      details: [],
      turn: completed,
    };
    const oldFinal = final("f1", "Earlier final.", completed);
    const activeActivity: AppServerThreadActivityEntry = {
      type: "activity",
      id: "tool-2",
      summary: "Searching Web",
      details: [],
      turn: active,
    };

    const items = buildTranscriptRenderItems({
      entries: [oldCommentary, oldActivity, oldFinal, activeActivity],
      activeTurnId: "turn-2",
      now: 62_000,
    });

    expect(items).toEqual([
      {
        type: "workPhaseGroup",
        id: "work:turn-1:complete",
        collapsible: true,
        entries: [oldCommentary, oldActivity],
        label: "Worked for 1m 10s",
      },
      { type: "entry", entry: oldFinal },
      {
        type: "workPhaseGroup",
        id: "work:turn-2:active",
        collapsible: false,
        entries: [activeActivity],
        label: "Working for 1m 01s",
      },
    ]);
  });

  it("leaves legacy assistant messages alone", () => {
    const legacy: AppServerThreadMessageEntry = {
      type: "message",
      id: "legacy",
      role: "assistant",
      text: "Legacy assistant message.",
    };

    expect(buildTranscriptRenderItems({ entries: [legacy] })).toEqual([
      { type: "entry", entry: legacy },
    ]);
  });
});

function commentary(
  id: string,
  text: string,
  turn?: AppServerThreadMessageEntry["turn"]
): AppServerThreadMessageEntry {
  return {
    type: "message",
    id,
    role: "assistant",
    phase: "commentary",
    text,
    ...(turn ? { turn } : {}),
  };
}

function final(
  id: string,
  text: string,
  turn?: AppServerThreadMessageEntry["turn"]
): AppServerThreadEntry {
  return {
    type: "message",
    id,
    role: "assistant",
    phase: "final",
    text,
    ...(turn ? { turn } : {}),
  };
}

function completedTurn(id: string, durationMs: number): AppServerThreadMessageEntry["turn"] {
  return {
    id,
    status: "completed",
    durationMs,
  };
}
