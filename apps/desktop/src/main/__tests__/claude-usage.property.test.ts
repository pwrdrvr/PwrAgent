import { expect, it } from "vitest";
import fc from "fast-check";
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { claudeRateLimits, claudeStreamRateLimits } from "../claude/claude-usage";

// A provider allowance has two wire descriptions. Neither parser's output
// supplies the expected name: the other production parser is the oracle.
const allowance = fc.record({
  key: fc.constantFrom("model_scoped:Fable", "five_hour", "seven_day", "seven_day_opus",
    "seven_day_sonnet", "seven_day_oauth_apps", "overage", "iguana_necktie", "future_plan_limit"),
  percent: fc.integer({ min: 0, max: 200 }),
  reset: fc.option(fc.integer({ min: 1_700_000_000, max: 2_000_000_000 }), { nil: undefined }),
});
type Allowance = { key: string; percent: number; reset: number | undefined };

function comparePaths(allowances: Allowance[]) {
  const snapshot: Record<string, unknown> = {};
  const stream: Record<string, unknown> = {};
  for (const { key, percent, reset } of allowances) {
    const value = { utilization: percent, resets_at: reset === undefined ? null : new Date(reset * 1000).toISOString() };
    if (key === "model_scoped:Fable") {
      snapshot.model_scoped = [{ display_name: "Fable", ...value }];
    } else {
      snapshot[key] = value;
    }
    stream[key === "model_scoped:Fable" ? "seven_day_overage_included" : key] = {
      utilization: percent / 100, resetsAt: reset,
    };
  }
  const fromSnapshot = claudeRateLimits({ rate_limits_available: true, rate_limits: snapshot } as unknown as SDKControlGetUsageResponse);
  const fromStream = claudeStreamRateLimits({ status: "allowed", unifiedWindows: stream } as SDKRateLimitInfo);
  const identities = (limits: typeof fromSnapshot) => limits.map(({ limitId, name }) => ({ limitId, name }))
    .sort((a, b) => a.limitId!.localeCompare(b.limitId!));
  expect(fromSnapshot).toHaveLength(allowances.length);
  expect(fromStream).toHaveLength(allowances.length);
  expect(identities(fromSnapshot)).toEqual(identities(fromStream));
}

it("names every shared allowance identically in snapshots and streamed updates", () => {
  // #3117: one Fable allowance must occupy one Pricing rail identity,
  // independently of utilization, reset time, other windows or wire order.
  fc.assert(fc.property(fc.uniqueArray(allowance, {
    minLength: 1, maxLength: 9, selector: (entry) => entry.key,
  }), comparePaths));
});

it.each([
  { key: "model_scoped:Fable", percent: 0, reset: undefined },
])("keeps the shrunk Fable alias regression canonical ($percent percent)", (entry) => {
  comparePaths([entry]);
});
