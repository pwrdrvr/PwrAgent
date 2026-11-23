import fc from "fast-check";
import { expect, it } from "vitest";
import { StackCoordinator, type StackParticipant } from "../stack-coordinator";
import type { StackPlan } from "../engine/types";

type Model = { active: boolean[]; committed: boolean; stopped: boolean; stale: boolean };
type Scenario = {
  turns: StackParticipant[];
  changed(): void;
  advanceTip(): void;
  abort(): void;
};

class TurnEnds implements fc.AsyncCommand<Model, Scenario> {
  constructor(private readonly index: number) {}
  check(model: Readonly<Model>) { return !model.stopped && !model.committed && model.active[this.index] === true; }
  async run(model: Model, real: Scenario) {
    model.active[this.index] = false;
    model.committed = !model.stale && model.active.every((active) => !active);
    real.turns[this.index]!.active = false;
    real.changed();
  }
  toString() { return `turn ends ${this.index}`; }
}

class Abort implements fc.AsyncCommand<Model, Scenario> {
  check(model: Readonly<Model>) { return !model.stopped && model.active.some(Boolean); }
  async run(model: Model, real: Scenario) {
    model.stopped = true;
    real.abort();
  }
  toString() { return "abort waiting operation"; }
}

class Commit implements fc.AsyncCommand<Model, Scenario> {
  check(model: Readonly<Model>) { return !model.stopped && !model.stale && model.active.some(Boolean); }
  async run(model: Model, real: Scenario) {
    model.stale = true;
    real.advanceTip();
  }
  toString() { return "agent commits while settling"; }
}

it("models turn completion, agent commits, and cancellation around stack application", async () => {
  const commands = fc.commands([fc.integer({ min: 0, max: 2 }).map((index) => new TurnEnds(index)), fc.constant(new Abort()), fc.constant(new Commit())]);
  await fc.assert(fc.asyncProperty(fc.scheduler(), commands, async (scheduler, sequence) => {
    const actor = { backend: "codex" as const, threadId: "requester" };
    const turns: StackParticipant[] = [0, 1, 2].map((index) => ({
      backend: "codex", threadId: String(index), title: `Layer ${index}`, branch: `layer-${index}`, active: true, locked: false, remote: false,
    }));
    const catalog = { schemaVersion: 1, repository: "github.com:example/project", stacks: [] };
    const moves = turns.map(({ branch }) => ({ branch, old: "old", next: "new" }));
    const plan: StackPlan = {
      operation: { kind: "restack", root: "layer-0" }, catalogHash: "catalog", before: catalog, after: catalog,
      expectedTips: { "layer-0": "old" }, steps: [], moves, worktrees: [], blocked: [],
    };
    let tip = "old";
    let writes = 0;
    const held = new Set<string>();
    const listeners = new Set<() => void>();
    let subscribed!: () => void;
    const ready = new Promise<void>((resolve) => { subscribed = resolve; });
    const coordinator = new StackCoordinator({
      newId: () => "op", now: () => 1,
      plan: async () => ({ ...plan, expectedTips: { "layer-0": tip } }),
      participants: async () => turns.map((turn) => ({ ...turn })),
      hold: ({ threadId }) => {
        held.add(threadId);
        return () => { held.delete(threadId); };
      },
      subscribe: (listener) => {
        listeners.add(listener);
        subscribed();
        return () => { listeners.delete(listener); };
      },
      exclusive: async (fn) => {
        expect(turns.some((turn) => turn.active)).toBe(false);
        return await fn();
      },
      apply: async (_plan, id, when, hooks, notice) => {
        await hooks.beforeTransaction?.();
        expect(notice.participants.map(({ threadId }) => threadId).sort()).toEqual([...held].sort());
        writes += 1;
        return { id, when, moves, before: catalog, after: catalog };
      },
      undo: async () => { throw new Error("Unexpected undo"); },
      receipt: async () => { throw new Error("Unexpected receipt"); },
    });
    const { planId } = await coordinator.plan(actor, plan.operation);
    coordinator.apply(actor, planId);
    await ready;
    const model: Model = { active: [true, true, true], committed: false, stopped: false, stale: false };
    await fc.asyncModelRun(() => ({ model, real: {
      turns,
      changed: () => {
        scheduler.schedule(Promise.resolve(), "owner turn event").then(() => listeners.forEach((listener) => listener()));
      },
      advanceTip: () => { tip = "agent commit"; },
      abort: () => { coordinator.abort(actor, planId); },
    } }), sequence);
    await scheduler.waitAll();
    if (model.active.some(Boolean) && !model.stopped) {
      expect(writes).toBe(0);
      expect(held.size).toBe(3);
      coordinator.abort(actor, planId);
      model.stopped = true;
    }
    await expect.poll(() => coordinator.status(actor, planId).status, { interval: 0 }).toBe(model.committed ? "done" : "paused");
    expect(writes).toBe(Number(model.committed));
    expect(held.size).toBe(0);
  }), { numRuns: 35 });
});

