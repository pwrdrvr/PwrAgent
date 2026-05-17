export const ONBOARDING_STEPS = [
  {
    id: "thread-presentation",
    label: "Thread Presentation",
    placeholder: "Step 1 — coming in Phase 2",
  },
  {
    id: "codex-profile-model",
    label: "Codex Profile Model",
    placeholder: "Step 2 — coming in Phase 3",
  },
  {
    id: "messaging-acknowledgment",
    label: "Messaging acknowledgment",
    placeholder: "Step 3 — coming in Phase 4",
  },
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStepId = OnboardingStep["id"];

export type OnboardingMachineState = {
  completed: boolean;
  currentStepId: OnboardingStepId;
  skipped: boolean;
};

export function createOnboardingMachineState(): OnboardingMachineState {
  return {
    completed: false,
    currentStepId: ONBOARDING_STEPS[0].id,
    skipped: false,
  };
}

export function getCurrentOnboardingStep(
  state: OnboardingMachineState,
): OnboardingStep {
  return (
    ONBOARDING_STEPS.find((step) => step.id === state.currentStepId) ??
    ONBOARDING_STEPS[0]
  );
}

export function getOnboardingStepIndex(stepId: OnboardingStepId): number {
  return ONBOARDING_STEPS.findIndex((step) => step.id === stepId);
}

export function advanceOnboardingStep(
  state: OnboardingMachineState,
): OnboardingMachineState {
  if (state.completed) {
    return state;
  }

  const currentIndex = getOnboardingStepIndex(state.currentStepId);
  const nextStep = ONBOARDING_STEPS[currentIndex + 1];
  if (!nextStep) {
    return {
      ...state,
      completed: true,
    };
  }

  return {
    ...state,
    currentStepId: nextStep.id,
  };
}

export function skipRestOfOnboarding(
  state: OnboardingMachineState,
): OnboardingMachineState {
  return {
    ...state,
    completed: true,
    skipped: true,
  };
}
