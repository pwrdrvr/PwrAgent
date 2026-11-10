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

async function unlockDuringFailure(paused: number, runnable: number, publication: number): Promise<void> {
  const starts: string[] = [];
  let armed = false, yieldingFailure = false;
  const queue = new ThreadTurnQueue({
    startTurn: async entry => { starts.push(entry.id); return { ...THREAD, turnId: entry.id }; },
    onLifecycle: async event => {
      if (armed && event.type === "queued" && event.entry.id === `waiting-${publication}` && !event.entry.manualReleaseRequired) {
        armed = false;
        yieldingFailure = true;
        await queue.releaseThread({ ...THREAD, turnId: "prior-native", status: "turn/failed", errorMessage: "new failure" });
      } else if (yieldingFailure && event.type === "held") {
        yieldingFailure = false;
        // Let an already scheduled real drain run while the failure has
        // published only its first held row, ahead of runnable input.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    },
  });
  try {
    for (let index = 0; index < paused + runnable; index++) {
      await queue.submitHeld({ ...THREAD, id: `waiting-${index}`, origin: "manual", input: [], paused: index < paused }, "old lock");
    }
    queue.scheduleThreadDrain(THREAD);
    armed = true;
    await queue.releaseHold(THREAD, reason => reason === "old lock");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(starts).toEqual([]);
    expect(queue.getQueuedEntries(THREAD)).toHaveLength(paused + runnable);
    expect(queue.getQueuedEntries(THREAD).every(entry => entry.manualReleaseRequired && entry.holdReason === "new failure")).toBe(true);
    await queue.releaseHold(THREAD, reason => reason === "new failure");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(starts).toEqual([`waiting-${paused}`]);
  } finally { queue.close(); }
}

it("unlock publication gates real drains until an overlapping failure holds every waiting row", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 }), fc.nat(),
    async (paused, runnable, offset) => await unlockDuringFailure(paused, runnable, offset % paused)),
  { examples: [[1, 1, 0]] });
});

it("a paused row cannot let unlock dispatch a later input past a newer failure review", async () => {
  await unlockDuringFailure(1, 1, 0);
});

async function unlockDuringTitle(count: number, edited: number, title: string): Promise<void> {
  const senderState = new Map<string, string>();
  const released: ThreadTurnQueueLifecycleEvent[] = [];
  let armed = false;
  const queue = new ThreadTurnQueue({
    isThreadActive: () => true,
    startTurn: async () => { throw new Error("An occupied owner cannot start another turn"); },
    onLifecycle: async event => {
      if (event.type === "queued" || event.type === "held") senderState.set(event.entry.id, event.type);
      if (armed && event.type === "queued" && event.entry.id === "waiting-0") {
        armed = false;
        queue.setQueuedEntryTitle(`waiting-${edited}`, title);
      }
      if (event.type === "queued" && !event.entry.manualReleaseRequired) released.push(event);
    },
  });
  try {
    for (let index = 0; index < count; index++) {
      await queue.submit({ ...THREAD, id: `waiting-${index}`, origin: "manual", input: [{ type: "text", text: `Immutable input ${index}` }] });
    }
    await queue.releaseThread({ ...THREAD, turnId: "prior-native", status: "turn/failed", errorMessage: "old lock" });
    expect([...senderState.values()]).toEqual(Array.from({ length: count }, () => "held"));
    released.length = 0;
    armed = true;
    await queue.releaseHold(THREAD, reason => reason === "old lock");
    const waiting = queue.getQueuedEntries(THREAD);
    // Titles notify recipients independently. Only the release lifecycle
    // transitions the sender from held to queued.
    expect([...senderState.values()]).toEqual(waiting.map(() => "queued"));
    expect(released.map(event => event.entry)).toEqual(waiting);
    expect(waiting[edited]).toMatchObject({ title, input: [{ type: "text", text: `Immutable input ${edited}` }] });
  } finally { queue.close(); }
}

