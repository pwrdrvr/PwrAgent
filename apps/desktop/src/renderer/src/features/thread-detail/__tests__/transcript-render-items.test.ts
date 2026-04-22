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
      type: "commentaryGroup",
      hiddenMessages: entries.slice(0, 3),
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

  it("keeps tool activity visible while eliding completed commentary", () => {
    const first = commentary("c1", "First scan.");
    const activity: AppServerThreadActivityEntry = {
      type: "activity",
      id: "tool-1",
      summary: "Read one file",
      details: [],
    };
    const second = commentary("c2", "Second scan.");
    const third = commentary("c3", "Third scan.");
    const fourth = commentary("c4", "Fourth scan.");

    const items = buildTranscriptRenderItems({
      entries: [first, activity, second, third, fourth],
    });

    expect(items).toEqual([
      {
        type: "commentaryGroup",
        id: "commentary:c1:c4:complete",
        hiddenMessages: [first, second, third, fourth],
      },
      { type: "entry", entry: activity },
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

function commentary(id: string, text: string): AppServerThreadMessageEntry {
  return {
    type: "message",
    id,
    role: "assistant",
    phase: "commentary",
    text,
  };
}

function final(id: string, text: string): AppServerThreadEntry {
  return {
    type: "message",
    id,
    role: "assistant",
    phase: "final",
    text,
  };
}
