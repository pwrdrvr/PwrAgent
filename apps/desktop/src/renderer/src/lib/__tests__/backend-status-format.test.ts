import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared";
import {
  formatRateLimitLine,
  selectVisibleRateLimits,
} from "../backend-status-format";

afterEach(() => {
  vi.useRealTimers();
});

describe("backend status formatting", () => {
  it("keeps regular and Spark rate limits visible", () => {
    const backend = {
      rateLimits: [
        { name: "GPT-5.3-Codex-Spark Weekly limit", usedPercent: 1 },
        { name: "Weekly limit", usedPercent: 39 },
        { name: "GPT-5.3-Codex-Spark 5h limit", usedPercent: 2 },
        { name: "5h limit", usedPercent: 26 },
        { name: "other limit", usedPercent: 50 },
      ],
    } as BackendSummary;

    expect(selectVisibleRateLimits(backend).map((limit) => limit.name)).toEqual([
      "5h limit",
      "Weekly limit",
      "GPT-5.3-Codex-Spark 5h limit",
      "GPT-5.3-Codex-Spark Weekly limit",
    ]);
  });

  it("formats sub-24-hour resets as times", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 13, 22, 0, 0));

    expect(
      formatRateLimitLine({
        name: "GPT-5.3-Codex-Spark 5h limit",
        usedPercent: 0,
        resetAt: new Date(2026, 4, 14, 2, 20, 0).getTime(),
      }),
    ).toContain("resets 2:20 AM");
  });

  it("formats later resets as dates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 13, 22, 0, 0));

    expect(
      formatRateLimitLine({
        name: "Weekly limit",
        usedPercent: 39,
        resetAt: new Date(2026, 4, 18, 0, 0, 0).getTime(),
      }),
    ).toContain("resets May 18");
  });
});
