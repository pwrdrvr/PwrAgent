import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ThreadMaintenanceProblem, ThreadMaintenanceRunItem } from "@pwragent/shared";
import {
  outcomeText,
  problemsWithoutItems,
  runItemCounts,
  runItemView,
  stageText,
} from "../thread-maintenance-run-items";

const ACTIONS = ["archive", "hibernate", "removeCheckout", "trashCheckout", "removeBuildOutput", "removeEmptyFolders"] as const;
const STAGES = ["waitingForWorker", "checking", "snapshotting", "verifying", "waiting", "removing", "recording"] as const;
const FINAL = ["done", "kept", "failed"] as const;

/**
 * A model of main's runner: `count` items queued in order, a pool of
 * `concurrency` workers, and a clock. Each step either starts the next
 * queued item, advances a running item's stage, or finishes one with an
 * outcome. Every step publishes a snapshot, as main does.
 */
function simulate(count: number, concurrency: number, choices: readonly number[]): ThreadMaintenanceRunItem[][] {
  let clock = 1_000;
  let items: ThreadMaintenanceRunItem[] = Array.from({ length: count }, (_, index) => ({
    itemId: `item-${index}`, step: "hibernate", action: "hibernate", object: `Thread ${index}`,
    path: `/w/${index}/repo`, backend: "codex", threadId: `t-${index}`, status: "queued",
  }));
  const snapshots: ThreadMaintenanceRunItem[][] = [items];
  for (const choice of choices) {
    clock += 1 + (choice % 7);
    const running = items.filter((item) => item.status === "running");
    const queued = items.find((item) => item.status === "queued");
    const kind = choice % 3;
    let next: ThreadMaintenanceRunItem[] | undefined;
    if (kind === 0 && queued && running.length < concurrency) {
      next = items.map((item) => item === queued ? { ...item, status: "running", stage: "checking", startedAt: clock } : item);
    } else if (kind === 1 && running.length) {
      const target = running[choice % running.length]!;
      next = items.map((item) => item === target ? { ...item, stage: STAGES[choice % STAGES.length] } : item);
    } else if (running.length) {
      const target = running[choice % running.length]!;
      const status = FINAL[choice % FINAL.length]!;
      next = items.map((item) => item === target
        ? { ...item, status, stage: undefined, finishedAt: clock, ...(status === "done" ? { allocatedBytesRemoved: choice * 1024 } : { reason: "Uncommitted changes" }) }
        : item);
    }
    if (next) {
      // Rows are immutable snapshots; main may send them in any order.
      items = next;
      snapshots.push(choice % 2 ? [...items].reverse() : items);
    }
  }
  return snapshots;
}

const runArb = fc.record({
  count: fc.integer({ min: 0, max: 30 }),
  concurrency: fc.integer({ min: 1, max: 4 }),
  choices: fc.array(fc.nat({ max: 1000 }), { maxLength: 200 }),
});

const ids = (rows: readonly ThreadMaintenanceRunItem[]) => rows.map((item) => item.itemId);

describe("run items, as a model of main's parallel runner", () => {
  it("lists every item exactly once, under its status, and counts add up", () => {
    fc.assert(fc.property(runArb, ({ count, concurrency, choices }) => {
      for (const snapshot of simulate(count, concurrency, choices)) {
        const view = runItemView(snapshot);
        const listed = [...view.active, ...view.waiting, ...view.failed, ...view.kept, ...view.done];
        expect(ids(listed).sort()).toEqual(ids(snapshot).sort());
        for (const item of view.active) expect(item.status).toBe("running");
        for (const item of view.waiting) expect(item.status).toBe("queued");
        const counts = runItemCounts(view);
        expect(counts.total).toBe(count);
        expect(counts.active).toBeLessThanOrEqual(concurrency);
        expect(counts.finished).toBe(view.failed.length + view.kept.length + view.done.length);
      }
    }));
  });

  // Oracle: rows never move. A finished row stays where it was and later
  // results append; an active row keeps its place among the rows still
  // active; a result is never lost.
  it("never reorders or drops a row as later items start and finish", () => {
    fc.assert(fc.property(runArb, ({ count, concurrency, choices }) => {
      const snapshots = simulate(count, concurrency, choices).map(runItemView);
      for (let index = 1; index < snapshots.length; index += 1) {
        const before = snapshots[index - 1]!;
        const after = snapshots[index]!;
        for (const outcome of ["failed", "kept", "done"] as const) {
          expect(ids(after[outcome]).slice(0, before[outcome].length)).toEqual(ids(before[outcome]));
        }
        const still = new Set(ids(after.active));
        expect(ids(after.active).filter((id) => ids(before.active).includes(id)))
          .toEqual(ids(before.active).filter((id) => still.has(id)));
      }
    }));
  });

  it("says what each stage does, and never claims freed space or the Trash for a hibernation", () => {
    fc.assert(fc.property(fc.constantFrom(...ACTIONS), fc.option(fc.constantFrom(...STAGES), { nil: undefined }),
      fc.nat({ max: 2 ** 40 }), (action, stage, bytes) => {
        const text = stageText({ action, ...(stage ? { stage } : {}) });
        expect(text.length).toBeGreaterThan(0);
        if (stage === "waiting") expect(text).toBe("Waiting for its repository");
        // An accepted item can queue for one of the cleanup workers it
        // shares with background work. That is neither a repository wait
        // nor any removal.
        if (stage === "waitingForWorker") expect(text).toBe("Waiting for a cleanup worker");
        if (stage !== "removing") expect(text).not.toMatch(/remov|delet|trash/i);
        const done = outcomeText({ itemId: "i", step: "hibernate", action, object: "o", status: "done", allocatedBytesRemoved: bytes });
        expect(done).not.toMatch(/freed|recovered/i);
        if (action !== "trashCheckout") {
          expect(text).not.toMatch(/trash/i);
          expect(done).not.toMatch(/trash/i);
        }
        if (bytes) expect(done).toMatch(/allocation removed$/);
      }));
  });
});

