import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StatusPulseModule = typeof import("../status-pulse");

const ON_SCREEN = { top: 10, left: 10, right: 18, bottom: 18, width: 8, height: 8 } as DOMRect;
const OFF_SCREEN = { top: 5000, left: 10, right: 18, bottom: 5008, width: 8, height: 8 } as DOMRect;
const PERIOD = 4500;

type AnimateCall = { dot: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions };

describe("status pulse", () => {
  let calls: AnimateCall[];
  let pulse: StatusPulseModule;
  let visibility: DocumentVisibilityState;
  let reduce: { matches: boolean; listeners: (() => void)[] } | null;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Mid-period, so the first pulse is due at the next period boundary.
    vi.setSystemTime(PERIOD * 1000 + 1200);
    calls = [];
    visibility = "visible";
    reduce = null;
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
        calls.push({ dot: this, keyframes, options });
        return {} as Animation;
      },
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(ON_SCREEN);
    // The module keeps one timer and one media query per window; a fresh copy
    // per test keeps them from leaking between tests.
    vi.resetModules();
    pulse = await import("../status-pulse");
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    // Drain the scheduler: with no dot left, the next pulse stops the timer.
    vi.advanceTimersByTime(PERIOD);
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
    Reflect.deleteProperty(document, "visibilityState");
    Reflect.deleteProperty(window, "matchMedia");
  });

  const mountDots = (...classNames: string[]) => classNames.map((className) => {
    const dot = document.createElement("span");
    dot.className = className;
    document.body.append(dot);
    pulse.statusPulseRef(dot);
    return dot;
  });

  const stubReducedMotion = (matches: boolean) => {
    reduce = { matches, listeners: [] };
    const query = reduce;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        get matches() { return query.matches; },
        addEventListener: (_type: string, listener: () => void) => { query.listeners.push(listener); },
      }),
    });
  };

  it("holds still until the shared wall-clock boundary, then dips every dot in one batch", () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const requestAnimationFrameSpy = vi.spyOn(window, "requestAnimationFrame");
    const dots = mountDots("status-dot status-dot--active status-dot--blink", "rail-chip__dot rail-chip__dot--blink");
    const pr = document.createElement("span");
    pr.className = "pr-chip pr-chip--failing pr-chip--checks-running";
    pr.innerHTML = "<span class=\"pr-chip__dot\"></span>";
    document.body.append(pr);
    dots.push(pr.firstElementChild as HTMLElement);
    pulse.statusPulseRef(dots[2]!);

    // Three mounts, one timer: the scheduler is per window, not per dot.
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0]![1]).toBe(PERIOD - 1200);
    act(() => { vi.advanceTimersByTime(PERIOD - 1201); });
    expect(calls).toHaveLength(0);

    act(() => { vi.advanceTimersByTime(1); });
    expect(calls.map((call) => call.dot)).toEqual(dots);
    for (const call of calls) {
      expect(call.options).toEqual({
        duration: pulse.STATUS_PULSE_DURATION_MS,
        id: pulse.STATUS_PULSE_ANIMATION_ID,
      });
      // The former loop's single iteration: full opacity, a dip to 0.45, back.
      expect(call.keyframes.map((frame) => frame.opacity)).toEqual([1, 0.45, 1]);
    }
    // Finite, so the compositor sleeps between pulses.
    expect(pulse.STATUS_PULSE_DURATION_MS).toBeLessThan(pulse.STATUS_PULSE_PERIOD_MS);
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();

    // And again one period later, with no new mount.
    act(() => { vi.advanceTimersByTime(PERIOD); });
    expect(calls).toHaveLength(6);
  });

  it("skips dots that are offscreen or inside a hidden ancestor", () => {
    const [onScreen, offScreen, hidden] = mountDots(
      "status-dot status-dot--blink",
      "status-dot status-dot--blink",
      "status-dot status-dot--blink",
    );
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      return this === offScreen ? OFF_SCREEN : ON_SCREEN;
    });
    Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
      configurable: true,
      value(this: Element) { return this !== hidden; },
    });
    try {
      act(() => { vi.advanceTimersByTime(PERIOD); });
      expect(calls.map((call) => call.dot)).toEqual([onScreen]);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "checkVisibility");
    }
  });

  it("starts no pulse in a hidden window, and resumes when it is shown", () => {
    mountDots("status-dot status-dot--blink");
    visibility = "hidden";
    act(() => { vi.advanceTimersByTime(PERIOD); });
    expect(calls).toHaveLength(0);

    visibility = "visible";
    act(() => { vi.advanceTimersByTime(PERIOD); });
    expect(calls).toHaveLength(1);
  });

  it("starts no pulse under reduced motion and cancels one already moving", () => {
    stubReducedMotion(false);
    const cancel = vi.fn();
    const other = vi.fn();
    Object.defineProperty(document, "getAnimations", {
      configurable: true,
      value: () => [
        { id: pulse.STATUS_PULSE_ANIMATION_ID, cancel },
        { id: "pwragent-thinking-scanner-scan", cancel: other },
      ],
    });
    try {
      mountDots("status-dot status-dot--blink");
      act(() => { vi.advanceTimersByTime(PERIOD); });
      expect(calls).toHaveLength(1);

      reduce!.matches = true;
      for (const listener of reduce!.listeners) listener();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(other).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(PERIOD * 2); });
      expect(calls).toHaveLength(1);
    } finally {
      Reflect.deleteProperty(document, "getAnimations");
    }
  });

  it("stops its timer once no dot is left and restarts on the next mount", () => {
    const [dot] = mountDots("status-dot status-dot--blink");
    dot!.remove();
    act(() => { vi.advanceTimersByTime(PERIOD); });
    expect(vi.getTimerCount()).toBe(0);

    mountDots("status-dot status-dot--blink");
    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(PERIOD); });
    expect(calls).toHaveLength(1);
  });

  it("stops quietly when its document is gone before the pulse is due", () => {
    // Vitest tears jsdom down when a test file ends. A pulse still pending
    // then fired into a scope with no `document` and failed the run.
    mountDots("status-dot status-dot--blink");
    vi.stubGlobal("document", undefined);
    try {
      expect(() => vi.advanceTimersByTime(PERIOD)).not.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toHaveLength(0);
  });

  it("starts the timer from a chip only while it pulses", async () => {
    const { RailStatusChip } = await import("../../features/thread-detail/context-panels/RailStatusChip");
    const view = render(<RailStatusChip tone="active">Waiting</RailStatusChip>);
    expect(vi.getTimerCount()).toBe(0);

    // A chip that starts pulsing after mount gets the ref then.
    view.rerender(<RailStatusChip blink tone="active">Waiting</RailStatusChip>);
    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(PERIOD); });
    expect(calls.map((call) => call.dot)).toEqual([
      document.querySelector(".rail-chip__dot--blink"),
    ]);
  });
});

describe("status pulse wiring", () => {
  const rendererSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it("starts the shared timer from every site that renders a pulsing dot", () => {
    // The timer only runs while a mount has started it. A site that renders
    // one of these classes without doing so would sit still whenever no other
    // pulsing dot happens to be mounted.
    const sites = sourceFiles(rendererSrc)
      .filter((file) => !file.endsWith(path.join("lib", "status-pulse.ts")))
      .filter((file) => /status-dot--blink|rail-chip__dot--blink|pr-chip__dot/.test(readFileSync(file, "utf8")));
    expect(sites.length).toBeGreaterThanOrEqual(10);
    const unwired = sites
      .filter((file) => !/\b(?:statusPulseRef|ensureStatusPulse)\b/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(rendererSrc, file));
    expect(unwired).toEqual([]);
  });

  it("keeps the pulse out of app.css, where it would loop forever", () => {
    const css = readFileSync(path.join(rendererSrc, "styles/app.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/status-blink/);
    expect(css).not.toMatch(
      /(?:\.status-dot--blink|\.rail-chip__dot--blink|\.pr-chip--checks-running\s+\.pr-chip__dot)[^{}]*\{[^}]*\banimation\b/,
    );
  });
});
