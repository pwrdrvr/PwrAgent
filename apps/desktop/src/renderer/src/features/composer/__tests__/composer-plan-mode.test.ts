import { describe, expect, it } from "vitest";
import { planModeForSend, type ComposerSendRoute } from "../composer-plan-mode";

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
    // Exactly one of: it carried Plan, or it says Plan was not applied.
    expect(Boolean(plan.collaborationMode)).toBe(!plan.notApplied);
    // A steer joins a running turn, whose mode is already set.
    expect(plan.notApplied).toBe(route === "steer");
    if (plan.collaborationMode) expect(plan.collaborationMode.mode).toBe("plan");
  });
});
