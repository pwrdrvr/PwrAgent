import { afterEach, expect, it, vi } from "vitest";
import { readRenderingSnapshot } from "../../../../shared/rendering-diagnostics";

afterEach(() => {
  document.body.innerHTML = "";
  location.hash = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("exports only fixed animation and view labels, bounded counts and geometric visibility", () => {
  class FakeCSSAnimation {
    animationName = "pending-spinner-spin";
    playState = "running";
    effect = {
      target: document.createElement("div"),
      getTiming: () => ({ iterations: Infinity }),
    };
  }
  vi.stubGlobal("CSSAnimation", FakeCSSAnimation);
  const animation = new FakeCSSAnimation();
  animation.effect.target.className = "pending-spinner private-account";
  animation.effect.target.textContent = "private-prompt";
  document.body.append(animation.effect.target);
  vi.spyOn(animation.effect.target, "getBoundingClientRect").mockReturnValue({
    top: 10, left: 10, right: 20, bottom: 20, width: 10, height: 10,
  } as DOMRect);
  const unknown = new FakeCSSAnimation();
  unknown.animationName = "private-animation";
  Object.defineProperty(document, "getAnimations", {
    configurable: true, value: () => [animation, unknown],
  });
  location.hash = "usage-activity?provider=private-provider";
  const result = readRenderingSnapshot();
  expect(result.view).toBe("usage-activity");
  expect(result.animations[0]).toEqual({
    state: ["pending-spinner-spin", ".pending-spinner", "running", true, true], count: 1,
  });
  expect(result.animations[1].state[0]).toBe("other");
  expect(JSON.stringify(result)).not.toContain("private");
  Object.defineProperty(document, "getAnimations", {
    configurable: true, value: () => Array.from({ length: 200 }, () => animation),
  });
  expect(readRenderingSnapshot().omittedAnimations).toBe(72);
  expect(readRenderingSnapshot().animations[0].count).toBe(128);
});
