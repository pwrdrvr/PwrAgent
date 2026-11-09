import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ThreadTurnQueue,
  type ThreadTurnQueueEntry,
  type ThreadTurnQueueLifecycleEvent,
} from "../thread-turn-queue";

const THREAD = { backend: "codex" as const, threadId: "model-thread" };
const REASONS = ["locked", "awaiting-review", "target-ended"] as const;
const FAILURE = "The previous turn failed. Review the error before retrying queued messages.";

it("Retry admits only eligible held guidance while preserving the running queue owner", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (steerable, tracked) => {
    const steers: string[] = [], starts: string[] = [];
    let active = false;
    const queue = new ThreadTurnQueue({
      isThreadActive: () => active,
      canSteerThread: () => active && steerable,
      startTurn: async entry => { active = true; starts.push(entry.id); return { ...THREAD, turnId: "native-owner" }; },
      steerTurn: async entry => { steers.push(entry.id); return { ...THREAD, turnId: "native-owner" }; },
    });
    try {
      if (tracked) await queue.submit({ ...THREAD, id: "owner", origin: "manual", input: [] });
      else active = true;
      await queue.submitHeld({ ...THREAD, id: "guidance", origin: "manual", delivery: "queued-steer", input: [] }, "review");
      const result = await queue.releaseEntryWithDisposition("guidance");
      expect(result.disposition).toBe(steerable ? "started" : "busy");
      expect(steers).toEqual(steerable ? ["guidance"] : []);
      expect(starts).toEqual(tracked ? ["owner"] : []);
      expect(active).toBe(true);
      expect(queue.getQueuedEntries(THREAD).map(entry => ({ id: entry.id, held: entry.manualReleaseRequired })))
        .toEqual(steerable ? [] : [{ id: "guidance", held: true }]);
    } finally { queue.close(); }
  }));
});

type ModelEntry = { id: string; holds: string[]; paused: boolean };
type Model = {
  arrivals: string[];
  waiting: ModelEntry[];
  // New submissions inherit the newest outstanding queue hold. Holds of
  // existing entries keep their cause, even when another kind arrives.
  holdOrder: string[];
  active?: string;
  awaitingTerminal: string[];
  finished: string[];
  started: string[];
};
type Real = {
  queue: ThreadTurnQueue;
  active?: string;
  started: string[];
  events: ThreadTurnQueueLifecycleEvent[];
  startErrors: Error[];
};
type Operation =
  | { kind: "submit" }
  | { kind: "idle" }
  | { kind: "submitHeld"; reason: string }
  | { kind: "releaseHold"; reason: string }
  | { kind: "releaseThread" | "staleRelease" | "lateTerminal"; status: "turn/completed" | "turn/failed" }
  | { kind: "retry"; index: number }
  | { kind: "pause"; index: number; paused: boolean }
  | { kind: "move"; index: number; before?: number };

function setup(): { model: Model; real: Real } {
  const model: Model = {
    arrivals: [], waiting: [], holdOrder: [], awaitingTerminal: [], finished: [], started: [],
  };
  const real: Real = {
    queue: new ThreadTurnQueue({
      now: () => 1_000,
      canSteerThread: () => false,
      isThreadActive: () => real.active !== undefined,
      startTurn: async (entry) => {
        // Keep errors outside startTurn too: queued-start failures are caught
        // by the queue and must still fail this property.
        if (real.active !== undefined || real.started.includes(entry.id)) {
          const error = new Error(`Invalid start of ${entry.id} while active: ${real.active}`);
          real.startErrors.push(error);
          throw error;
        }
        real.active = `turn-${entry.id}`;
        real.started.push(entry.id);
        return { ...THREAD, turnId: real.active };
      },
      onLifecycle: (event) => { real.events.push(structuredClone(event)); },
    }),
    started: [], events: [], startErrors: [],
  };
  return { model, real };
}

function rememberHold(model: Model, reason: string): void {
  model.holdOrder = [...model.holdOrder.filter((held) => held !== reason), reason];
}

function advance(model: Model): void {
  if (model.active !== undefined) return;
  const next = model.waiting.find((entry) => !entry.paused);
  if (!next || next.holds.length > 0) return;
  model.waiting = model.waiting.filter((entry) => entry !== next);
  model.active = `turn-${next.id}`;
  model.started.push(next.id);
  if (model.waiting.every((entry) => entry.holds.length === 0)) model.holdOrder = [];
}

