import { describe, expect, it } from "vitest";
import type { BackendRateLimitSummary } from "../backend-status-format";
import { groupRateLimitsByScope, rateLimitWindowAndScope } from "../rate-limit-scopes";

function limit(name: string, overrides: Partial<BackendRateLimitSummary> = {}): BackendRateLimitSummary {
  return { name, usedPercent: 10, ...overrides };
}

describe("rateLimitWindowAndScope", () => {
  it("reads the label shapes the providers send", () => {
    expect(rateLimitWindowAndScope(limit("Weekly limit"))).toEqual({ window: { label: "Weekly", minutes: 10_080 } });
    expect(rateLimitWindowAndScope(limit("Weekly Claude/GPT limit")))
      .toEqual({ window: { label: "Weekly", minutes: 10_080 }, scope: "Claude/GPT" });
    expect(rateLimitWindowAndScope(limit("5h Gemini limit")))
      .toEqual({ window: { label: "5h", minutes: 300 }, scope: "Gemini" });
    expect(rateLimitWindowAndScope(limit("Weekly Fable limit")))
      .toEqual({ window: { label: "Weekly", minutes: 10_080 }, scope: "Fable" });
    // Claude's own 5-hour window, and Codex's scope-first names.
    expect(rateLimitWindowAndScope(limit("5-hour limit"))).toEqual({ window: { label: "5h", minutes: 300 } });
    expect(rateLimitWindowAndScope(limit("GPT-5.3-Codex-Spark 5h limit")))
      .toEqual({ window: { label: "5h", minutes: 300 }, scope: "GPT-5.3-Codex-Spark" });
  });

  it("takes the window from the structured length over the name", () => {
    expect(rateLimitWindowAndScope(limit("Weekly Gemini limit", { windowMinutes: 10_080 })))
      .toEqual({ window: { label: "Weekly", minutes: 10_080 }, scope: "Gemini" });
    expect(rateLimitWindowAndScope(limit("Primary limit", { windowSeconds: 5 * 3600 })))
      .toEqual({ window: { label: "5h", minutes: 300 } });
    expect(rateLimitWindowAndScope(limit("3d limit"))).toEqual({ window: { label: "3d", minutes: 4320 } });
  });

  it("finds no window on a balance or a cap", () => {
    for (const name of ["Credits", "Extra usage", "Individual limit", "Cloud session credits", "Included credits"]) {
      expect(rateLimitWindowAndScope(limit(name))).toBeUndefined();
    }
  });
});

describe("groupRateLimitsByScope", () => {
  const shape = (groups: ReturnType<typeof groupRateLimitsByScope>) =>
    groups.map((group) => [group.scope, group.windows.map((entry) => entry.limit.name)]);

  it("splits Antigravity's pools, each Weekly then 5h, in the provider's order", () => {
    expect(shape(groupRateLimitsByScope([
      limit("5h Gemini limit", { windowMinutes: 300 }),
      limit("Weekly Gemini limit", { windowMinutes: 10_080 }),
      limit("5h Claude/GPT limit", { windowMinutes: 300 }),
      limit("Weekly Claude/GPT limit", { windowMinutes: 10_080 }),
    ]))).toEqual([
      ["Gemini", ["Weekly Gemini limit", "5h Gemini limit"]],
      ["Claude/GPT", ["Weekly Claude/GPT limit", "5h Claude/GPT limit"]],
    ]);
  });

  it("names no scope for a single plan, and leaves out limits with no window", () => {
    const credits = limit("Credits", { windowKey: "credits", usedPercent: undefined });
    const grouped = groupRateLimitsByScope([credits, limit("5h limit"), limit("Weekly limit")]);
    expect(shape(grouped)).toEqual([[null, ["Weekly limit", "5h limit"]]]);
    expect(grouped[0]!.windows.map((entry) => entry.window.label)).toEqual(["Weekly", "5h"]);
    // A single scoped pool is still the provider's only scope.
    expect(shape(groupRateLimitsByScope([limit("Weekly Gemini limit")]))).toEqual([[null, ["Weekly Gemini limit"]]]);
    expect(groupRateLimitsByScope([credits])).toEqual([]);
  });

  it("names the plan's own limits beside a model's", () => {
    expect(shape(groupRateLimitsByScope([
      limit("5-hour limit", { windowMinutes: 300 }),
      limit("Weekly limit", { windowMinutes: 10_080 }),
      limit("Weekly Fable limit", { windowMinutes: 10_080 }),
    ]))).toEqual([
      ["All models", ["Weekly limit", "5-hour limit"]],
      ["Fable", ["Weekly Fable limit"]],
    ]);
  });
});
