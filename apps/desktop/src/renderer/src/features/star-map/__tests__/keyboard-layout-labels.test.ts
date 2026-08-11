import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEY_CAP_LABELS,
  resolveKeyCapLabels,
} from "../useKeyboardLayoutLabels";

/**
 * The camera binds by physical position, so the hint has to be labelled from
 * the board in front of the operator rather than from the binding. These are
 * the merge rules; the browser capability itself is not testable here.
 */
describe("resolveKeyCapLabels", () => {
  it("falls back to the QWERTY engravings with no layout map", () => {
    expect(resolveKeyCapLabels(undefined)).toEqual(DEFAULT_KEY_CAP_LABELS);
  });

  it("labels the pan cluster from the operator's layout", () => {
    // AZERTY: the WASD positions are engraved Z Q S D.
    const labels = resolveKeyCapLabels(
      new Map([
        ["KeyW", "z"],
        ["KeyA", "q"],
        ["KeyS", "s"],
        ["KeyD", "d"],
      ]),
    );
    expect(labels).toEqual({ KeyW: "Z", KeyA: "Q", KeyS: "S", KeyD: "D" });
  });

  it("keeps the QWERTY letter for a position that prints nothing usable", () => {
    // A dead key reports "", and some positions report a multi-character
    // name; neither fits an 18px cap, so the fallback letter stays.
    const labels = resolveKeyCapLabels(
      new Map([
        ["KeyW", ""],
        ["KeyA", "Dead"],
        ["KeyS", "o"],
      ]),
    );
    expect(labels.KeyW).toBe("W");
    expect(labels.KeyA).toBe("A");
    expect(labels.KeyS).toBe("O");
    // A code the layout omits entirely also keeps its fallback.
    expect(labels.KeyD).toBe("D");
  });

  it("never invents a cap for a code the hint does not draw", () => {
    const labels = resolveKeyCapLabels(new Map([["KeyQ", "a"]]));
    expect(Object.keys(labels).sort()).toEqual(["KeyA", "KeyD", "KeyS", "KeyW"]);
  });
});
