import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampTerminalColumns,
  clampTerminalRows,
  PTY_RESIZE_INTERVAL_MS,
  PtyResizeCoalescer,
} from "../terminal/pty-resize";

/** A pacer over a fake clock, with every applied size recorded in order. */
function createCoalescer(
  options: {
    spawnedCols?: number;
    spawnedRows?: number;
    intervalMs?: number;
  } = {},
) {
  const applied: [number, number][] = [];
  const apply = vi.fn((cols: number, rows: number) => {
    applied.push([cols, rows]);
  });
  const deferredErrors: unknown[] = [];
  // Offset from the fake timer clock, so a test can step the wall clock
  // independently of how far timers have advanced.
  let clockOffset = 0;
  const coalescer = new PtyResizeCoalescer({
    apply,
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    now: () => Date.now() + clockOffset,
    onDeferredError: (error) => deferredErrors.push(error),
    spawnedCols: options.spawnedCols ?? 80,
    spawnedRows: options.spawnedRows ?? 24,
  });
  return {
    applied,
    apply,
    coalescer,
    deferredErrors,
    stepClock: (ms: number) => {
      clockOffset += ms;
    },
  };
}

describe("clampTerminalColumns / clampTerminalRows", () => {
  it("clamps to the shared bounds and only defaults on a non-finite value", () => {
    expect(clampTerminalColumns(100)).toBe(100);
    expect(clampTerminalColumns(4000)).toBe(500);
    expect(clampTerminalColumns(80.4)).toBe(80);
    // 0 is finite, so it floors rather than falling back to 80.
    expect(clampTerminalColumns(0)).toBe(2);
    expect(clampTerminalColumns(Number.NaN)).toBe(80);
    expect(clampTerminalRows(30)).toBe(30);
    expect(clampTerminalRows(1000)).toBe(200);
    expect(clampTerminalRows(1)).toBe(2);
    expect(clampTerminalRows(Number.POSITIVE_INFINITY)).toBe(18);
  });
});

