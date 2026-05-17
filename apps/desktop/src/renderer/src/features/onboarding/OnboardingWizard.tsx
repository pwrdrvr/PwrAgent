import { useMemo, useRef, useState, type ReactElement } from "react";
import type {
  DesktopOnboardingCodexProfileModel,
  DesktopOnboardingThreadPresentation,
} from "@pwragent/shared";
import {
  ONBOARDING_STEPS,
  advanceOnboardingStep,
  createOnboardingMachineState,
  getCurrentOnboardingStep,
  getOnboardingStepIndex,
  skipRestOfOnboarding,
} from "./onboarding-state";

export type OnboardingWizardMode = "auto" | "manual";

export function OnboardingWizard(props: {
  mode: OnboardingWizardMode;
  saving?: boolean;
  codexProfileModel: DesktopOnboardingCodexProfileModel;
  threadPresentation: DesktopOnboardingThreadPresentation;
  onComplete: () => Promise<void>;
  onCodexProfileModelChange: (
    value: DesktopOnboardingCodexProfileModel,
  ) => Promise<void>;
  onSkip: () => Promise<void>;
  onThreadPresentationChange: (
    value: DesktopOnboardingThreadPresentation,
  ) => Promise<void>;
}): ReactElement {
  const [state, setState] = useState(() => createOnboardingMachineState());
  const [error, setError] = useState<string>();
  const [actionBusy, setActionBusy] = useState(false);
  const currentStep = getCurrentOnboardingStep(state);
  const currentStepIndex = getOnboardingStepIndex(currentStep.id);
  const totalSteps = ONBOARDING_STEPS.length;
  const busyRef = useRef(false);
  const busy = props.saving || actionBusy;
  const primaryLabel =
    currentStepIndex === totalSteps - 1 ? "Finish onboarding" : "Continue";
  const title = useMemo(
    () => `${currentStep.label} (${currentStepIndex + 1} of ${totalSteps})`,
    [currentStep.label, currentStepIndex, totalSteps],
  );

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      busyRef.current = false;
      setActionBusy(false);
    }
  };

  const advance = async (): Promise<void> => {
    await runAction(async () => {
      const next = advanceOnboardingStep(state);
      if (next.completed) {
        await props.onComplete();
        return;
      }
      setState(next);
    });
  };

  const skip = async (): Promise<void> => {
    await runAction(async () => {
      setState((current) => skipRestOfOnboarding(current));
      await props.onSkip();
    });
  };

  const saveThreadPresentation = async (
    value: DesktopOnboardingThreadPresentation,
  ): Promise<void> => {
    await runAction(async () => {
      await props.onThreadPresentationChange(value);
    });
  };

  const saveCodexProfileModel = async (
    value: DesktopOnboardingCodexProfileModel,
  ): Promise<void> => {
    await runAction(async () => {
      await props.onCodexProfileModelChange(value);
    });
  };

  const stepContent = (() => {
    if (currentStep.id === "thread-presentation") {
      return (
        <ThreadPresentationStep
          disabled={busy}
          selected={props.threadPresentation}
          onSelect={(value) => {
            void saveThreadPresentation(value);
          }}
        />
      );
    }

    if (currentStep.id === "codex-profile-model") {
      return (
        <CodexProfileModelStep
          disabled={busy}
          selected={props.codexProfileModel}
          onSelect={(value) => {
            void saveCodexProfileModel(value);
          }}
        />
      );
    }

    return (
      <p className="onboarding-wizard__placeholder">
        {currentStep.placeholder}
      </p>
    );
  })();

  return (
    <div className="onboarding-modal" role="presentation">
      <section
        aria-labelledby="onboarding-wizard-title"
        aria-modal="true"
        className="onboarding-wizard"
        role="dialog"
      >
        <header className="onboarding-wizard__titlebar">
          <div className="onboarding-wizard__breadcrumb">
            <span className="onboarding-wizard__eyebrow">Onboarding</span>
            <span className="onboarding-wizard__separator" aria-hidden="true">
              /
            </span>
            <span className="onboarding-wizard__current">{title}</span>
          </div>
          <button
            aria-label="Close onboarding wizard"
            className="onboarding-wizard__close"
            disabled={busy}
            type="button"
            onClick={() => {
              void skip();
            }}
          >
            x
          </button>
        </header>

        <div className="onboarding-wizard__body">
          <div className="onboarding-wizard__step-kicker">
            Step {currentStepIndex + 1}
          </div>
          <h2 id="onboarding-wizard-title" className="onboarding-wizard__title">
            {currentStep.label}
          </h2>
          {stepContent}
        </div>

        <footer className="onboarding-wizard__footer">
          <button
            className="onboarding-wizard__skip"
            disabled={busy}
            type="button"
            onClick={() => {
              void skip();
            }}
          >
            Skip onboarding
          </button>
          <div className="onboarding-wizard__actions">
            <div className="onboarding-wizard__progress" aria-hidden="true">
              {ONBOARDING_STEPS.map((step) => (
                <span
                  key={step.id}
                  className={`onboarding-wizard__dot${
                    step.id === currentStep.id ? " is-active" : ""
                  }`}
                />
              ))}
            </div>
            <button
              className="button button--primary"
              disabled={busy}
              type="button"
              onClick={() => {
                void advance();
              }}
            >
              {primaryLabel}
            </button>
          </div>
        </footer>

        {error ? (
          <p className="onboarding-wizard__error" role="alert">
            {error}
          </p>
        ) : null}

        <span className="sr-only" aria-live="polite">
          {props.mode === "manual"
            ? "Replay onboarding wizard"
            : "First-launch onboarding wizard"}
        </span>
      </section>
    </div>
  );
}