it("unlock publishes current lifecycle state after unrelated generated-title updates", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), fc.nat(), fc.string(),
    async (count, offset, title) => await unlockDuringTitle(count, 1 + offset % (count - 1), title)),
  { examples: [[2, 0, "Updated title"]] });
});

it("a title completing during unlock cannot leave the later sender held", async () => {
  await unlockDuringTitle(2, 1, "Updated title");
});

it("unlock unwinds only its own dispatch suspension after a publication error", async () => {
  const starts: string[] = [];
  let armed = false;
  const queue = new ThreadTurnQueue({
    startTurn: async entry => { starts.push(entry.id); return { ...THREAD, turnId: entry.id }; },
    onLifecycle: event => {
      if (armed && event.type === "queued" && !event.entry.manualReleaseRequired) throw new Error("observer failed");
    },
  });
  try {
    await queue.submitHeld({ ...THREAD, id: "waiting", origin: "manual", input: [] }, "old lock");
    armed = true;
    await queue.withDispatchSuspended(THREAD, async () => {
      await expect(queue.releaseHold(THREAD, () => true)).rejects.toThrow("observer failed");
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(starts).toEqual([]);
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(starts).toEqual(["waiting"]);
  } finally { queue.close(); }
});

async function unlockWithNewHold(count: number, publication: number): Promise<void> {
  const started: string[] = [];
  const observed = new Map<string, boolean>();
  let armed = false, publications = 0;
  const queue = new ThreadTurnQueue({
    startTurn: async entry => { started.push(entry.id); return { ...THREAD, turnId: entry.id }; },
    onLifecycle: async event => {
      if (event.type === "queued" || event.type === "held") observed.set(event.entry.id, event.entry.manualReleaseRequired === true);
      if (armed && event.type === "queued" && !event.entry.manualReleaseRequired && publications++ === publication) {
        armed = false;
        await queue.submitHeld({ ...THREAD, id: "new-review", origin: "manual", input: [] }, "independent review");
      }
    },
  });
  try {
    for (let index = 0; index < count; index++) {
      await queue.submitHeld({ ...THREAD, id: `older-${index}`, origin: "manual", input: [] }, "old lock");
    }
    armed = true;
    expect(await queue.releaseHold(THREAD, reason => reason === "old lock")).toBe(true);
    // Unlock answers only the old lock. A later review must remain both
    // visible and actionable after its introducing entry is cancelled.
    expect(queue.getQueuedEntries(THREAD).every(entry => entry.manualReleaseRequired && entry.holdReason === "independent review")).toBe(true);
    expect([...observed.values()].every(Boolean)).toBe(true);
    queue.cancelEntryWithDisposition("new-review");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(started).toEqual([]);
    expect((await queue.releaseEntryWithDisposition("older-0")).disposition).toBe("started");
    expect(started).toEqual(["older-0"]);
  } finally { queue.close(); }
}

it("unlock publication preserves every newer independent review as an actionable hold", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), fc.nat(), async (count, offset) => {
    await unlockWithNewHold(count, offset % count);
  }));
});

it("unlock cannot strand an older input after cancelling the new review entry", async () => {
  await unlockWithNewHold(1, 0);
});

