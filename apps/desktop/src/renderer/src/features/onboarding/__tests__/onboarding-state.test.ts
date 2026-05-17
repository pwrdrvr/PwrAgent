import { describe, expect, test } from "vitest";
import {
  advanceOnboardingStep,
  createOnboardingMachineState,
  getCurrentOnboardingStep,
  skipRestOfOnboarding,
} from "../onboarding-state";

describe("onboarding state machine", () => {
  test("progresses through the placeholder steps before completing", () => {
    const first = createOnboardingMachineState();
    expect(getCurrentOnboardingStep(first).id).toBe("thread-presentation");
    expect(first.completed).toBe(false);

    const second = advanceOnboardingStep(first);
    expect(getCurrentOnboardingStep(second).id).toBe("codex-profile-model");
    expect(second.completed).toBe(false);

    const third = advanceOnboardingStep(second);
    expect(getCurrentOnboardingStep(third).id).toBe(
      "messaging-acknowledgment",
    );
    expect(third.completed).toBe(false);

    const completed = advanceOnboardingStep(third);
    expect(getCurrentOnboardingStep(completed).id).toBe(
      "messaging-acknowledgment",
    );
    expect(completed.completed).toBe(true);
  });

  test("skip rest of wizard completes without advancing the current step", () => {
    const state = advanceOnboardingStep(createOnboardingMachineState());
    const skipped = skipRestOfOnboarding(state);

    expect(getCurrentOnboardingStep(skipped).id).toBe("codex-profile-model");
    expect(skipped.completed).toBe(true);
    expect(skipped.skipped).toBe(true);
  });
});
