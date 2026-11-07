import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  activeDestinationIndex,
  DESTINATION_CURSOR_START,
  pointDestinationCursor,
  settleDestinationCursor,
  stepDestinationCursor,
  type DestinationCursor,
} from "../thread-search-cursor";

// Model: the row the operator sees highlighted, and the row they last chose.
// Each command states the picker's promise in those terms:
// - typing starts over at the first row;
// - an arrow moves one row from the highlighted one, and wraps;
// - pointing highlights that row;
// - when searches replace the rows, the chosen row stays highlighted wherever
//   it moved; without it the highlight stays put, or on the last row of a
//   shorter list.
type Model = { keys: readonly string[]; active: number; chosen?: string };
type Real = { cursor: DestinationCursor; keys: readonly string[] };
type Command = fc.Command<Model, Real>;

const UNIVERSE = ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"];

function check(model: Model, real: Real): void {
  expect(activeDestinationIndex(real.cursor, real.keys)).toBe(model.active);
  // Enter picks the row on screen, which always exists while rows do.
  if (model.keys.length > 0) expect(real.keys[model.active]).toBeDefined();
}

class TypeCommand implements Command {
  check = () => true;
  run(model: Model, real: Real): void {
    real.cursor = DESTINATION_CURSOR_START;
    model.chosen = undefined;
    model.active = model.keys.length > 0 ? 0 : -1;
    check(model, real);
  }
  toString = () => "type";
}

class ArrowCommand implements Command {
  constructor(readonly step: 1 | -1) {}
  check = () => true;
  run(model: Model, real: Real): void {
    real.cursor = stepDestinationCursor(real.cursor, real.keys, this.step);
    if (model.keys.length > 0) {
      model.active = (model.active + this.step + model.keys.length) % model.keys.length;
      model.chosen = model.keys[model.active];
    }
    check(model, real);
  }
  toString = () => (this.step === 1 ? "down" : "up");
}

class PointCommand implements Command {
  constructor(readonly index: number) {}
  check = (model: Readonly<Model>) => this.index < model.keys.length;
  run(model: Model, real: Real): void {
    real.cursor = pointDestinationCursor(real.keys, this.index);
    model.active = this.index;
    model.chosen = model.keys[this.index];
    check(model, real);
  }
  toString = () => `point(${this.index})`;
}

class RowsCommand implements Command {
  constructor(readonly keys: readonly string[]) {}
  check = () => true;
  run(model: Model, real: Real): void {
    const chosenAt = model.chosen === undefined ? -1 : this.keys.indexOf(model.chosen);
    model.active = this.keys.length === 0 ? -1
      : chosenAt >= 0 ? chosenAt
      : model.active < 0 ? 0
      : Math.min(model.active, this.keys.length - 1);
    model.keys = this.keys;
    real.keys = this.keys;
    // The render with the new rows, before the effect settles the cursor...
    check(model, real);
    real.cursor = settleDestinationCursor(real.cursor, real.keys);
    // ...and after: the highlight must not move between the two.
    check(model, real);
  }
  toString = () => `rows(${this.keys.join(",")})`;
}

const commands = [
  fc.constant(new TypeCommand()),
  fc.constantFrom(1 as const, -1 as const).map((step) => new ArrowCommand(step)),
  fc.nat({ max: UNIVERSE.length - 1 }).map((index) => new PointCommand(index)),
  fc.shuffledSubarray(UNIVERSE).map((keys) => new RowsCommand(keys)),
];

describe("to-do destination cursor", () => {
  it("keeps the highlight where the operator put it as searches replace the rows", () => {
    fc.assert(fc.property(fc.commands(commands, { maxCommands: 40 }), (cmds) => {
      fc.modelRun(
        () => ({ model: { keys: [], active: -1 }, real: { cursor: DESTINATION_CURSOR_START, keys: [] } }),
        cmds,
      );
    }));
  });

  // A shrunk case kept by name: the chosen row leaves, the list shrinks past
  // the highlight, then grows again without it.
  it("does not jump back down when a shorter list grows again", () => {
    const rows = ["k0", "k1", "k2", "k3"];
    let cursor = pointDestinationCursor(rows, 3);
    cursor = settleDestinationCursor(cursor, ["k0", "k1"]);
    expect(activeDestinationIndex(cursor, ["k0", "k1"])).toBe(1);
    expect(activeDestinationIndex(cursor, ["k0", "k1", "k4", "k5"])).toBe(1);
  });
});