describe("allocation removed, as an oracle", () => {
  // Only an actual deletion reports allocation removed. A checkout moved to
  // the Trash still holds its space, and main sends no figure for it.
  it("says nothing about allocation for a Trash move that sent no figure", () => {
    fc.assert(fc.property(fc.constantFrom(...ACTIONS), fc.option(fc.nat({ max: 2 ** 40 }), { nil: undefined }), (action, bytes) => {
      const text = outcomeText({ itemId: "i", step: "checkouts", action, object: "o", status: "done",
        ...(bytes === undefined ? {} : { allocatedBytesRemoved: bytes }) });
      expect(/allocation removed/.test(text)).toBe(Boolean(bytes));
    }));
    expect(outcomeText({ itemId: "i", step: "checkouts", action: "trashCheckout", object: "o", status: "done" }))
      .toBe("Moved to the Trash");
  });
});

describe("problems beside items", () => {
  const item = (overrides: Partial<ThreadMaintenanceRunItem>): ThreadMaintenanceRunItem => ({
    itemId: "i", step: "hibernate", action: "hibernate", object: "Port the renderer", status: "kept", ...overrides,
  });
  const problem = (overrides: Partial<ThreadMaintenanceProblem>): ThreadMaintenanceProblem => ({
    step: "hibernate", kind: "kept", object: "Port the renderer", reason: "Uncommitted changes", ...overrides,
  });

  // Property: each kept or failed outcome is said once. A problem an item
  // already reports is dropped; every other problem stays.
  it("drops exactly the problems an item reports", () => {
    const threads = ["t-1", "t-2", "t-3"];
    fc.assert(fc.property(
      fc.array(fc.record({ threadId: fc.constantFrom(...threads), status: fc.constantFrom("kept", "failed", "done") }), { maxLength: 4 }),
      fc.array(fc.record({ threadId: fc.constantFrom(...threads), kind: fc.constantFrom("kept", "failed") }), { maxLength: 4 }),
      (itemRows, problemRows) => {
        const items = itemRows.map((row, index) => item({ itemId: `i-${index}`, backend: "codex", threadId: row.threadId,
          object: row.threadId, status: row.status as ThreadMaintenanceRunItem["status"] }));
        const problems = problemRows.map((row) => problem({ backend: "codex", threadId: row.threadId, object: row.threadId,
          kind: row.kind as ThreadMaintenanceProblem["kind"] }));
        const kept = problemsWithoutItems(problems, items);
        for (const entry of problems) {
          const reported = items.some((row) => row.status === entry.kind && row.threadId === entry.threadId);
          expect(kept.includes(entry)).toBe(!reported);
        }
      }));
  });

  it("keeps every problem from an owner that sends no items", () => {
    const problems = [problem({}), problem({ kind: "failed", reason: "Snapshot failed" })];
    expect(problemsWithoutItems(problems, undefined)).toEqual(problems);
    expect(problemsWithoutItems(problems, [])).toEqual(problems);
  });

  it("matches by path when neither side names a thread", () => {
    const items = [item({ action: "removeCheckout", step: "checkouts", object: "/w/a/repo", path: "/w/a/repo", status: "failed" })];
    expect(problemsWithoutItems([problem({ step: "checkouts", kind: "failed", object: "kiln", path: "/w/a/repo" })], items)).toEqual([]);
    expect(problemsWithoutItems([problem({ step: "checkouts", kind: "failed", object: "kiln", path: "/w/b/repo" })], items)).toHaveLength(1);
  });
});
