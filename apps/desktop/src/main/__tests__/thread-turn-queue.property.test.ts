import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ThreadTurnQueue,
  type ThreadTurnQueueEntry,
  type ThreadTurnQueueLifecycleEvent,
} from "../app-server/thread-turn-queue";

const THREAD = { backend: "codex" as const, threadId: "model-thread" };
const REASONS = ["locked", "awaiting-review", "target-ended"] as const;
const FAILURE = "The previous turn failed. Review the error before retrying queued messages.";

type ModelEntry = { id: string; holds: string[]; paused: boolean };
type Model = {
  arrivals: string[];
  waiting: ModelEntry[];
  // New submissions inherit the newest outstanding queue hold. Holds of
  // existing entries keep their cause, even when another kind arrives.
  holdOrder: string[];
  active?: string;
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
  | { kind: "submitHeld"; reason: string }
  | { kind: "releaseHold"; reason: string }
  | { kind: "releaseThread" | "staleRelease"; status: "turn/completed" | "turn/failed" }
  | { kind: "retry"; index: number }
  | { kind: "pause"; index: number; paused: boolean }
  | { kind: "move"; index: number; before?: number };

function setup(): { model: Model; real: Real } {
  const model: Model = {
    arrivals: [], waiting: [], holdOrder: [], finished: [], started: [],
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
      case "releaseThread": return model.active !== undefined;
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
      case "releaseThread": {
        const turnId = model.active!;
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
const commands = fc.commands([
  fc.constant(new QueueCommand({ kind: "submit" })),
  reason.map((reason) => new QueueCommand({ kind: "submitHeld", reason })),
  reason.map((reason) => new QueueCommand({ kind: "releaseHold", reason })),
  terminal.map((status) => new QueueCommand({ kind: "releaseThread", status })),
  terminal.map((status) => new QueueCommand({ kind: "staleRelease", status })),
  fc.nat({ max: 10 }).map((index) => new QueueCommand({ kind: "retry", index })),
  fc.tuple(fc.nat({ max: 10 }), fc.boolean())
    .map(([index, paused]) => new QueueCommand({ kind: "pause", index, paused })),
  fc.tuple(fc.nat({ max: 10 }), fc.option(fc.nat({ max: 10 }), { nil: undefined }))
    .map(([index, before]) => new QueueCommand({ kind: "move", index, before })),
], { maxCommands: 40, size: "+1" });

describe("ThreadTurnQueue model", () => {
  it("holds every waiting entry after failure even if the newest hold already has that reason", async () => {
    const state = setup();
    try {
      await fc.asyncModelRun(() => state, [
        new QueueCommand({ kind: "submit" }),
        new QueueCommand({ kind: "submitHeld", reason: "locked" }),
        new QueueCommand({ kind: "submitHeld", reason: FAILURE }),
        new QueueCommand({ kind: "releaseThread", status: "turn/failed" }),
        new QueueCommand({ kind: "releaseHold", reason: "locked" }),
      ]);
    } finally {
      state.real.queue.close();
    }
  });

  it("ignores an old failure after a newer entry is held", async () => {
    const state = setup();
    try {
      await fc.asyncModelRun(() => state, [
        new QueueCommand({ kind: "submitHeld", reason: "locked" }),
        new QueueCommand({ kind: "retry", index: 0 }),
        new QueueCommand({ kind: "releaseThread", status: "turn/completed" }),
        new QueueCommand({ kind: "submitHeld", reason: "locked" }),
        new QueueCommand({ kind: "staleRelease", status: "turn/failed" }),
      ]);
    } finally {
      state.real.queue.close();
    }
  });

  it("preserves admission order, hold causes, single occupancy and progress", async () => {
    await fc.assert(fc.asyncProperty(commands, async (sequence) => {
      const state = setup();
      try {
        await fc.asyncModelRun(() => state, sequence);
      } finally {
        state.real.queue.close();
      }
    }), { numRuns: 200 });
    // fc.assert includes the seed, path, shrunk commands and replayPath in
    // its failure, so CI failures can be replayed without pinning a seed here.
  });
});
