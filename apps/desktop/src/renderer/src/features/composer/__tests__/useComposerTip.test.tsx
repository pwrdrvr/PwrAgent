import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { COMPOSER_TIPS } from "../composer-tips";
import { resetComposerTipRotationForTests, useComposerTip } from "../useComposerTip";

const tip = (index: number): string => COMPOSER_TIPS[index % COMPOSER_TIPS.length]!();

describe("useComposerTip", () => {
  beforeEach(() => {
    resetComposerTipRotationForTests(0);
  });

  it("keeps one tip while the operator stays on a thread", () => {
    const { result, rerender } = renderHook(
      ({ scopeKey, empty }) => useComposerTip(scopeKey, empty),
      { initialProps: { scopeKey: "thread-a", empty: true } },
    );
    expect(result.current).toBe(tip(0));
    rerender({ scopeKey: "thread-a", empty: true });
    rerender({ scopeKey: "thread-a", empty: true });
    expect(result.current).toBe(tip(0));
  });

  it("shows the next tip on the next thread", () => {
    const { result, rerender } = renderHook(
      ({ scopeKey, empty }) => useComposerTip(scopeKey, empty),
      { initialProps: { scopeKey: "thread-a", empty: true } },
    );
    rerender({ scopeKey: "thread-b", empty: true });
    expect(result.current).toBe(tip(1));
    rerender({ scopeKey: "thread-a", empty: true });
    expect(result.current).toBe(tip(2));
  });

  it("shows the next tip when the box empties after a draft, not when typing starts", () => {
    const { result, rerender } = renderHook(
      ({ scopeKey, empty }) => useComposerTip(scopeKey, empty),
      { initialProps: { scopeKey: "thread-a", empty: true } },
    );
    rerender({ scopeKey: "thread-a", empty: false });
    expect(result.current).toBe(tip(0));
    rerender({ scopeKey: "thread-a", empty: true });
    expect(result.current).toBe(tip(1));
  });

  it("continues the rotation across composers instead of restarting it", () => {
    renderHook(() => useComposerTip("thread-a", true));
    const second = renderHook(() => useComposerTip("thread-b", true));
    expect(second.result.current).toBe(tip(1));
  });

  it("shows no tip and spends none for a composer without a scope", () => {
    const launchpad = renderHook(
      ({ empty }) => useComposerTip(undefined, empty),
      { initialProps: { empty: true } },
    );
    expect(launchpad.result.current).toBeUndefined();
    launchpad.rerender({ empty: false });
    launchpad.rerender({ empty: true });
    expect(launchpad.result.current).toBeUndefined();
    const reply = renderHook(() => useComposerTip("thread-a", true));
    expect(reply.result.current).toBe(tip(0));
  });

  it("wraps around after the last tip", () => {
    resetComposerTipRotationForTests(COMPOSER_TIPS.length - 1);
    const { result, rerender } = renderHook(
      ({ scopeKey }) => useComposerTip(scopeKey, true),
      { initialProps: { scopeKey: "thread-a" } },
    );
    expect(result.current).toBe(tip(COMPOSER_TIPS.length - 1));
    rerender({ scopeKey: "thread-b" });
    expect(result.current).toBe(tip(0));
  });
});

describe("COMPOSER_TIPS", () => {
  it("keeps every tip short enough for one line of the reply box", () => {
    for (const render of COMPOSER_TIPS) {
      expect(render().length).toBeLessThanOrEqual(80);
    }
  });

  it("has no duplicate tips", () => {
    const tips = COMPOSER_TIPS.map((render) => render());
    expect(new Set(tips).size).toBe(tips.length);
  });
});
