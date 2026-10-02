import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared";
import {
  describeRateLimitRow,
  formatBackendPlanType,
  formatRateLimitLine,
  selectVisibleRateLimits,
} from "../backend-status-format";

afterEach(() => {
  vi.useRealTimers();
});

describe("backend status formatting", () => {
  it("keeps regular and Spark rate limits visible", () => {
    const backend: Pick<BackendSummary, "kind" | "rateLimits"> = {
      kind: "codex",
      rateLimits: [
        { name: "GPT-5.3-Codex-Spark Weekly limit", usedPercent: 1 },
        { name: "Weekly limit", usedPercent: 39 },
        { name: "GPT-5.3-Codex-Spark 5h limit", usedPercent: 2 },
        { name: "5h limit", usedPercent: 26 },
        { name: "Individual limit", usedPercent: 4 },
        {
          name: "gpt-reserve Weekly limit",
          limitId: "base_model_inference",
          limitName: "gpt-reserve",
          usedPercent: 0,
        },
        { name: "other limit", usedPercent: 50 },
      ],
    };

    expect(selectVisibleRateLimits(backend).map((limit) => limit.name)).toEqual([
      "5h limit",
      "Weekly limit",
      "Individual limit",
      "GPT-5.3-Codex-Spark 5h limit",
      "GPT-5.3-Codex-Spark Weekly limit",
    ]);
  });

  it("shows Luna Reserve after the included 5h window is exhausted", () => {
    const backend: Pick<BackendSummary, "kind" | "rateLimits"> = {
      kind: "codex",
      rateLimits: [
        { name: "5h limit", usedPercent: 100 },
        { name: "Weekly limit", usedPercent: 39 },
        {
          name: "gpt-reserve Weekly limit",
          limitId: "base_model_inference",
          limitName: "gpt-reserve",
          usedPercent: 0,
        },
        { name: "GPT-5.3-Codex-Spark 5h limit", usedPercent: 2 },
      ],
    };

    expect(selectVisibleRateLimits(backend).map((limit) => limit.name)).toEqual([
      "5h limit",
      "Weekly limit",
      "gpt-reserve Weekly limit",
      "GPT-5.3-Codex-Spark 5h limit",
    ]);
  });

  it("shows Luna Reserve after the included weekly window is exhausted", () => {
    const backend: Pick<BackendSummary, "kind" | "rateLimits"> = {
      kind: "codex",
      rateLimits: [
        { name: "5h limit", usedPercent: 26 },
        { name: "Weekly limit", remaining: 0 },
        {
          name: "gpt-reserve Weekly limit",
          limitId: "base_model_inference",
          limitName: "gpt-reserve",
          usedPercent: 12,
        },
      ],
    };

    expect(selectVisibleRateLimits(backend).map((limit) => limit.name)).toEqual([
      "5h limit",
      "Weekly limit",
      "gpt-reserve Weekly limit",
    ]);
  });

  it("does not treat an exhausted Spark window as primary-plan exhaustion", () => {
    const backend: Pick<BackendSummary, "kind" | "rateLimits"> = {
      kind: "codex",
      rateLimits: [
        { name: "5h limit", usedPercent: 26 },
        { name: "Weekly limit", usedPercent: 39 },
        { name: "GPT-5.3-Codex-Spark 5h limit", usedPercent: 100 },
        {
          name: "gpt-reserve Weekly limit",
          limitId: "base_model_inference",
          limitName: "gpt-reserve",
          usedPercent: 0,
        },
      ],
    };

    expect(selectVisibleRateLimits(backend).map((limit) => limit.name)).toEqual([
      "5h limit",
      "Weekly limit",
      "GPT-5.3-Codex-Spark 5h limit",
    ]);
  });

  it("keeps provider-defined Grok rate limits visible", () => {
    const backend: Pick<BackendSummary, "kind" | "rateLimits"> = {
      kind: "acp:grok",
      rateLimits: [
        { name: "Included credits", usedPercent: 2 },
        { name: "other limit", usedPercent: 50 },
      ],
    };

    expect(selectVisibleRateLimits(backend).map((limit) => limit.name)).toEqual([
      "Included credits",
      "other limit",
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

  it("formats individual usage with totals and remaining percentage", () => {
    expect(
      formatRateLimitLine({
        name: "Individual limit",
        limit: 100000,
        used: 3500.4,
        usedPercent: 4,
      }),
    ).toBe("Individual limit: 3,500/100,000 used, 96% left");
  });

  it("labels the gpt-reserve bucket as Luna Reserve", () => {
    expect(
      formatRateLimitLine({
        name: "gpt-reserve Weekly limit",
        limitId: "base_model_inference",
        limitName: "gpt-reserve",
        usedPercent: 0,
      }),
    ).toBe("Luna Reserve: 100% left");
  });

  it("shows the Codex account credits balance ahead of plan windows", () => {
    const backend: Pick<BackendSummary, "kind" | "rateLimits"> = {
      kind: "codex",
      rateLimits: [
        { name: "5h limit", usedPercent: 100 },
        { name: "Weekly limit", usedPercent: 100 },
        {
          name: "Credits",
          limitId: "credits",
          windowKey: "credits",
          hasCredits: true,
          remaining: 100,
        },
        {
          name: "gpt-reserve Weekly limit",
          limitId: "base_model_inference",
          limitName: "gpt-reserve",
          usedPercent: 0,
        },
      ],
    };

    expect(selectVisibleRateLimits(backend).map((limit) => limit.name)).toEqual([
      "Credits",
      "5h limit",
      "Weekly limit",
      "gpt-reserve Weekly limit",
    ]);
  });

  it("hides a credits row that the protocol marked as empty", () => {
    const backend: Pick<BackendSummary, "kind" | "rateLimits"> = {
      kind: "codex",
      rateLimits: [
        { name: "5h limit", usedPercent: 26 },
        {
          name: "Credits",
          limitId: "credits",
          windowKey: "credits",
          hasCredits: false,
          unlimited: false,
        },
      ],
    };

    expect(selectVisibleRateLimits(backend).map((limit) => limit.name)).toEqual([
      "5h limit",
    ]);
  });

  it.each([
    [1226.02, "1,226"],
    [1226.5, "1,227"],
    [0.4, "0"],
    [0, "0"],
  ])("rounds %s credits to %s without a currency symbol", (remaining, expected) => {
    expect(formatRateLimitLine({
      name: "Credits",
      windowKey: "credits",
      hasCredits: remaining > 0,
      remaining,
    })).toBe(`Credits: ${expected}`);
  });

  it("formats a credits balance, unlimited credits, and a hidden amount", () => {
    expect(
      formatRateLimitLine({
        name: "Credits",
        windowKey: "credits",
        hasCredits: true,
        remaining: 100,
      }),
    ).toBe("Credits: 100");
    expect(
      formatRateLimitLine({
        name: "Credits",
        windowKey: "credits",
        unlimited: true,
      }),
    ).toBe("Credits: unlimited");
    expect(
      formatRateLimitLine({
        name: "Credits",
        windowKey: "credits",
        hasCredits: true,
      }),
    ).toBe("Credits: available");
  });

  it("capitalizes Codex plan ids and leaves an agent's plan name alone", () => {
    expect(formatBackendPlanType({ kind: "codex" }, "pro")).toBe("Pro");
    expect(formatBackendPlanType({ kind: "codex" }, "business")).toBe("Business");
    expect(formatBackendPlanType({ kind: "codex" }, "self_serve_business")).toBe("Self Serve Business");
    expect(formatBackendPlanType({ kind: "acp:grok" }, "X Premium+")).toBe("X Premium+");
    expect(formatBackendPlanType({ kind: "acp:grok" }, "pro")).toBe("pro");
  });

  it("describes a limit as percent used, with a weekday reset within the week", () => {
    const now = new Date(2026, 9, 1, 21, 35).getTime();
    const resetAt = new Date(2026, 9, 5, 8).getTime();
    const row = describeRateLimitRow({ name: "Weekly limit", usedPercent: 53, resetAt }, now);
    expect(row).toMatchObject({ label: "Weekly limit", figure: "53%", text: "used", usedPercent: 53 });
    expect(row.reset).toBe(`resets ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric" }).format(resetAt)}`);
  });

  it("describes individual usage as used of total, and remaining percent as used", () => {
    const now = new Date(2026, 9, 1, 21, 35).getTime();
    expect(describeRateLimitRow({ name: "Individual limit", used: 509, limit: 100_000, usedPercent: 0.5 }, now))
      .toMatchObject({ figure: "509", text: `of ${(100_000).toLocaleString()} used`, usedPercent: 0.5 });
    expect(describeRateLimitRow({ name: "Included credits", remaining: 58 }, now))
      .toMatchObject({ label: "Included credits", figure: "42%", usedPercent: 42 });
  });

  it("describes credits as a balance row without a meter", () => {
    const now = Date.now();
    const credits = { name: "Credits", limitId: "credits", windowKey: "credits" as const };
    expect(describeRateLimitRow({ ...credits, remaining: 63_585, hasCredits: true }, now))
      .toEqual({ label: "Credits", figure: (63_585).toLocaleString() });
    expect(describeRateLimitRow({ ...credits, hasCredits: true }, now)).toEqual({ label: "Credits", text: "Available" });
    expect(describeRateLimitRow({ ...credits, unlimited: true }, now)).toEqual({ label: "Credits", text: "Unlimited" });
  });
});
