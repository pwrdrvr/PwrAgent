import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  landWithoutBackend,
  type StartupLandingState,
} from "../provider-startup-notice";

/**
 * A model of App's startup landing: the effect evaluates on every change of
 * thread selection or backend availability, and the notice's own exits
 * (dismiss, Open AI Providers, Run setup) return the decision to `pending`.
 * Only the no-backend step is `landWithoutBackend`; the rest mirrors App.
 */
type Step =
  | { kind: "evaluate"; threadSelected: boolean; backendUsable: boolean }
  | { kind: "dismiss" };

type World = { state: StartupLandingState; noticeVisible: boolean };

function apply(world: World, step: Step): World {
  if (step.kind === "dismiss") {
    return world.noticeVisible ? { state: "pending", noticeVisible: false } : world;
  }
  if (world.state === "complete") return world;
  if (step.backendUsable) return { state: "complete", noticeVisible: false };
  const landing = landWithoutBackend(world.state, step.threadSelected);
  return {
    state: landing.state,
    noticeVisible: world.noticeVisible || landing.showNotice,
  };
}

const stepArbitrary: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("evaluate" as const),
    threadSelected: fc.boolean(),
    backendUsable: fc.boolean(),
  }),
  fc.constant({ kind: "dismiss" as const }),
);

describe("startup landing without a usable backend", () => {
  it("puts the notice up whenever a selected thread covers the setup pane, and never over the empty pane", () => {
    fc.assert(
      fc.property(fc.array(stepArbitrary, { maxLength: 30 }), (steps) => {
        let world: World = { state: "pending", noticeVisible: false };
        for (const step of steps) {
          const before = world;
          world = apply(world, step);
          if (step.kind !== "evaluate" || before.state === "complete") continue;
          if (step.backendUsable) {
            // A provider answered: the landing is over for good.
            expect(world).toEqual({ state: "complete", noticeVisible: false });
          } else if (step.threadSelected) {
            // The setup pane is covered, so the problem must be on screen.
            expect(world.noticeVisible).toBe(true);
          } else if (!before.noticeVisible) {
            // The empty pane is the agent setup; no toast repeats it.
            expect(world.noticeVisible).toBe(false);
          }
        }
      }),
    );
  });

  it("shows the notice for a thread selected after landing on the setup pane", () => {
    const pane = landWithoutBackend("pending", false);
    expect(pane).toEqual({ state: "pane-shown", showNotice: false });
    expect(landWithoutBackend(pane.state, true)).toEqual({ state: "notice-shown", showNotice: true });
  });
});
