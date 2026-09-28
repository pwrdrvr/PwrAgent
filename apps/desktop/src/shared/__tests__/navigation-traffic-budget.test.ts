import { expect, it } from "vitest";
import type { NavigationQueryRequest } from "@pwragent/shared";
import { navigationRequestByteBudget } from "./navigation-traffic-budget";

it("charges diagnostic counters at their full wire width and retains all other metadata", () => {
  const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" },
    diagnostic: { origin: "68ca84ce-8d32-4230-a10f-76bc96eb2f33", view: 1, effect: 1, logical: 9, attempt: 1, invalidations: 0, cause: "refresh" } };
  const initial = JSON.stringify(request);
  const budget = navigationRequestByteBudget(request);
  for (const value of [1, 9, 10, 1000, Number.MAX_SAFE_INTEGER]) {
    const next = { ...request, diagnostic: { ...request.diagnostic!, view: value, effect: value, logical: value, attempt: value, invalidations: value } };
    expect(navigationRequestByteBudget(next)).toEqual(budget);
    expect(new TextEncoder().encode(JSON.stringify(next)).byteLength).toBeLessThanOrEqual(budget.requestBytes);
  }
  const without = navigationRequestByteBudget({ ...request, diagnostic: undefined });
  expect(without.diagnosticBytes).toBe(0);
  expect(budget.requestBytes - without.requestBytes).toBe(budget.diagnosticBytes);
  expect(budget.diagnosticBytes).toBeGreaterThan(0);
  const withTrigger = navigationRequestByteBudget({ ...request, diagnostic: { ...request.diagnostic!, trigger: "turn/completed" } });
  expect(withTrigger.requestBytes - budget.requestBytes).toBe(JSON.stringify({ trigger: "turn/completed" }).length - 1);
  expect(JSON.stringify(request)).toBe(initial);
});
