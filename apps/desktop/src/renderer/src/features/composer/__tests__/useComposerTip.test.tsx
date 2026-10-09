import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { COMPOSER_TIPS } from "../composer-tips";
import { resetComposerTipRotationForTests, useComposerTip } from "../useComposerTip";

const tip = (index: number): string | undefined => COMPOSER_TIPS[index % COMPOSER_TIPS.length]!();

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

  it("does not skip a tip when leaving a drafted thread for an empty one", () => {
    // Composer stays mounted across threads and restores the next thread's
    // draft a render after the scope changes, so the switch renders the new
    // scope with the old draft first, then empties.
    const { result, rerender } = renderHook(
      ({ scopeKey, empty }) => useComposerTip(scopeKey, empty),
      { initialProps: { scopeKey: "thread-a", empty: true } },
    );
    rerender({ scopeKey: "thread-a", empty: false });
    rerender({ scopeKey: "thread-b", empty: false });
    rerender({ scopeKey: "thread-b", empty: true });
    expect(result.current).toBe(tip(1));
  });

  it("keeps a tip nobody has seen yet when a thread opened with a draft empties", () => {
    const { result, rerender } = renderHook(
      ({ scopeKey, empty }) => useComposerTip(scopeKey, empty),
      { initialProps: { scopeKey: "thread-a", empty: false } },
    );
    rerender({ scopeKey: "thread-a", empty: true });
    expect(result.current).toBe(tip(0));
    rerender({ scopeKey: "thread-b", empty: true });
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
  it("keeps every tip short enough for one line of the default-width reply box", () => {
    // No desktop bridge here, so shortcut tips render their longer
    // Windows/Linux form ("Ctrl+Shift+F"), which is the one to budget for.
    for (const render of COMPOSER_TIPS) {
      // Defaults bind every chord a tip names, so every tip renders.
      expect(render()?.length).toBeLessThanOrEqual(58);
    }
  });

  it("renders each shortcut in the platform's own form when shown", () => {
    const win = window as Window & { pwragent?: { platform?: string } };
    const saved = win.pwragent;
    try {
      win.pwragent = { platform: "darwin" };
      const mac = COMPOSER_TIPS.map((render) => render()).join("\n");
      expect(mac).toContain("⌘K finds threads");
      // The native menu's modifier order: ⇧ before ⌘.
      expect(mac).toContain("⇧⌘F searches the text of every transcript");
      expect(mac).not.toContain("Ctrl+");
      win.pwragent = { platform: "win32" };
      const windows = COMPOSER_TIPS.map((render) => render()).join("\n");
      expect(windows).toContain("Ctrl+K finds threads");
      expect(windows).toContain("Ctrl+Shift+F searches the text of every transcript");
      expect(windows).not.toMatch(/[⌘⇧⌥]/);
    } finally {
      if (saved === undefined) {
        delete win.pwragent;
      } else {
        win.pwragent = saved;
      }
    }
  });

  it("has no duplicate tips", () => {
    const tips = COMPOSER_TIPS.map((render) => render());
    expect(new Set(tips).size).toBe(tips.length);
  });
});
