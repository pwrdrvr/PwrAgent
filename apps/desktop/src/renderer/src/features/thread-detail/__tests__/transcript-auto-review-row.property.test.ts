import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadTurnMetadata,
} from "@pwragent/shared/contracts/normalized-app-server";
import { protocolActivityEntriesAtTurnEnd, applyProtocolActivityNotice } from "../protocol-activity-entries";
import { buildTranscriptRenderItems, type TranscriptRenderItem } from "../transcript-render-items";

// Rule: a turn's grouped auto-review row stays in view after the turn ends,
// until the next turn's replay prunes it. Codex keeps no record of the
// reviews, so this row is their only trace; folded into the turn's collapsed
// work group, it read as gone.
//
// Oracle: the same transcript rendered without the row. Adding the row leaves
// every other render item as it was (it neither joins a group nor splits one)
// and adds one top-level item right after the item holding the entry before it.

type Step = "tool" | "commentary" | "reply";

const turnArb = fc.record({
  steps: fc.array(fc.constantFrom<Step>("tool", "commentary", "reply"), { maxLength: 6 }),
  final: fc.boolean(),
});

function completedTurn(id: string): AppServerThreadTurnMetadata {
  return { id, status: "completed", durationMs: 90_000 };
}

function buildTurn(
  index: number,
  turn: AppServerThreadTurnMetadata,
  spec: { steps: Step[]; final: boolean },
): AppServerThreadEntry[] {
  const entries: AppServerThreadEntry[] = [
    { type: "message", id: `u${index}`, role: "user", text: `Request ${index}.`, turn },
  ];
  spec.steps.forEach((step, stepIndex) => {
    const id = `t${index}-${stepIndex}`;
    entries.push(step === "tool"
      ? {
        type: "activity",
        id,
        summary: "Used 1 tool",
        status: "completed",
        details: [{ id: `${id}-cmd`, kind: "command", label: "pnpm test", status: "completed" }],
        turn,
      }
      : {
        type: "message",
        id,
        role: "assistant",
        text: `Step ${stepIndex}.`,
        ...(step === "commentary" ? { phase: "commentary" as const } : {}),
        turn,
      });
  });
  if (spec.final) {
    entries.push({ type: "message", id: `f${index}`, role: "assistant", text: "Done.", phase: "final", turn });
  }
  return entries;
}

/** The row ThreadView defers at turn end, built by the real notice path. */
function deferredAutoReviewRow(turn: AppServerThreadTurnMetadata): AppServerThreadActivityEntry {
  const live = applyProtocolActivityNotice(
    [],
    {
      method: "warning",
      params: { message: "Automatic approval review approved (risk: low, authorization: high): Runs the tests." },
    },
    { threadId: "thread-1", now: 1_000 },
  );
  const [row] = protocolActivityEntriesAtTurnEnd(live, "completed", turn);
  if (!row) throw new Error("no deferred auto-review row");
  return row;
}

function shape(items: TranscriptRenderItem[]): string[] {
  return items.map((item) =>
    item.type === "workPhaseGroup"
      ? `group[${item.label}](${item.entries.map((entry) => entry.id).join(",")})`
      : `entry:${item.entry.id}`
  );
}

function itemHolding(items: TranscriptRenderItem[], id: string): number {
  return items.findIndex((item) =>
    item.type === "workPhaseGroup"
      ? item.entries.some((entry) => entry.id === id)
      : item.entry.id === id
  );
}

describe("auto-review row after its turn", () => {
  it("renders in view after the work it arrived among, leaving every other item unchanged", () => {
    fc.assert(
      fc.property(
        fc.array(turnArb, { minLength: 1, maxLength: 3 }),
        fc.nat(),
        fc.nat(),
        // The next turn started and its replay has not pruned the row yet.
        fc.option(fc.array(fc.constantFrom<Step>("tool", "commentary"), { minLength: 1, maxLength: 4 })),
        (turns, turnPick, positionPick, nextTurnSteps) => {
          const built = turns.map((spec, index) => buildTurn(index, completedTurn(`turn-${index}`), spec));
          const rowTurn = turnPick % built.length;
          const rowTurnEntries = built[rowTurn]!;
          // Anywhere after the turn's user message.
          const position = 1 + (positionPick % rowTurnEntries.length);
          const row = deferredAutoReviewRow(completedTurn(`turn-${rowTurn}`));

          const activeTurnId = nextTurnSteps ? `turn-${built.length}` : undefined;
          const next = nextTurnSteps
            ? buildTurn(built.length, { id: activeTurnId!, status: "in_progress", startedAt: 0 }, {
              steps: nextTurnSteps,
              final: false,
            })
            : [];
          const base = [...built.flat(), ...next];
          const insertAt = built.slice(0, rowTurn).reduce((sum, entries) => sum + entries.length, 0) + position;
          const withRow = [...base.slice(0, insertAt), row, ...base.slice(insertAt)];

          const render = (entries: AppServerThreadEntry[]) => buildTranscriptRenderItems({
            entries,
            ...(activeTurnId ? { activeTurnId, activeTurnStartedAt: 0 } : {}),
            now: 10_000,
          });
          const without = render(base);
          const withItems = render(withRow);

          const rowItems = withItems.filter((item) => item.type === "entry" && item.entry.id === row.id);
          expect(rowItems, "the row renders as its own item").toHaveLength(1);
          expect(
            shape(withItems).filter((label) => label !== `entry:${row.id}`),
            "the row changes no other item",
          ).toEqual(shape(without));
          const before = withRow[insertAt - 1]!;
          expect(withItems.indexOf(rowItems[0]!)).toBe(itemHolding(withItems, before.id) + 1);
        },
      ),
    );
  });

  it("keeps a turn's answer in view when the row sorts after it", () => {
    const turn = completedTurn("turn-0");
    const entries = buildTurn(0, turn, { steps: ["tool", "reply"], final: false });
    const row = deferredAutoReviewRow(turn);
    expect(shape(buildTranscriptRenderItems({ entries: [...entries, row] }))).toEqual([
      "entry:u0",
      "group[Worked for 1m 30s](t0-0)",
      "entry:t0-1",
      `entry:${row.id}`,
    ]);
  });
});
