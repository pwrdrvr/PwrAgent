import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildPrependPinRank,
  buildTierPinRanks,
  comparePinRanks,
  isKeptAtTopRank,
  type NavigationRelativePinMove,
} from "@pwragent/shared";
import { moveRelativePin, relativePinRanks } from "../state/relative-pin-order";

// The oracle has no ranks, timestamps, or implementation helpers: just the
// two operator-owned arrays promised by AGENTS.md.
type Model = { kept: string[]; ordinary: string[] };
type Real = { ranks: Record<string, string> };
type Operation = { kind: "pin" | "up" | "down" | "keep" | "relative"; index: number; anchor: number; after: boolean };

function assertOrder(model: Model, real: Real): void {
  const expected = [...model.kept, ...model.ordinary];
  const actual = Object.keys(real.ranks).sort((a, b) => comparePinRanks(real.ranks[a], real.ranks[b]));
  expect(actual).toEqual(expected);
  expect(new Set(actual).size).toBe(expected.length);
  expect(new Set(Object.values(real.ranks).map(Number)).size).toBe(expected.length);
  for (const key of actual) expect(isKeptAtTopRank(real.ranks[key])).toBe(model.kept.includes(key));
}

class PinCommand implements fc.Command<Model, Real> {
  constructor(readonly operation: Operation) {}

  check(model: Readonly<Model>): boolean {
    return this.operation.kind === "pin" || model.kept.length + model.ordinary.length > 0;
  }

  run(model: Model, real: Real): void {
    const op = this.operation;
    const all = [...model.kept, ...model.ordinary];
    if (op.kind === "pin") {
      // Local and mounted peer keys occupy the same global rank space.
      const key = `${all.length % 2 ? "peer" : "local"}-${all.length}`;
      real.ranks[key] = buildPrependPinRank(Object.values(real.ranks));
      model.ordinary.unshift(key);
      assertOrder(model, real);
      return;
    }
    const key = all[op.index % all.length]!;
    const source = model.kept.includes(key) ? model.kept : model.ordinary;
    let destination = source;
    let move: NavigationRelativePinMove;
    if (op.kind === "up" || op.kind === "down") {
      move = { key, direction: op.kind };
      const index = source.indexOf(key);
      const next = index + (op.kind === "up" ? -1 : 1);
      if (next >= 0 && next < source.length) [source[index], source[next]] = [source[next]!, source[index]!];
    } else if (op.kind === "keep") {
      const keepAtTop = source === model.ordinary;
      move = { key, keepAtTop };
      source.splice(source.indexOf(key), 1);
      destination = keepAtTop ? model.kept : model.ordinary;
      if (keepAtTop) destination.push(key);
      else destination.unshift(key);
    } else {
      const anchorKey = all[op.anchor % all.length]!;
      move = { key, anchorKey, placement: op.after ? "after" : "before" };
      destination = model.kept.includes(anchorKey) ? model.kept : model.ordinary;
      if (key !== anchorKey) {
        source.splice(source.indexOf(key), 1);
        destination.splice(destination.indexOf(anchorKey) + Number(op.after), 0, key);
      }
    }
    const pins = Object.entries(real.ranks).map(([key, rank]) => ({ key, rank })).reverse();
    expect(moveRelativePin(pins, move)).toEqual({ keptAtTop: destination === model.kept, keys: destination });
    const patch = relativePinRanks(pins, move);
    // Only the destination tier may be rewritten (including compaction).
    expect(Object.keys(patch).every((key) => destination.includes(key))).toBe(true);
    Object.assign(real.ranks, patch);
    expect(Object.keys(real.ranks).sort()).toEqual([...all].sort());
    assertOrder(model, real);
  }

  toString(): string { return JSON.stringify(this.operation); }
}

describe("relative pin order model (AGENTS.md: Inbox, Recents, and Directories)", () => {
  it("matches two plain arrays after arbitrary pins, moves, tier toggles and drags", () => {
    const command = fc.record({
      kind: fc.constantFrom<Operation["kind"]>("pin", "up", "down", "keep", "relative"),
      index: fc.nat(100), anchor: fc.nat(100), after: fc.boolean(),
    }).map((operation) => new PinCommand(operation));
    fc.assert(fc.property(fc.commands([command], { maxCommands: 60 }), (commands) => {
      fc.modelRun(() => ({
        model: { kept: ["kept-0", "kept-1"], ordinary: ["local-0", "peer-0"] },
        real: { ranks: {
          ...buildTierPinRanks(["kept-0", "kept-1"], true),
          ...buildTierPinRanks(["local-0", "peer-0"], false),
        } },
      }), commands);
    }));
  });

  it("compacts exhausted midpoint gaps in either tier without losing pins or making ties", () => {
    fc.assert(fc.property(fc.boolean(), fc.integer({ min: 60, max: 80 }), (keptAtTop, moves) => {
      const model: Model = { kept: keptAtTop ? ["a", "b", "c"] : ["other"], ordinary: keptAtTop ? ["other"] : ["a", "b", "c"] };
      const real: Real = { ranks: { ...buildTierPinRanks(model.kept, true), ...buildTierPinRanks(model.ordinary, false) } };
      const tier = keptAtTop ? model.kept : model.ordinary;
      let compacted = false;
      for (let index = 0; index < moves; index += 1) {
        const key = tier.pop()!;
        tier.splice(1, 0, key);
        const pins = Object.entries(real.ranks).map(([key, rank]) => ({ key, rank }));
        const patch = relativePinRanks(pins, { key, anchorKey: "a", placement: "after" });
        compacted ||= Object.keys(patch).length > 1;
        Object.assign(real.ranks, patch);
        assertOrder(model, real);
      }
      expect(compacted).toBe(true);
    }));
  });
});
