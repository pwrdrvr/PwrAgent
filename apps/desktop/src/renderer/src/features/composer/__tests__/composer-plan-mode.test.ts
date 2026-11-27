import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planModeForSend, withPlanMode, type ComposerSendRoute } from "../composer-plan-mode";

const ROUTES: readonly ComposerSendRoute[] = ["turn", "scheduled", "local-queue", "steer"];

// Every route with Plan on and off: the space is small enough to check whole.
const CASES = ROUTES.flatMap((route) => [true, false].map((planOn) => [route, planOn] as const));

describe("planModeForSend", () => {
  // The rule the composer once broke: a queued, scheduled or steered send
  // left the toggle on, so Plan planned the next, unrelated message.
  it.each(CASES)("never leaves Plan lit after a %s send (Plan on: %s)", (route, planOn) => {
    const plan = planModeForSend(route, planOn);
    if (!planOn) {
      expect(plan).toEqual({ clearPlan: false, notApplied: false });
      return;
    }
    expect(plan.clearPlan).toBe(true);
    // Any new turn the send starts, a steer's fallback included, plans.
    expect(plan.collaborationMode?.mode).toBe("plan");
    // Only a steer joins a turn whose mode is already set, and says so.
    expect(plan.notApplied).toBe(route === "steer");
  });
});

describe("withPlanMode", () => {
  it("changes only the scope it is given", () => {
    // Model: one boolean per scope. A single shared slot lost thread A's Plan
    // when Plan was turned on in thread B, and a late failure in A turned B's
    // off. Counterexample: [["a", true], ["b", true]] left only "b" on.
    const scope = fc.constantFrom("a", "b", "c");
    fc.assert(
      fc.property(fc.array(fc.tuple(scope, fc.boolean()), { maxLength: 12 }), (steps) => {
        let scopes: ReadonlySet<string> = new Set();
        const model = new Map<string, boolean>();
        for (const [key, on] of steps) {
          const before = scopes;
          scopes = withPlanMode(scopes, key, on);
          model.set(key, on);
          if (before.has(key) === on) expect(scopes).toBe(before);
          for (const other of ["a", "b", "c"]) {
            expect(scopes.has(other)).toBe(model.get(other) ?? false);
          }
        }
      }),
    );
  });
});
