import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexModelProviderCatalogState } from "@pwragent/shared";
import { CodexProviderCatalogRetry } from "../app-server/codex-provider-catalog-retry";

const ready: CodexModelProviderCatalogState = { id: "mathos", name: "MathOS", status: "ready", listedCount: 0, discoveredCount: 3 };
const down: CodexModelProviderCatalogState = { id: "mathos", name: "MathOS", status: "unavailable", listedCount: 0, error: "HTTP 503" };

afterEach(() => {
  vi.useRealTimers();
});

describe("CodexProviderCatalogRetry", () => {
  it("schedules nothing while every provider is healthy or switched off", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => [ready]);
    const retry = new CodexProviderCatalogRetry({ refresh });
    retry.observe([ready, { ...ready, id: "listed", status: "off" }, { ...ready, id: "new", status: "pending" }]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("backs off from just past the failure window to ten minutes, and stops on recovery", async () => {
    vi.useFakeTimers();
    let failures = 5;
    const refresh = vi.fn(async () => (failures-- > 0 ? [down] : [ready]));
    const retry = new CodexProviderCatalogRetry({ refresh });
    retry.observe([down]);
    const delays: number[] = [];
    let elapsed = 0;
    while (vi.getTimerCount() > 0) {
      const before = refresh.mock.calls.length;
      while (refresh.mock.calls.length === before) {
        await vi.advanceTimersByTimeAsync(1_000);
        elapsed += 1_000;
      }
      delays.push(elapsed);
      elapsed = 0;
    }
    expect(delays).toEqual([65_000, 130_000, 260_000, 520_000, 600_000, 600_000]);
    expect(refresh).toHaveBeenCalledTimes(6);
  });

  it("drops its timer when closed", () => {
    vi.useFakeTimers();
    const retry = new CodexProviderCatalogRetry({ refresh: async () => [down] });
    retry.observe([down]);
    expect(vi.getTimerCount()).toBe(1);
    retry.close();
    expect(vi.getTimerCount()).toBe(0);
    retry.observe([down]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