const THREAD_PRESENTATION_OPTIONS: Array<{
  description: string;
  label: string;
  value: DesktopOnboardingThreadPresentation;
}> = [
  {
    description:
      "Tighter rows for scanning more threads and keeping navigation dense.",
    label: "Compact",
    value: "compact",
  },
  {
    description:
      "Roomier rows with more context for work that moves across threads.",
    label: "Mission Control",
    value: "mission_control",
  },
];

const CODEX_PROFILE_MODEL_OPTIONS: Array<{
  description: string;
  label: string;
  value: DesktopOnboardingCodexProfileModel;
}> = [
  {
    description: "One Codex login for everything.",
    label: "Shared",
    value: "shared",
  },
  {
    description: "Per-directory Codex login.",
    label: "Isolated",
    value: "isolated",
  },
  {
    description: "Different logins for different threads (advanced).",
    label: "Multiple",
    value: "multiple",
  },
];

function ThreadPresentationStep(props: {
  disabled: boolean;
  selected: DesktopOnboardingThreadPresentation;
  onSelect: (value: DesktopOnboardingThreadPresentation) => void;
}): ReactElement {
  return (
    <div
      className="onboarding-choice-grid onboarding-choice-grid--two"
      role="radiogroup"
      aria-label="Thread Presentation"
    >
      {THREAD_PRESENTATION_OPTIONS.map((option) => (
        <button
          key={option.value}
          aria-checked={props.selected === option.value}
          className={`onboarding-preview-card${
            props.selected === option.value ? " is-active" : ""
          }`}
          disabled={props.disabled}
          role="radio"
          type="button"
          onClick={() => props.onSelect(option.value)}
        >
          <span className="onboarding-preview-card__label">{option.label}</span>
          <span className="onboarding-preview-card__art" aria-hidden="true">
            <span className="onboarding-preview-card__rail" />
            <span className="onboarding-preview-card__threads">
              {Array.from({ length: option.value === "compact" ? 5 : 3 }).map(
                (_, index) => (
                  <span
                    key={index}
                    className={`onboarding-preview-card__thread onboarding-preview-card__thread--${option.value}`}
                  >
                    <span />
                    <span />
                  </span>
                ),
              )}
            </span>
          </span>
          <span className="onboarding-preview-card__description">
            {option.description}
          </span>
        </button>
      ))}
    </div>
  );
}

function CodexProfileModelStep(props: {
  disabled: boolean;
  selected: DesktopOnboardingCodexProfileModel;
  onSelect: (value: DesktopOnboardingCodexProfileModel) => void;
}): ReactElement {
  return (
    <div
      className="onboarding-choice-grid onboarding-choice-grid--three"
      role="radiogroup"
      aria-label="Codex Profile Model"
    >
      {CODEX_PROFILE_MODEL_OPTIONS.map((option) => (
        <button
          key={option.value}
          aria-checked={props.selected === option.value}
          className={`onboarding-radio-card${
            props.selected === option.value ? " is-active" : ""
          }`}
          disabled={props.disabled}
          role="radio"
          type="button"
          onClick={() => props.onSelect(option.value)}
        >
          <span className="onboarding-radio-card__marker" aria-hidden="true" />
          <span className="onboarding-radio-card__content">
            <span className="onboarding-radio-card__label">{option.label}</span>
            <span className="onboarding-radio-card__description">
              {option.description}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