async function assertState(model: Model, real: Real): Promise<void> {
  // All effects resolve immediately; this boundary lets the queue's
  // setImmediate drain and its promise continuations finish, without sleeps.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(real.startErrors).toEqual([]);
  expect(new Set(real.started).size).toBe(real.started.length);
  expect(real.started).toEqual(model.started);
  expect(real.active).toBe(model.active);
  expect(real.queue.getQueuedEntries(THREAD).map((entry) => ({
    id: entry.id,
    held: Boolean(entry.manualReleaseRequired),
    paused: Boolean(entry.paused),
  }))).toEqual(model.waiting.map((entry) => ({
    id: entry.id, held: entry.holds.length > 0, paused: entry.paused,
  })));
  expect(real.queue.canStartImmediately(THREAD)).toBe(
    model.active === undefined
    && model.holdOrder.length === 0
    && model.waiting.every((entry) => entry.paused),
  );
}

class QueueCommand implements fc.AsyncCommand<Model, Real> {
  constructor(readonly operation: Operation) {}

  check(model: Readonly<Model>): boolean {
    switch (this.operation.kind) {
      case "idle":
      case "releaseThread": return model.active !== undefined;
      // An idle notification may end occupancy before the provider reports
      // the outcome, while paused or held successors still wait.
      case "lateTerminal": return model.awaitingTerminal.length > 0 && model.active === undefined;
      case "staleRelease": return model.finished.length > 0;
      case "retry":
      case "move":
      case "pause": return model.waiting.length > 0;
      default: return true;
    }
  }