it("unlock completes its old cause before new holds, simultaneous controls and independent release", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), fc.nat(),
    fc.constantFrom("new review", "old lock", "new failure"), fc.boolean(), fc.boolean(),
    async (count, offset, reason, cancelPublished, close) => {
      const starts: string[] = [];
      const observed = new Map<string, { held: boolean; reason?: string }>();
      let armed = false, publications = 0, active = true;
      const queue = new ThreadTurnQueue({
        isThreadActive: () => active,
        startTurn: async entry => { starts.push(entry.id); return { ...THREAD, turnId: entry.id }; },
        onLifecycle: async event => {
          if (event.type === "queued" || event.type === "held") observed.set(event.entry.id,
            { held: event.entry.manualReleaseRequired === true, reason: event.entry.holdReason });
          if (event.type === "cancelled") observed.delete(event.entry.id);
          if (!armed || event.type !== "queued" || event.entry.manualReleaseRequired || publications++ !== offset % count) return;
          armed = false;
          if (cancelPublished) queue.cancelEntryWithDisposition(event.entry.id);
          if (reason === "new failure") await queue.releaseThread({ ...THREAD, turnId: "prior-turn", status: "turn/failed", errorMessage: reason });
          else await queue.submitHeld({ ...THREAD, id: "new-review", origin: "manual", input: [] }, reason);
          // These are real queue controls while unlock's publication awaits.
          // They cannot move/pause/retry a review held on an occupied thread.
          const head = queue.getQueuedEntries(THREAD)[0];
          if (head) {
            expect((await queue.setEntryPaused(head.id, true)).disposition).toBe("held");
            expect((await queue.moveEntry(head.id)).disposition).toBe("held");
            expect((await queue.releaseEntryWithDisposition(head.id)).disposition).toBe("busy");
          }
          if (close) queue.close();
        },
      });
      try {
        for (let index = 0; index < count; index++) await queue.submitHeld({ ...THREAD, id: `older-${index}`, origin: "manual", input: [] }, "old lock");
        armed = true;
        expect(await queue.releaseHold(THREAD, cause => cause === "old lock")).toBe(true);
        const waiting = queue.getQueuedEntries(THREAD);
        expect(waiting.map(entry => ({ held: entry.manualReleaseRequired === true, reason: entry.holdReason })))
          .toEqual(waiting.map(() => ({ held: true, reason })));
        expect([...observed.entries()].sort()).toEqual(waiting.map(entry => [entry.id, { held: true, reason }]).sort());
        queue.cancelEntryWithDisposition("new-review");
        active = false;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(starts).toEqual([]);
        const remaining = queue.getQueuedEntries(THREAD);
        if (remaining.length) {
          // Independent release answers the new cause even when its text
          // matches the old lock. No obsolete lock may strand other rows.
          expect(await queue.releaseHold(THREAD, cause => cause === reason)).toBe(true);
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(starts).toEqual(close ? [] : [remaining[0]!.id]);
          expect(queue.getQueuedEntries(THREAD).every(entry => !entry.manualReleaseRequired)).toBe(true);
        }
      } finally { queue.close(); }
    }));
});

it("unlock publication cannot resurrect a row cancelled or released by a simultaneous control", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), fc.boolean(), async (count, cancel) => {
    const observed = new Map<string, boolean>();
    let armed = false;
    const queue = new ThreadTurnQueue({
      isThreadActive: () => true,
      startTurn: async () => { throw new Error("An occupied owner cannot start another turn"); },
      onLifecycle: async event => {
        if (event.type === "queued" || event.type === "held") observed.set(event.entry.id, event.entry.manualReleaseRequired === true);
        if (event.type === "cancelled") observed.delete(event.entry.id);
        if (armed && event.type === "queued" && !event.entry.manualReleaseRequired) {
          armed = false;
          if (cancel) queue.cancelEntryWithDisposition(`older-${count - 1}`);
          else await queue.releaseHold(THREAD, cause => cause === "other review");
        }
      },
    });
    try {
      await queue.submitHeld({ ...THREAD, id: "older-0", origin: "manual", input: [] }, "old lock");
      for (let index = 1; index < count; index++) await queue.submitHeld({ ...THREAD, id: `older-${index}`, origin: "manual", input: [] }, "other review");
      armed = true;
      await queue.releaseHold(THREAD, cause => cause === "old lock");
      expect([...observed.entries()].sort()).toEqual(queue.getQueuedEntries(THREAD).map(entry => [entry.id, entry.manualReleaseRequired === true]).sort());
      expect((await queue.releaseEntryWithDisposition("older-0")).disposition).toBe("not_held");
    } finally { queue.close(); }
  }));
});

