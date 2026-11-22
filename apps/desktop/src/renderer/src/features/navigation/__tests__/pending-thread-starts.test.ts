import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerPendingThreadStart } from "@pwragent/shared/contracts/normalized-app-server";
import {
  applyPendingThreadStartReport,
  pendingThreadStartOpenTarget,
  pendingThreadStartRows,
  retirePendingThreadStart,
  type PendingThreadStart,
  type PendingThreadStartReport,
} from "../pending-thread-starts";
import { selectUnlandedStartingThreads } from "../StartingThreadRow";

/**
 * The rule the starting row keeps in the list: a start is drawn exactly once
 * from its `starting` report until it is gone. First as its starting row,
 * then as its thread's own row, with no frame showing both or neither. A
 * start the owner refused leaves nothing behind.
 *
 * Steps per start, in the order the owner and the window produce them:
 * `starting`, then for a created thread `landed`, its row read into the
 * list, `ended`, and the retirement the window runs once a read after
 * `ended` returns; for a refused start `starting` then `ended`. The owner
 * reports `landed` before anything else it says about the thread, so the
 * thread's row is never read before it. Several starts interleave, and a
 * report can arrive twice, including after its start retired.
 */

type Step =
  | { kind: "report"; report: PendingThreadStartReport }
  | { kind: "row-read" }
  | { kind: "retire" };

type Scenario = { created: boolean; duplicates: number[] };

const start = (index: number): AppServerPendingThreadStart => ({
  startId: `thread-todo:${index}`,
  title: `Card ${index}`,
  submittedAt: 1_000 + index,
  backend: "codex",
  workMode: "worktree",
  cwd: "/repo/project",
  parentThreadId: "parent",
  parentThreadBackend: "codex",
  progressThread: { backend: "codex", threadId: "parent" },
});

function stepsFor(index: number, scenario: Scenario): Step[] {
  const report = (phase: PendingThreadStartReport["phase"], landed: boolean): Step => ({
    kind: "report",
    report: { start: start(index), phase, ...(landed ? { createdThreadId: `thread-${index}` } : {}) },
  });
  const steps: Step[] = scenario.created
    ? [report("starting", false), report("landed", true), { kind: "row-read" }, report("ended", true), { kind: "retire" }]
    : [report("starting", false), report("ended", false)];
  // A report delivered again, at any later point, changes nothing.
  for (const duplicate of scenario.duplicates) {
    const reports = steps.map((step, at) => ({ step, at })).filter(({ step }) => step.kind === "report");
    const { step, at } = reports[duplicate % reports.length]!;
    steps.splice(at + 1 + (duplicate % (steps.length - at)), 0, step);
  }
  return steps;
}

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc.record({
  created: fc.boolean(),
  duplicates: fc.array(fc.nat({ max: 20 }), { maxLength: 3 }),
});

/** Merges each start's steps in a generated order, keeping each start's own order. */
const interleavingArbitrary = fc.array(scenarioArbitrary, { minLength: 1, maxLength: 4 }).chain((scenarios) => {
  const lists = scenarios.map((scenario, index) => stepsFor(index, scenario));
  const total = lists.reduce((sum, list) => sum + list.length, 0);
  return fc.array(fc.nat({ max: scenarios.length - 1 }), { minLength: total, maxLength: total }).map((picks) => {
    const cursors = lists.map(() => 0);
    const order: { index: number; step: Step }[] = [];
    for (const pick of picks) {
      // The next start, from the pick on, that has a step left.
      for (let offset = 0; offset < lists.length; offset += 1) {
        const index = (pick + offset) % lists.length;
        if (cursors[index]! < lists[index]!.length) {
          order.push({ index, step: lists[index]![cursors[index]!]! });
          cursors[index]! += 1;
          break;
        }
      }
    }
    return { scenarios, order };
  });
});

describe("pending thread starts in the list", () => {
  it("draw each start exactly once from its starting report until it is gone", () => {
    fc.assert(fc.property(interleavingArbitrary, ({ scenarios, order }) => {
      let starts: readonly PendingThreadStart[] = [];
      const retired = new Set<string>();
      const renderedThreadKeys = new Set<string>();
      const begun = new Set<number>();
      const refusedEnded = new Set<number>();
      for (const { index, step } of order) {
        if (step.kind === "report") {
          starts = applyPendingThreadStartReport(starts, step.report, retired);
          if (step.report.phase === "starting") begun.add(index);
          // The window retires a refused start as soon as it ends.
          if (step.report.phase === "ended" && !step.report.createdThreadId) {
            retired.add(step.report.start.startId);
            refusedEnded.add(index);
          }
        } else if (step.kind === "row-read") {
          renderedThreadKeys.add(`codex:thread-${index}`);
        } else {
          retired.add(start(index).startId);
          starts = retirePendingThreadStart(starts, start(index).startId);
        }
        const startingRows = selectUnlandedStartingThreads(pendingThreadStartRows(starts, undefined), renderedThreadKeys);
        scenarios.forEach((_, each) => {
          const drawn = startingRows.filter((row) => row.operationId === start(each).startId).length
            + (renderedThreadKeys.has(`codex:thread-${each}`) ? 1 : 0);
          const expected = begun.has(each) && !refusedEnded.has(each) ? 1 : 0;
          expect(drawn, `start ${each} after ${step.kind}`).toBe(expected);
        });
      }
    }));
  });

  it("files a sub-thread start under its parent and keys its landed thread", () => {
    let starts = applyPendingThreadStartReport([], { start: start(0), phase: "starting" }, new Set());
    expect(pendingThreadStartRows(starts, undefined)).toEqual([expect.objectContaining({
      directoryKey: "directory:/repo/project",
      directoryLabel: "project",
      parentThreadKey: "codex:parent",
      title: "Card 0",
      launchpad: expect.objectContaining({ workMode: "worktree", backend: "codex" }),
    })]);
    expect(pendingThreadStartRows(starts, undefined)[0]).not.toHaveProperty("threadKey");
    starts = applyPendingThreadStartReport(starts, { start: start(0), phase: "landed", createdThreadId: "thread-0" }, new Set());
    expect(pendingThreadStartRows(starts, undefined)[0]).toMatchObject({ threadKey: "codex:thread-0" });
  });

  it("keys a peer parent by its machine, and a parent on this machine locally", () => {
    const onPeer = { ...start(0), parentThreadInstanceId: "peer" };
    const rows = (localInstanceId: string | undefined) => pendingThreadStartRows(
      applyPendingThreadStartReport([], { start: onPeer, phase: "starting" }, new Set()), localInstanceId);
    expect(rows("peer")[0]!.parentThreadKey).toBe("codex:parent");
    expect(rows("this-machine")[0]!.parentThreadKey).not.toBe("codex:parent");
  });

  it("opens the thread whose tray reports the start, then the started thread", () => {
    let starts = applyPendingThreadStartReport([], { start: start(0), phase: "starting" }, new Set());
    const selectionKey = pendingThreadStartRows(starts, undefined)[0]!.selectionKey;
    expect(pendingThreadStartOpenTarget(starts, selectionKey)).toEqual({ backend: "codex", threadId: "parent" });
    starts = applyPendingThreadStartReport(starts, { start: start(0), phase: "landed", createdThreadId: "thread-0" }, new Set());
    expect(pendingThreadStartOpenTarget(starts, selectionKey)).toEqual({ backend: "codex", threadId: "thread-0" });
  });
});
