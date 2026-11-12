import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
} from "@pwragent/shared";
import { TranscriptWorkPhaseGroup } from "../TranscriptWorkPhaseGroup";
import {
  buildWorkPhaseDisplayItems,
  isRunnableToolActivity,
} from "../work-phase-display-items";

afterEach(cleanup);

// The rule: inside an open work group, a model that makes one tool call per
// step reads like one that batches its calls. One-call activities draw as
// rows with no header of their own, so the only collapsible headers are the
// group's toggle and one per activity that batched several calls, and every
// row is still on screen exactly once.

type DetailShape = "read" | "search" | "list" | "command";
type EntryShape =
  | { type: "activity"; details: DetailShape[] }
  | { type: "message" };

const detailShape = fc.constantFrom<DetailShape>("read", "search", "list", "command");
const entryShape: fc.Arbitrary<EntryShape> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      type: fc.constant("activity" as const),
      details: fc.array(detailShape, { minLength: 1, maxLength: 4 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("message" as const) }) },
);

function buildDetail(shape: DetailShape, id: string): AppServerThreadActivityDetail {
  switch (shape) {
    case "read":
      return {
        id,
        kind: "read",
        label: `Read ${id}.ts (0ms)`,
        path: `/repo/src/${id}.ts`,
        status: "completed",
      };
    case "search":
      return {
        id,
        kind: "read",
        label: `Searched "needle-${id}" (0ms)`,
        path: "src",
        status: "completed",
      };
    case "list":
      return { id, kind: "read", label: `Listed dir-${id} (0ms)`, status: "completed" };
    case "command":
      return {
        id,
        kind: "command",
        label: `pnpm check ${id} (1.2s)`,
        command: {
          displayCommand: `pnpm check ${id}`,
          source: "shell",
          output: `ok ${id}`,
          exitCode: 0,
        },
        status: "completed",
      };
  }
}

const turn = { id: "turn-1", status: "completed" as const, durationMs: 120_000 };

function buildEntries(shapes: EntryShape[]): AppServerThreadEntry[] {
  return shapes.map((shape, index): AppServerThreadEntry => {
    if (shape.type === "message") {
      return {
        type: "message",
        id: `message-${index}`,
        role: "assistant",
        phase: "commentary",
        text: `Checking step ${index}.`,
        turn,
      };
    }
    return {
      type: "activity",
      id: `activity-${index}`,
      // The replay summary never repeats a row's label, so the header and
      // the rows are told apart by text.
      summary: `Activity ${index} summary`,
      status: "completed",
      details: shape.details.map((detail, detailIndex) =>
        buildDetail(detail, `d${index}x${detailIndex}`)),
      turn,
    };
  });
}

function renderOpenGroup(entries: AppServerThreadEntry[]) {
  return render(
    <TranscriptWorkPhaseGroup
      collapsible
      expanded
      // Every batched activity starts open so its rows can be counted.
      expandedActivityIds={new Set(entries.map((entry) => entry.id))}
      entries={entries}
      label="Worked for 2m"
      skills={[]}
      onToggle={vi.fn()}
    />,
  );
}

describe("work group activity runs", () => {
  it("draws no collapsible header for a one-call activity, and every row once", () => {
    fc.assert(
      fc.property(fc.array(entryShape, { minLength: 1, maxLength: 14 }), (shapes) => {
        const entries = buildEntries(shapes);
        const activities = entries.filter(
          (entry): entry is AppServerThreadActivityEntry => entry.type === "activity",
        );
        const multiDetailCount = activities.filter((entry) => entry.details.length > 1).length;
        const { container, unmount } = renderOpenGroup(entries);
        try {
          const headers = container.querySelectorAll(
            ".transcript-work-phase-group__toggle, .transcript-activity__toggle",
          );
          expect(headers.length).toBeLessThanOrEqual(multiDetailCount + 1);

          const rowLabels = [
            ...container.querySelectorAll(".transcript-activity__detail-label"),
          ].map((element) => element.textContent);
          const expectedLabels = activities.flatMap((entry) =>
            entry.details.map((detail) => detail.label));
          // In transcript order, each exactly once.
          expect(rowLabels).toEqual(expectedLabels);
        } finally {
          unmount();
        }
      }),
      { numRuns: 60 },
    );
  });

  it("keeps every entry once, in order, and folds each maximal one-call run", () => {
    fc.assert(
      fc.property(fc.array(entryShape, { maxLength: 20 }), (shapes) => {
        const entries = buildEntries(shapes);
        const items = buildWorkPhaseDisplayItems(entries);
        const flattened = items.flatMap((item) =>
          item.type === "activityRun" ? item.entries : [item.entry]);
        expect(flattened).toEqual(entries);
        items.forEach((item, index) => {
          if (item.type === "activityRun") {
            expect(item.entries.length).toBeGreaterThan(0);
            expect(item.entries.every(isRunnableToolActivity)).toBe(true);
            // Two runs never touch: a run ends only where a kept entry is.
            expect(items[index + 1]?.type).not.toBe("activityRun");
          } else {
            expect(isRunnableToolActivity(item.entry)).toBe(false);
          }
        });
      }),
    );
  });
});

describe("activities that keep their header", () => {
  it("leaves notices, deferred details and thread tools out of a run", () => {
    const base: AppServerThreadActivityEntry = {
      type: "activity",
      id: "activity-base",
      summary: "Explored 1 file",
      details: [{ id: "d", kind: "read", label: "Read a.ts", path: "/repo/a.ts" }],
    };
    expect(isRunnableToolActivity(base)).toBe(true);
    expect(isRunnableToolActivity({ ...base, tone: "warning" })).toBe(false);
    // A live bucket that holds one call now gains more as the turn runs.
    expect(isRunnableToolActivity({ ...base, id: "live-tools-turn-1-0" })).toBe(false);
    expect(isRunnableToolActivity({
      ...base,
      detailsRef: {
        backend: "codex",
        threadId: "thread",
        turnId: "turn",
        entryId: base.id,
        revision: "r",
      },
    })).toBe(false);
    // A synthetic notice row (a repair, a question) is read-kind but not a
    // tool row, so its summary stays the header.
    expect(isRunnableToolActivity({
      ...base,
      summary: "Thread repair succeeded",
      details: [{ id: "d", kind: "read", label: "Removed 2 invalid message ids" }],
    })).toBe(false);
    for (const rawCommand of [
      "pwragent.read_thread",
      "mcp__pwragent__watch_thread_pull_request",
    ]) {
      expect(isRunnableToolActivity({
        ...base,
        details: [{
          id: "d",
          kind: "command",
          label: "Tool call",
          command: { displayCommand: rawCommand, rawCommand, source: "tool" },
        }],
      })).toBe(false);
    }
  });
});