async function retryWithNewHold(count: number, publication: number): Promise<void> {
  const started: string[] = [];
  const observed = new Map<string, boolean>();
  let armed = false, publications = 0;
  const queue = new ThreadTurnQueue({
    startTurn: async entry => { started.push(entry.id); return { ...THREAD, turnId: `turn-${entry.id}` }; },
    onLifecycle: async event => {
      if (event.type === "queued" || event.type === "held") observed.set(event.entry.id, event.entry.manualReleaseRequired === true);
      if (armed && event.type === "queued" && !event.entry.manualReleaseRequired && publications++ === publication) {
        armed = false;
        await queue.submitHeld({ ...THREAD, id: "new-review", origin: "manual", input: [] }, "independent new review");
      }
    },
  });
  try {
    for (let index = 0; index < count; index++) {
      await queue.submitHeld({ ...THREAD, id: `older-${index}`, origin: "manual", input: [] }, "old review");
    }
    armed = true;
    expect(await queue.releaseEntryWithDisposition("older-0")).toMatchObject({ disposition: "busy" });
    // A hold arriving after Retry's release boundary covers every still-waiting
    // input. Removing its introducing entry does not release anyone's review.
    expect(queue.getQueuedEntries(THREAD).every(entry => entry.manualReleaseRequired === true)).toBe(true);
    expect(queue.getQueuedEntries(THREAD).every(entry => entry.holdReason === "independent new review")).toBe(true);
    expect([...observed.values()].every(Boolean)).toBe(true);
    queue.cancelEntryWithDisposition("new-review");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(started).toEqual([]);
    expect(queue.getQueuedEntries(THREAD).map(entry => entry.id)).toEqual(Array.from({ length: count }, (_, index) => `older-${index}`));
    expect((await queue.releaseEntryWithDisposition("older-0")).disposition).toBe("started");
    expect(started).toEqual(["older-0"]);
  } finally { queue.close(); }
}

it("Retry cannot release a newer review hold while publishing its older release", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), fc.nat(), async (count, offset) => {
    await retryWithNewHold(count, offset % count);
  }));
});

it("cancelling only the new review entry keeps the older input held", async () => {
  await retryWithNewHold(1, 0);
});

async function retryWithTitleUpdates(count: number, updates: number[], cancel: boolean): Promise<void> {
  const released: ThreadTurnQueueLifecycleEvent[] = [];
  const observed = new Map<string, boolean>();
  const titles = new Map<string, string>();
  let armed = false;
  const queue = new ThreadTurnQueue({
    startTurn: async entry => ({ ...THREAD, turnId: entry.id }),
    onLifecycle: async event => {
      if (event.type === "held" || event.type === "queued") observed.set(event.entry.id, event.entry.manualReleaseRequired === true);
      if (!armed || event.type !== "queued" || event.entry.manualReleaseRequired) return;
      released.push(structuredClone(event));
      if (event.entry.id !== "older-0") return;
      // Title completion can replace a later entry while this publication
      // awaits its host. It changes display metadata, not acceptance identity.
      await new Promise<void>(resolve => setImmediate(resolve));
      for (const [index, offset] of updates.entries()) {
        const id = `older-${1 + offset % (count - 1)}`;
        const title = `Generated title ${index}`;
        queue.setQueuedEntryTitle(id, title);
        titles.set(id, title);
      }
      if (cancel) queue.cancelEntryWithDisposition(`older-${count - 1}`);
    },
  });
  try {
    for (let index = 0; index < count; index++) {
      await queue.submitHeld({ ...THREAD, id: `older-${index}`, origin: "manual", input: [] }, FAILURE);
    }
    armed = true;
    expect(await queue.releaseEntryWithDisposition("older-0")).toMatchObject({ disposition: "started" });
    const survivors = Array.from({ length: count - Number(cancel) }, (_, index) => `older-${index}`);
    expect(released.map(event => event.entry.id)).toEqual(survivors);
    expect(released.map(event => event.entry.title)).toEqual(survivors.map(id => titles.get(id)));
    expect(released.map(event => "position" in event ? event.position : undefined)).toEqual(survivors.map((_, index) => index + 1));
    expect(survivors.every(id => observed.get(id) === false)).toBe(true);
  } finally { queue.close(); }
}

