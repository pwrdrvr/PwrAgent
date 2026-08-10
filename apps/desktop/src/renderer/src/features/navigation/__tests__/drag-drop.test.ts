import { describe, expect, it, vi } from "vitest";
import { createDropIndicatorController } from "../drag-drop";

describe("drop indicator controller", () => {
  it("updates only the target elements instead of React state", () => {
    const controller = createDropIndicatorController();
    const first = document.createElement("div");
    const second = document.createElement("div");

    controller.show(first, {
      targetKey: "thread-1",
      position: "before",
    });
    expect(first.classList.contains("is-drop-target-before")).toBe(true);

    controller.show(second, {
      targetKey: "thread-2",
      position: "after",
    });
    expect(first.classList.contains("is-drop-target-before")).toBe(false);
    expect(second.classList.contains("is-drop-target-after")).toBe(true);

    controller.clear();
    expect(second.classList.contains("is-drop-target-after")).toBe(false);
  });

  it("does not rewrite an unchanged target", () => {
    const controller = createDropIndicatorController();
    const target = document.createElement("div");
    const add = vi.spyOn(target.classList, "add");

    controller.show(target, {
      targetKey: "thread-1",
      position: "before",
    });
    controller.show(target, {
      targetKey: "thread-1",
      position: "before",
    });

    expect(add).toHaveBeenCalledTimes(1);
  });
});
