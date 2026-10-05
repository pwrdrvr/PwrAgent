import { afterEach, describe, expect, it, vi } from "vitest";
import { createRendererErrorCoalescer, rendererErrorSummary } from "../renderer-error-coalescer";
import type { RendererErrorReport } from "../renderer-error";

afterEach(() => vi.useRealTimers());

describe("renderer fault summary lifetime", () => {
  it("reschedules the single timeout when an older fault starts repeating later", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const gate = createRendererErrorCoalescer(emit);
    gate.accept("older", () => "older");
    vi.advanceTimersByTime(30_000);
    gate.accept("newer", () => "newer");
    gate.accept("newer", () => "ignored");
    vi.advanceTimersByTime(1000);
    gate.accept("older", () => "ignored");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(29_000);
    expect(emit).toHaveBeenCalledWith("older", expect.objectContaining({ count: 1 }));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(emit).toHaveBeenLastCalledWith("newer", expect.objectContaining({ count: 1 }));
    expect(vi.getTimerCount()).toBe(0);
    gate.dispose();
  });

  it("flushes evicted counts, bounds remembered faults, and cancels the last pending timer", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const gate = createRendererErrorCoalescer(emit);
    expect(gate.accept("0", () => ({ message: "first" }))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(gate.accept("0", () => { throw new Error("must not recapture"); })).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    for (let index = 1; index < 65; index += 1) gate.accept(String(index), () => ({ message: String(index) }));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith({ message: "first" }, expect.objectContaining({ count: 1 }));
    expect(vi.getTimerCount()).toBe(0);
    expect(gate.accept("64", () => ({}))).toBe(false);
    expect(gate.accept("0", () => ({}))).toBe(true);
    gate.dispose();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles clock rollback and saturates repeat counts without idle polling", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const emit = vi.fn();
    const gate = createRendererErrorCoalescer(emit);
    gate.accept("fault", () => "original");
    gate.accept("fault", () => "ignored", Number.MAX_SAFE_INTEGER);
    gate.accept("fault", () => "ignored");
    vi.setSystemTime(900_000);
    expect(gate.accept("fault", () => "new clock")).toBe(true);
    expect(emit).toHaveBeenCalledWith("original", expect.objectContaining({ count: Number.MAX_SAFE_INTEGER }));
    expect(vi.getTimerCount()).toBe(0);
    gate.dispose();
  });

  it("retains only bounded allowlisted summary fields from IPC", () => {
    const report = {
      href: "h".repeat(100_000), message: "m".repeat(100_000), source: "window-error",
      timestamp: "t".repeat(100_000), userAgent: "u".repeat(100_000), filename: "f".repeat(100_000),
      name: "n".repeat(100_000), stack: "s".repeat(100_000),
      recovery: { action: "automatic-remount", attempt: 1, limit: 2, privateText: "must not retain" },
      privateText: "must not retain",
    } as RendererErrorReport;
    const summary = rendererErrorSummary(report);
    expect(JSON.stringify(summary).length).toBeLessThan(6500);
    expect(summary.message).toHaveLength(1024);
    expect(summary).not.toHaveProperty("stack");
    expect(JSON.stringify(summary)).not.toContain("must not retain");
  });
});