describe("PtyResizeCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never resizes to the grid the PTY was spawned at", () => {
    // Out of range on both axes, so a seed clamped differently from a request
    // would never match back.
    const { applied, coalescer } = createCoalescer({
      spawnedCols: 4000,
      spawnedRows: 1,
    });
    coalescer.request(4000, 1);
    coalescer.request(500, 2);
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS * 4);
    expect(applied).toEqual([]);
  });

  it("applies the first request immediately", () => {
    const { applied, coalescer } = createCoalescer();
    coalescer.request(100, 30);
    expect(applied).toEqual([[100, 30]]);
  });

  it("collapses a drag burst into one resize per interval, keeping the last", () => {
    const { applied, coalescer } = createCoalescer();
    // The leading edge sizes the shell at once.
    coalescer.request(100, 30);
    expect(applied).toEqual([[100, 30]]);
    // Everything a drag produces inside the window is superseded, not queued.
    for (let cols = 101; cols <= 140; cols += 1) {
      coalescer.request(cols, 30);
    }
    expect(applied).toEqual([[100, 30]]);
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS);
    expect(applied).toEqual([
      [100, 30],
      [140, 30],
    ]);
    // The trailing apply does not itself arm another timer.
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS * 4);
    expect(applied).toEqual([
      [100, 30],
      [140, 30],
    ]);
  });

  it("caps a sustained drag far below its frame rate", () => {
    const { applied, coalescer } = createCoalescer();
    // 300 frames over 300ms — roughly what dragging a window edge produces.
    for (let frame = 0; frame < 300; frame += 1) {
      coalescer.request(100 + (frame % 60), 30);
      vi.advanceTimersByTime(1);
    }
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS);
    // 300ms of dragging is at most six 50ms windows, plus the leading and
    // trailing applies. Deliberately a hard number rather than one derived
    // from the interval, which would agree with any interval it was given.
    // Unpaced, this is 300.
    expect(applied.length).toBeLessThanOrEqual(8);
    expect(applied.length).toBeGreaterThan(1);
  });

  it("lands on the size the burst ended at", () => {
    const { applied, coalescer } = createCoalescer();
    coalescer.request(100, 30);
    coalescer.request(120, 40);
    coalescer.request(90, 20);
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS);
    expect(applied.at(-1)).toEqual([90, 20]);
  });

  it("drops a queued resize when the burst returns to the applied size", () => {
    const { applied, coalescer } = createCoalescer();
    coalescer.request(100, 30);
    coalescer.request(120, 40);
    // The viewer dragged away and back inside one window; the PTY is already
    // at 100x30, so nothing should be sent.
    coalescer.request(100, 30);
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS * 4);
    expect(applied).toEqual([[100, 30]]);
  });

  it("does not suppress a return to an earlier size once the window has passed", () => {
    const { applied, coalescer } = createCoalescer();
    coalescer.request(100, 30);
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS);
    coalescer.request(80, 24);
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS);
    coalescer.request(100, 30);
    expect(applied).toEqual([
      [100, 30],
      [80, 24],
      [100, 30],
    ]);
  });

  it("normalizes before deduplicating, so an out-of-range repeat is dropped", () => {
    const { applied, coalescer } = createCoalescer();
    coalescer.request(4000, 1000);
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS);
    coalescer.request(9999, 5000);
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS);
    expect(applied).toEqual([[500, 200]]);
  });

  it("throws a synchronous rejection to its caller and retries it", () => {
    const { applied, apply, coalescer } = createCoalescer();
    apply.mockImplementationOnce(() => {
      throw new Error("Resize failed");
    });
    expect(() => coalescer.request(100, 30)).toThrow("Resize failed");
    // The rejected size was never applied, so it is not remembered as current
    // and the next request is free to retry it immediately.
    coalescer.request(100, 30);
    expect(applied).toEqual([[100, 30]]);
  });

  it("reports a deferred rejection instead of throwing from the timer", () => {
    const { apply, coalescer, deferredErrors } = createCoalescer();
    coalescer.request(100, 30);
    apply.mockImplementationOnce(() => {
      throw new Error("Cannot resize a pty that has already exited");
    });
    coalescer.request(120, 40);
    expect(() => vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS)).not.toThrow();
    expect(deferredErrors).toHaveLength(1);
    // Still not remembered as applied, so a later request retries it.
    coalescer.request(120, 40);
    expect(apply).toHaveBeenLastCalledWith(120, 40);
  });

  it("still applies a queued resize after the wall clock steps backwards", () => {
    const { applied, coalescer, stepClock } = createCoalescer();
    coalescer.request(100, 30);
    expect(applied).toEqual([[100, 30]]);
    // An NTP correction or a resume from sleep moves the clock back an hour.
    // Unbounded, the armed wait becomes an hour and every later request only
    // overwrites `pending`, so this PTY's size freezes for that whole hour.
    stepClock(-60 * 60 * 1000);
    coalescer.request(120, 40);
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS);
    expect(applied).toEqual([
      [100, 30],
      [120, 40],
    ]);
  });

  it("keeps pacing after the wall clock steps backwards", () => {
    const { applied, coalescer, stepClock } = createCoalescer();
    coalescer.request(100, 30);
    stepClock(-60 * 60 * 1000);
    // A backwards clock must not turn into a free pass either: these all land
    // inside one interval and must still collapse to one apply.
    for (let cols = 101; cols <= 140; cols += 1) {
      coalescer.request(cols, 30);
    }
    expect(applied).toEqual([[100, 30]]);
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS);
    expect(applied).toEqual([
      [100, 30],
      [140, 30],
    ]);
  });

  it("paces on a frozen clock rather than stalling or running free", () => {
    // `IntegratedTerminalService` tests already inject `now: () => 1_000`, so
    // a stopped clock is a shape this has to survive.
    const { applied, coalescer } = createCoalescer();
    vi.setSystemTime(1_000);
    coalescer.request(100, 30);
    coalescer.request(120, 40);
    expect(applied).toEqual([[100, 30]]);
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS);
    expect(applied).toEqual([
      [100, 30],
      [120, 40],
    ]);
  });

  it("falls back to the default interval when handed a nonsense one", () => {
    const { applied, coalescer } = createCoalescer({ intervalMs: Number.NaN });
    coalescer.request(100, 30);
    coalescer.request(120, 40);
    // Not applied immediately: NaN must not read as "no minimum gap".
    expect(applied).toEqual([[100, 30]]);
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS);
    expect(applied).toEqual([
      [100, 30],
      [120, 40],
    ]);
  });

  it("applies nothing more once disposed", () => {
    const { applied, coalescer } = createCoalescer();
    coalescer.dispose();
    coalescer.request(100, 30);
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS * 4);
    expect(applied).toEqual([]);
  });

  it("drops a queued resize on dispose", () => {
    const { applied, coalescer } = createCoalescer();
    coalescer.request(100, 30);
    coalescer.request(120, 40);
    coalescer.dispose();
    vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS * 4);
    expect(applied).toEqual([[100, 30]]);
  });
});