  async run(model: Model, real: Real): Promise<void> {
    const operation = this.operation;
    switch (operation.kind) {
      case "submit":
      case "submitHeld": {
        const id = `entry-${model.arrivals.length}`;
        model.arrivals.push(id);
        const input: ThreadTurnQueueEntry = {
          ...THREAD, id, origin: "manual", createdAt: 1_000,
          input: [{ type: "text", text: id }],
        };
        const entry: ModelEntry = { id, holds: [], paused: false };
        if (operation.kind === "submitHeld") {
          // Intended priority: the FIRST hold precedes ordinary waiting
          // work; further held arrivals join the back of that held FIFO.
          if (model.holdOrder.length === 0) model.waiting.unshift(entry);
          else model.waiting.push(entry);
          rememberHold(model, operation.reason);
          for (const waiting of model.waiting) {
            if (waiting.holds.length === 0) waiting.holds = [operation.reason];
          }
          await real.queue.submitHeld(input, operation.reason);
        } else {
          const reason = model.holdOrder.at(-1);
          if (reason) entry.holds = [reason];
          model.waiting.push(entry);
          advance(model);
          await real.queue.submit(input);
        }
        break;
      }
      case "releaseHold": {
        const released = model.holdOrder.includes(operation.reason);
        if (released) {
          // The multiset of earlier surviving causes is a barrier: removing
          // X cannot let a later entry pass a predecessor still held for Y.
          const ahead = new Set<string>();
          for (const entry of model.waiting) {
            if (entry.holds.length === 0) continue;
            entry.holds = entry.holds.filter((reason) => reason !== operation.reason);
            if (entry.holds.length === 0) entry.holds = [...ahead];
            for (const reason of entry.holds) ahead.add(reason);
          }
          model.holdOrder = model.holdOrder.filter((reason) =>
            model.waiting.some((entry) => entry.holds.includes(reason)));
        }
        advance(model);
        expect(await real.queue.releaseHold(THREAD, (reason) => reason === operation.reason))
          .toBe(released);
        break;
      }
      case "idle": {
        model.awaitingTerminal.push(model.active!);
        model.active = undefined;
        advance(model);
        real.active = undefined;
        await real.queue.releaseThread({ ...THREAD, status: "idle" });
        break;
      }
      case "releaseThread":
      case "lateTerminal": {
        const turnId = operation.kind === "lateTerminal"
          ? model.awaitingTerminal.shift()! : model.active!;
        model.finished.push(turnId);
        model.active = undefined;
        if (operation.status === "turn/failed" && model.waiting.length > 0) {
          // A terminal failure requires review of EVERY waiting entry,
          // including ones previously held for a lock or steering target.
          rememberHold(model, FAILURE);
          for (const entry of model.waiting) entry.holds = [FAILURE];
        }
        advance(model);
        real.active = undefined;
        await real.queue.releaseThread({ ...THREAD, turnId, status: operation.status });
        break;
      }
      case "staleRelease": {
        const before = {
          entries: structuredClone(real.queue.getQueuedEntries(THREAD)),
          started: [...real.started], active: real.active, events: [...real.events],
        };
        await real.queue.releaseThread({
          ...THREAD, turnId: model.finished[0]!, status: operation.status,
        });
        await assertState(model, real);
        expect({
          entries: real.queue.getQueuedEntries(THREAD),
          started: real.started, active: real.active, events: real.events,
        }).toEqual(before);
        break;
      }
      case "retry": {
        const entry = model.waiting[operation.index % model.waiting.length]!;
        const head = model.waiting.find((waiting) => !waiting.paused);
        const disposition = entry !== head ? "not_head"
          : entry.holds.length === 0 ? "not_held"
          : model.active !== undefined ? "busy" : "started";
        if (disposition === "started") {
          // Retry is an explicit operator decision to release the WHOLE FIFO.
          model.holdOrder = [];
          for (const waiting of model.waiting) waiting.holds = [];
        }
        advance(model);
        expect(await real.queue.releaseEntryWithDisposition(entry.id))
          .toMatchObject({ disposition, entryId: entry.id });
        break;
      }
      case "pause": {
        const entry = model.waiting[operation.index % model.waiting.length]!;
        const disposition = entry.paused === operation.paused ? "unchanged"
          : operation.paused && entry.holds.length > 0 ? "held" : "updated";
        if (disposition === "updated") entry.paused = operation.paused;
        advance(model);
        expect(await real.queue.setEntryPaused(entry.id, operation.paused))
          .toMatchObject({ disposition, entryId: entry.id });
        break;
      }
      case "move": {
        const entry = model.waiting[operation.index % model.waiting.length]!;
        const anchor = operation.before === undefined ? undefined
          : model.waiting[operation.before % model.waiting.length];
        const from = model.waiting.indexOf(entry);
        const to = anchor ? model.waiting.indexOf(anchor) : model.waiting.length;
        const crossed = model.waiting.filter((candidate, index) =>
          candidate !== entry && index >= Math.min(from, to) && index < Math.max(from, to));
        let disposition: "held" | "unchanged" | "moved";
        if (entry.holds.length > 0 || crossed.some((entry) => entry.holds.length > 0)) {
          disposition = "held";
        } else if (anchor === entry) {
          disposition = "unchanged";
        } else {
          const reordered = model.waiting.filter((candidate) => candidate !== entry);
          reordered.splice(anchor ? reordered.indexOf(anchor) : reordered.length, 0, entry);
          disposition = reordered.every((entry, index) => entry === model.waiting[index])
            ? "unchanged" : "moved";
          model.waiting = reordered;
        }
        advance(model);
        expect(await real.queue.moveEntry(entry.id, anchor?.id))
          .toMatchObject({ disposition, entryId: entry.id });
        break;
      }
    }
    await assertState(model, real);
  }

  toString(): string {
    return JSON.stringify(this.operation);
  }
}

const reason = fc.constantFrom(...REASONS, FAILURE);
const terminal = fc.constantFrom("turn/completed" as const, "turn/failed" as const);
const holdCommands = [
  reason.map((reason) => new QueueCommand({ kind: "submitHeld", reason })),
  reason.map((reason) => new QueueCommand({ kind: "releaseHold", reason })),
];
const commands = fc.commands([
  fc.constant(new QueueCommand({ kind: "submit" })),
  ...holdCommands,
  terminal.map((status) => new QueueCommand({ kind: "releaseThread", status })),
  fc.constant(new QueueCommand({ kind: "idle" })),
  terminal.map((status) => new QueueCommand({ kind: "lateTerminal", status })),
  terminal.map((status) => new QueueCommand({ kind: "staleRelease", status })),
  fc.nat({ max: 10 }).map((index) => new QueueCommand({ kind: "retry", index })),
  fc.tuple(fc.nat({ max: 10 }), fc.boolean())
    .map(([index, paused]) => new QueueCommand({ kind: "pause", index, paused })),
  fc.tuple(fc.nat({ max: 10 }), fc.option(fc.nat({ max: 10 }), { nil: undefined }))
    .map(([index, before]) => new QueueCommand({ kind: "move", index, before })),
], { maxCommands: 40, size: "+1" });