it("holds affected queues until active layers settle, then moves and notifies once", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }), async (scheduler, active) => {
    const actor = { backend: "codex" as const, threadId: "requester" };
    const participants: StackParticipant[] = active.map((running, i) => ({
      backend: "codex", threadId: `thread-${i}`, branch: `layer-${i}`, title: `Layer ${i}`, active: running,
      locked: false, remote: false,
    }));
    const catalog = { schemaVersion: 1, repository: "github.com:example/project", stacks: [] };
    const moves = participants.map(({ branch }) => ({ branch, old: "old", next: "new" }));
    const plan: StackPlan = {
      operation: { kind: "restack", root: "layer-0" }, catalogHash: "catalog",
      before: catalog, after: catalog, expectedTips: {}, steps: [], moves, worktrees: [], blocked: [],
    };
    const held = new Set<string>();
    const notified = new Set<string>();
    const listeners = new Set<() => void>();
    const coordinator = new StackCoordinator({
      newId: () => "plan",
      now: () => 1,
      plan: async () => plan,
      participants: async () => participants.map((participant) => ({ ...participant })),
      hold: ({ threadId }) => {
        held.add(threadId);
        return () => { held.delete(threadId); };
      },
      subscribe: (notify) => {
        listeners.add(notify);
        return () => { listeners.delete(notify); };
      },
      exclusive: async (fn) => {
        expect(participants.every(({ active }) => !active)).toBe(true);
        return await fn();
      },
      apply: async (_plan, id, when, hooks, notification) => {
        await hooks.beforeTransaction?.();
        expect(held.size).toBe(participants.length);
        expect(participants.every(({ active }) => !active)).toBe(true);
        const receipt = { id, when, moves, before: catalog, after: catalog };
        for (const { threadId } of notification.participants) {
          expect(held.has(threadId)).toBe(true);
          expect(notified.has(threadId)).toBe(false);
          notified.add(threadId);
        }
        return receipt;
      },
      undo: async () => { throw new Error("Unexpected undo"); },
      receipt: async () => { throw new Error("Unexpected undo receipt"); },
    });
    const { planId } = await coordinator.plan(actor, plan.operation);
    coordinator.apply(actor, planId);
    const settling = participants.map((participant) => scheduler.schedule(Promise.resolve(), participant.threadId).then(() => {
      participant.active = false;
      for (const notify of listeners) notify();
    }));
    await scheduler.waitAll();
    await Promise.all(settling);
    await expect.poll(() => coordinator.status(actor, planId).status, { interval: 0 }).toBe("done");
    expect(notified.size).toBe(participants.length);
    expect(held.size).toBe(0);
  }), { numRuns: 25 });
});

it("waits for the operator's interrupt receipt and retries completion without repeating the ref transaction", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async (failAfterCommit) => {
    const actor = { backend: "codex" as const, threadId: "actor" };
    const worker: StackParticipant = { backend: "codex", threadId: "layer", title: "Layer", branch: "layer",
      active: true, locked: false, remote: false };
    const catalog = { schemaVersion: 1, repository: "github.com:fixture/project", stacks: [] };
    const plan: StackPlan = { operation: { kind: "restack", root: "layer" }, catalogHash: "catalog", before: catalog,
      after: catalog, expectedTips: {}, steps: [], moves: [{ branch: "layer", old: "old", next: "new" }],
      worktrees: [], blocked: [] };
    const receipt = { id: "plan", when: 1, moves: plan.moves, before: catalog, after: catalog };
    const listeners = new Set<() => void>();
    let finishInterrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => { finishInterrupt = resolve; });
    let holds = 0;
    let writes = 0;
    let attempts = 0;
    const coordinator = new StackCoordinator({
      newId: () => "plan", now: () => 1, plan: async () => plan,
      participants: async () => [{ ...worker }],
      hold: () => { holds++; return () => { holds--; }; },
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      exclusive: async (work) => await work(),
      apply: async (_plan, _id, _when, hooks, notification) => {
        await hooks.beforeTransaction?.();
        expect(holds).toBe(1);
        expect(notification.interrupted).toEqual([expect.objectContaining({ threadId: worker.threadId })]);
        writes++;
        return receipt;
      },
      undo: async () => receipt, receipt: async () => receipt,
      interrupt: async () => {
        worker.active = false;
        for (const listener of listeners) listener();
        await interrupted;
      },
      complete: async () => {
        expect(holds).toBe(0);
        attempts++;
        if (failAfterCommit && attempts === 1) throw new Error("provider start failed");
        return { backend: "codex", threadId: "child" };
      },
    });
    const { planId } = await coordinator.plan(actor, plan.operation);
    coordinator.apply(actor, planId);
    await expect.poll(() => coordinator.status(actor, planId).waiting?.length, { interval: 0 }).toBe(1);
    const requested = coordinator.interrupt(actor, planId);
    await Promise.resolve();
    expect(writes).toBe(0);
    finishInterrupt();
    await requested;
    await expect.poll(() => coordinator.status(actor, planId).status, { interval: 0 }).toBe(failAfterCommit ? "paused" : "done");
    if (failAfterCommit) {
      expect(coordinator.status(actor, planId).issue?.code).toBe("post_apply_failed");
      await coordinator.continue(actor, planId);
    }
    expect(coordinator.status(actor, planId).child?.threadId).toBe("child");
    expect(writes).toBe(1);
    expect(attempts).toBe(failAfterCommit ? 2 : 1);
  }), { numRuns: 10, examples: [[true]] });
});

