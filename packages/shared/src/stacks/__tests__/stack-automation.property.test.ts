import fc from "fast-check";
import { expect, test } from "vitest";
import { nextStackAdvance, stackAutomationGates, stackDispatchBlock, type StackSettlement } from "../stack-automation";

type Layer = {
  number: number;
  local: number;
  remote: number;
  base: number;
  ci: "passing" | "failing" | "pending";
  conflict: boolean;
  repair: boolean;
  working: boolean;
  merged: boolean;
  synced: boolean;
  replays: number;
  pushes: number;
  ciRuns: number;
};

function makeStack(size: number): Layer[] {
  return Array.from({ length: size }, (_, i) => ({
    number: 40 + i, local: i + 1, remote: i + 1, base: i, ci: "passing",
    conflict: false, repair: false, working: false, merged: false, synced: false,
    replays: 0, pushes: 0, ciRuns: 0,
  }));
}

type Model = { layers: Layer[]; tip: number; trunk: number };

function parentTip(model: Model, i: number): number {
  const lower = model.layers[i - 1];
  return !lower || lower.merged ? model.trunk : lower.local;
}

function actual(model: Model) {
  const states = model.layers.map((layer, index): StackSettlement => ({
    branch: `layer-${index}`, number: layer.number,
    health: layer.working ? "held"
      : model.layers[index - 1]?.merged && !layer.synced ? "parent_merged"
      : layer.base !== parentTip(model, index) ? "needs_restack"
      : layer.remote !== layer.local ? "needs_push" : "in_sync",
    checks: layer.ci,
    // A failing subset can be observed before the rest of CI settles.
    checksRunning: layer.ci === "pending",
    merged: layer.merged, repair: layer.repair, conflict: layer.conflict,
  }));
  return stackAutomationGates(states).map((gate, index) => ({
    ...gate, branch: states[index]!.branch, pullRequest: { number: model.layers[index]!.number },
  }));
}

function settled(model: Model, index: number): boolean {
  const layer = model.layers[index]!;
  // Independent predicate over observed actions and refs, rather than the
  // display health or the gate's ordered priority of reasons.
  if (layer.working) return false;
  if (layer.merged) return true;
  const parent = model.layers[index - 1];
  return layer.base === parentTip(model, index)
    && (!parent?.merged || layer.synced)
    && layer.remote === layer.local && layer.ci === "passing"
    && !layer.conflict && !layer.repair;
}

function publish(model: Model, index: number) {
  const layer = model.layers[index]!;
  layer.remote = layer.local;
  layer.ci = "pending";
  layer.pushes++;
  layer.ciRuns++;
}

function monitor(model: Model) {
  const gates = actual(model);
  const firstUnsettled = model.layers.findIndex((_, i) => !settled(model, i));
  expect(gates.map((gate) => gate.heldBy?.number)).toEqual(model.layers.map((_, index) =>
    firstUnsettled >= 0 && firstUnsettled < index ? model.layers[firstUnsettled]!.number : undefined,
  ));
  for (const [index, gate] of gates.entries()) {
    const layer = model.layers[index]!;
    const mayStartRepair = (layer.ci === "failing" || layer.conflict)
      && !layer.repair && !layer.merged && !stackDispatchBlock(gate);
    if (mayStartRepair) {
      expect(firstUnsettled < 0 || firstUnsettled >= index).toBe(true);
      expect(layer.remote).toBe(layer.local);
      expect(layer.base).toBe(parentTip(model, index));
      layer.repair = true;
    }
  }
  const next = nextStackAdvance(gates);
  if (!next) return;
  const i = gates.indexOf(next);
  const layer = model.layers[i]!;
  expect(model.layers.slice(0, i).every((_, k) => settled(model, k))).toBe(true);
  expect(layer.working).toBe(false);
  if (next.unsettled === "needs restack" || next.unsettled === "needs sync") {
    layer.local = ++model.tip;
    layer.base = parentTip(model, i);
    layer.synced = Boolean(model.layers[i - 1]?.merged);
    layer.replays++;
  }
  publish(model, i);
}

const events = ["fix", "publish", "passing", "failing", "pending", "conflict", "resolve", "merge", "start", "finish", "monitor"] as const;

test("the gate holds every upper trigger behind the first unsettled layer", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 10 }), fc.array(fc.tuple(
    fc.constantFrom(...events), fc.nat(25),
  ), { minLength: 20, maxLength: 100, size: "large" }), (size, trace) => {
    const model = { layers: makeStack(size), tip: size, trunk: 0 };
    for (const [event, selector] of trace) {
      const index = selector % size;
      const layer = model.layers[index]!;
      if (event === "monitor") {
        monitor(model);
      } else if (!layer.merged) {
        if (event === "start") layer.working = true;
        if (event === "finish") layer.working = false;
        if (event === "fix" && !layer.working) {
          layer.local = ++model.tip;
          layer.repair = false;
        }
        if (event === "publish" && !layer.working && !layer.repair && layer.remote !== layer.local
          && model.layers.slice(0, index).every((_, i) => settled(model, i))
          && layer.base === parentTip(model, index)) publish(model, index);
        if (event === "passing" || event === "failing" || event === "pending") layer.ci = event;
        if (event === "conflict") layer.conflict = true;
        if (event === "resolve") {
          layer.conflict = false;
          layer.repair = false;
        }
        if (event === "merge" && settled(model, index) && model.layers.slice(0, index).every((lower) => lower.merged)) {
          layer.merged = true;
          model.trunk = ++model.tip;
        }
      }
    }
  }));
});

test("amends and red or running CI coalesce into one replay, push and CI run per upper layer", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 28 }), fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 87, maxLength: 87 }), (size, noise) => {
    const model = { layers: makeStack(size), tip: size, trunk: 0 };
    const bottom = model.layers[0]!;
    const delays = noise[Symbol.iterator]();
    for (let wave = 1; wave <= 3; wave++) {
      for (let fix = delays.next().value!; fix > 0; fix--) {
        bottom.local = ++model.tip;
        publish(model, 0);
        for (let probe = 0; probe < 4; probe++) monitor(model);
      }
      expect(model.layers.slice(1).every((layer) => layer.pushes === wave - 1)).toBe(true);
      for (let layer = 0; layer < size; layer++) {
        model.layers[layer]!.ci = "passing";
        // Duplicate monitor triggers during running CI must make no progress.
        for (let probe = delays.next().value!; probe > 0; probe--) monitor(model);
      }
      for (const layer of model.layers.slice(1)) {
        expect([layer.replays, layer.pushes, layer.ciRuns]).toEqual([wave, wave, wave]);
      }
      const total = model.layers.slice(1).reduce((sum, layer) => sum + layer.ciRuns, 0);
      expect(total).toBe(wave * (size - 1));
    }
  }), { numRuns: 12, examples: [[28, Array<number>(87).fill(20)]] });
});
