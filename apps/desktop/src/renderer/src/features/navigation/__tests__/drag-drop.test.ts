import { describe, expect, it } from "vitest";
import {
  resolveDropIndicatorState,
  type DropIndicatorState,
} from "../drag-drop";

describe("drop indicator state", () => {
  it("preserves object identity while dragover remains in the same row half", () => {
    const current: DropIndicatorState = {
      targetKey: "thread-1",
      position: "before",
    };

    expect(resolveDropIndicatorState(current, {
      targetKey: "thread-1",
      position: "before",
    })).toBe(current);
  });

  it("updates when the target row or position changes", () => {
    const current: DropIndicatorState = {
      targetKey: "thread-1",
      position: "before",
    };
    const moved: DropIndicatorState = {
      targetKey: "thread-2",
      position: "after",
    };

    expect(resolveDropIndicatorState(current, moved)).toBe(moved);
    expect(resolveDropIndicatorState(current, undefined)).toBeUndefined();
  });
});
