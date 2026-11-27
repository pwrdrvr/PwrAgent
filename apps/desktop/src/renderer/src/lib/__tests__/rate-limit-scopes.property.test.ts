import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BackendRateLimitSummary } from "../backend-status-format";
import { groupRateLimitsByScope, rateLimitWindowAndScope } from "../rate-limit-scopes";

const WINDOWS = [
  { word: "5h", minutes: 300 },
  { word: "Weekly", minutes: 10_080 },
  { word: "Daily", minutes: 1440 },
] as const;
const SCOPES = [undefined, "Gemini", "Claude/GPT", "Fable"] as const;

// Limits as the providers name them: "<window>[ <scope>] limit", sometimes
// with the window's length too, mixed with balances that have no window.
const windowed: fc.Arbitrary<BackendRateLimitSummary> = fc.record({
  window: fc.constantFrom(...WINDOWS),
  scope: fc.constantFrom(...SCOPES),
  structured: fc.boolean(),
  usedPercent: fc.integer({ min: 0, max: 100 }),
}).map(({ window, scope, structured, usedPercent }) => ({
  name: `${window.word}${scope ? ` ${scope}` : ""} limit`,
  usedPercent,
  ...(structured ? { windowMinutes: window.minutes } : {}),
}));
const balance: fc.Arbitrary<BackendRateLimitSummary> = fc.constantFrom(
  { name: "Credits", windowKey: "credits" as const },
  { name: "Individual limit", usedPercent: 40 },
);
const limits = fc.array(fc.oneof({ weight: 4, arbitrary: windowed }, { weight: 1, arbitrary: balance }), {
  maxLength: 12,
  size: "max",
});

const scopeKey = (limit: BackendRateLimitSummary) => rateLimitWindowAndScope(limit)?.scope?.toLowerCase() ?? "";

describe("groupRateLimitsByScope", () => {
  it("puts every windowed limit in exactly one scope, in the provider's order", () => {
    fc.assert(fc.property(limits, (input) => {
      const groups = groupRateLimitsByScope(input);
      const grouped = groups.flatMap((group) => group.windows.map((entry) => entry.limit));
      const windowedInput = input.filter((limit) => rateLimitWindowAndScope(limit) !== undefined);
      // Each windowed limit once; balances never.
      expect(new Set(grouped).size).toBe(grouped.length);
      expect([...grouped].sort((a, b) => input.indexOf(a) - input.indexOf(b))).toEqual(windowedInput);
      // Scopes in the order their first limit arrived.
      const firstSeen = [...new Set(windowedInput.map(scopeKey))];
      expect(groups.map((group) => scopeKey(group.windows[0]!.limit))).toEqual(firstSeen);
      for (const group of groups) {
        // One scope per group, its windows longest first.
        expect(new Set(group.windows.map((entry) => scopeKey(entry.limit))).size).toBe(1);
        const minutes = group.windows.map((entry) => entry.window.minutes ?? -1);
        expect(minutes).toEqual([...minutes].sort((a, b) => b - a));
        // Named only beside another scope.
        expect(group.scope === null).toBe(groups.length === 1);
      }
    }));
  });
});