async function runModel(sequence: Iterable<fc.AsyncCommand<Model, Real>>): Promise<void> {
  const state = setup();
  try {
    await fc.asyncModelRun(() => state, sequence);
  } finally {
    state.real.queue.close();
  }
}

describe("ThreadTurnQueue model", () => {
  it.each(["paused", "locked"])("requires review when idle precedes failure with a %s successor", async (blocked) => {
    await runModel([
      new QueueCommand({ kind: "submit" }),
      ...(blocked === "paused" ? [
        new QueueCommand({ kind: "submit" }),
        new QueueCommand({ kind: "pause", index: 0, paused: true }),
      ] : [new QueueCommand({ kind: "submitHeld", reason: "locked" })]),
      new QueueCommand({ kind: "idle" }),
      new QueueCommand({ kind: "lateTerminal", status: "turn/failed" }),
      blocked === "paused"
        ? new QueueCommand({ kind: "pause", index: 0, paused: false })
        : new QueueCommand({ kind: "releaseHold", reason: "locked" }),
      new QueueCommand({ kind: "retry", index: 0 }),
    ]);
  });

  it("handles an external turn's terminal after acknowledging steer deliveries into it", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), terminal, async (deliveries, status) => {
      let active = true;
      const steered: string[] = [];
      const started: string[] = [];
      const queue = new ThreadTurnQueue({
        now: () => 1_000,
        isThreadActive: () => active,
        canSteerThread: () => active,
        steerTurn: async (entry) => {
          steered.push(entry.id);
          return { ...THREAD, turnId: "external-turn" };
        },
        startTurn: async (entry) => {
          expect(active).toBe(false);
          active = true;
          started.push(entry.id);
          return { ...THREAD, turnId: `turn-${entry.id}` };
        },
      });
      try {
        // The provider owns this turn. Steer acknowledgements confirm
        // delivery into it; only its terminal event says it has ended.
        for (let index = 0; index < deliveries; index += 1) {
          await queue.submitGroupedSteer({
            ...THREAD, id: `steer-${index}`, origin: "manual",
            input: [{ type: "text", text: `guidance-${index}` }],
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(steered).toHaveLength(index + 1);
        }
        await queue.submit({
          ...THREAD, id: "next", origin: "manual",
          input: [{ type: "text", text: "Start a separate turn" }],
        });
        active = false;
        await queue.releaseThread({ ...THREAD, turnId: "external-turn", status });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(started).toEqual(status === "turn/completed" ? ["next"] : []);
        expect(queue.getQueuedEntries(THREAD).map((entry) => ({
          id: entry.id, held: Boolean(entry.manualReleaseRequired),
        }))).toEqual(status === "turn/failed" ? [{ id: "next", held: true }] : []);
      } finally {
        queue.close();
      }
    }), { numRuns: 25 });
  });

  it("holds every waiting entry after failure even if the newest hold already has that reason", async () => {
    await runModel([
      new QueueCommand({ kind: "submit" }),
      new QueueCommand({ kind: "submitHeld", reason: "locked" }),
      new QueueCommand({ kind: "submitHeld", reason: FAILURE }),
      new QueueCommand({ kind: "releaseThread", status: "turn/failed" }),
      new QueueCommand({ kind: "releaseHold", reason: "locked" }),
    ]);
  });

  it("ignores an old failure after a newer entry is held", async () => {
    await runModel([
      new QueueCommand({ kind: "submitHeld", reason: "locked" }),
      new QueueCommand({ kind: "retry", index: 0 }),
      new QueueCommand({ kind: "releaseThread", status: "turn/completed" }),
      new QueueCommand({ kind: "submitHeld", reason: "locked" }),
      new QueueCommand({ kind: "staleRelease", status: "turn/failed" }),
    ]);
  });

  it("preserves FIFO and independent causes through repeated holds and releases", async () => {
    // Exercise hold composition densely as well as in the full state machine.
    await fc.assert(fc.asyncProperty(
      fc.commands(holdCommands, { maxCommands: 40, size: "+1" }),
      runModel,
    ), { numRuns: 100 });
  });

  it("preserves admission order, hold causes, single occupancy and progress", async () => {
    await fc.assert(fc.asyncProperty(commands, runModel), { numRuns: 200 });
    // fc.assert includes the seed, path, shrunk commands and replayPath in
    // its failure, so CI failures can be replayed without pinning a seed here.
  });
});