it("Retry publishes every surviving released identity with its latest generated title", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), fc.array(fc.nat(), { minLength: 1, maxLength: 12 }), fc.boolean(),
    async (count, updates, cancel) => await retryWithTitleUpdates(count, updates, cancel)));
});

it("a title completed during the first release publication cannot omit the second entry", async () => {
  await retryWithTitleUpdates(2, [0], false);
});

it("new failure holds own every waiting input and can be independently released after Retry yields", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), fc.nat(), fc.boolean(), async (count, offset, cancelPublished) => {
    let armed = false, publications = 0;
    const starts: string[] = [];
    const queue = new ThreadTurnQueue({
      startTurn: async entry => { starts.push(entry.id); return { ...THREAD, turnId: entry.id }; },
      onLifecycle: async event => {
        if (armed && event.type === "queued" && !event.entry.manualReleaseRequired && publications++ === offset % count) {
          armed = false;
          if (cancelPublished) queue.cancelEntryWithDisposition(event.entry.id);
          await queue.releaseThread({ ...THREAD, turnId: "previous-native", status: "turn/failed", errorMessage: "new failure" });
        }
      },
    });
    try {
      for (let index = 0; index < count; index++) await queue.submitHeld({ ...THREAD, id: `older-${index}`, origin: "manual", input: [] }, "old review");
      armed = true;
      await queue.releaseEntryWithDisposition("older-0");
      await new Promise<void>(resolve => setImmediate(resolve));
      const waiting = queue.getQueuedEntries(THREAD);
      expect(waiting).toHaveLength(count - Number(cancelPublished));
      expect(waiting.every(entry => entry.manualReleaseRequired && entry.holdReason === "new failure")).toBe(true);
      expect(starts).toEqual([]);
      // Retry already answered the old cause; independently releasing the
      // newer one must not strand a row carrying an obsolete old cause.
      await queue.releaseHold(THREAD, reason => reason === "new failure");
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(starts).toEqual([waiting[0]!.id]);
      expect(queue.getQueuedEntries(THREAD).every(entry => !entry.manualReleaseRequired)).toBe(true);
    } finally { queue.close(); }
  }));
});

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

it("Retry preserves review holds behind dispatch gates and never admits after close", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("dispatch", "closed", "close-during-release"), async gate => {
    let held = false, closeOnRelease = false, sends = 0;
    const queue = new ThreadTurnQueue({
      isThreadActive: () => true,
      canSteerThread: () => true,
      isDispatchHeld: () => held,
      startTurn: async () => { throw new Error("Running native owner must not be replaced"); },
      steerTurn: async () => { sends++; return { ...THREAD, turnId: "native-owner" }; },
      onLifecycle: event => { if (closeOnRelease && event.type === "queued") queue.close(); },
    });
    try {
      await queue.submitHeld({ ...THREAD, id: "guidance", origin: "manual", delivery: "queued-steer", input: [] }, "review");
      const before = queue.getQueuedEntries(THREAD);
      held = gate === "dispatch";
      closeOnRelease = gate === "close-during-release";
      if (gate === "closed") queue.close();
      expect(await queue.releaseEntryWithDisposition("guidance")).toMatchObject({ disposition: "busy" });
      expect(sends).toBe(0);
      if (!closeOnRelease) expect(queue.getQueuedEntries(THREAD)).toEqual(before);
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