it("routes only to the affected owner and does not apply an unsettled forecast", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (conflict, unrelatedTipMoved) => {
    const actor = { backend: "codex" as const, threadId: "lead" };
    const layer: StackParticipant = { backend: "codex", threadId: "layer", title: "Layer", branch: "layer", path: "/fixture/child",
      active: false, locked: false, remote: false };
    const catalog = { schemaVersion: 1, repository: "github.com:fixture/project", stacks: [] };
    const operation = { kind: "restack" as const, root: "layer" };
    let blocked = true;
    let requests = 0;
    let applied = 0;
    const plan = (): StackPlan => ({
      operation, catalogHash: "catalog", before: catalog, after: catalog,
      expectedTips: { trunk: !blocked && unrelatedTipMoved ? "moved" : "base", layer: conflict && !blocked ? "resolved" : "old" },
      steps: [{ branch: "layer", parent: "trunk", oldBase: "base", newBase: "base", oldTip: "old",
        ...(conflict && blocked ? { conflict: { commit: "conflicting", files: ["fixture"] } } : {}) }],
      moves: conflict && blocked ? [] : [{ branch: "layer", old: "old", next: "new" }],
      worktrees: [], blocked: !conflict && blocked ? [{ path: "/fixture/child", files: ["fixture"] }] : [],
    });
    const coordinator = new StackCoordinator({
      newId: () => "operation", now: () => 1, plan: async () => plan(),
      participants: async (moves) => moves.some(({ branch }) => branch === layer.branch) ? [layer] : [],
      hold: () => () => undefined, subscribe: () => () => undefined, exclusive: async (work) => await work(),
      requestWork: async (sender, owner, prompt, _key, signal) => {
        expect(sender).toEqual(actor);
        expect(owner.threadId).toBe(layer.threadId);
        expect(prompt).toContain('"fixture"');
        expect(Boolean(signal)).toBe(!conflict);
        expect(applied).toBe(0);
        requests++;
        blocked = false;
      },
      apply: async (fresh, id, when, hooks) => {
        await hooks.beforeTransaction?.();
        expect(blocked).toBe(false);
        applied++;
        return { id, when, moves: fresh.moves, before: catalog, after: catalog };
      },
      undo: async () => { throw new Error("Unexpected undo"); }, receipt: async () => { throw new Error("Unexpected receipt"); },
    });
    const { planId } = await coordinator.plan(actor, operation, { askToSettle: !conflict });
    coordinator.apply(actor, planId);
    if (conflict) {
      await expect.poll(() => coordinator.status(actor, planId).status, { interval: 0 }).toBe("paused");
      expect(requests).toBe(0);
      await coordinator.routeConflict(actor, planId);
      await coordinator.continue({ backend: layer.backend, threadId: layer.threadId }, planId).then(
        () => expect(unrelatedTipMoved).toBe(false),
        (error: unknown) => { expect(unrelatedTipMoved).toBe(true); expect(error).toMatchObject({ code: "stale_plan" }); },
      );
    }
    await expect.poll(() => coordinator.status(actor, planId).status, { interval: 0 }).toBe(unrelatedTipMoved ? "paused" : "done");
    expect(requests).toBe(1);
    expect(applied).toBe(unrelatedTipMoved ? 0 : 1);
  }), { numRuns: 12, examples: [[true, false], [false, true]] });
});
