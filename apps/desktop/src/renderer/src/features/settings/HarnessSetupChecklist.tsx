import type { ReactNode } from "react";
import { acpRelativeTime } from "./acp-agent-copy";
import {
  currentSetupStep,
  HARNESS_SETUP_STEP_TITLES,
  type HarnessSetupStatus,
  type HarnessSetupStepId,
  type HarnessSetupStepState,
} from "./harness-setup-status";
import { SettingsSection } from "./SettingsLayout";
import "./harness-setup.css";

const STATE_MARK: Partial<Record<HarnessSetupStepState, string>> = {
  done: "✓",
  attention: "!",
  working: "…",
};

/**
 * The Setup section at the top of a harness's Settings screen: Runtime,
 * Account, Ready for new threads, in that order (Turn on first for an ACP
 * agent that is off). Each step says what PwrAgent knows; only the current
 * step carries controls, and a finished step offers Change, which takes the
 * operator to the field below that manages it. It renders `status` and the
 * controls it is handed; it starts no check of its own.
 */
export function HarnessSetupChecklist(props: {
  providerName: string;
  status: HarnessSetupStatus;
  /** Controls for a step while it is current: its button, command, note. */
  controls?: Partial<Record<HarnessSetupStepId, ReactNode>>;
  /** Change, offered on a finished step. */
  onChange?: Partial<Record<HarnessSetupStepId, () => void>>;
  /** When PwrAgent last checked this provider, if it knows. */
  checkedAt?: number;
  /** The screen's one recheck. Hidden while the current step offers it. */
  onCheck?: () => void;
  /** The current step's controls include the recheck. Defaults to a step
   *  whose action is the check itself. */
  checkInStep?: boolean;
  checking?: boolean;
  /** Something else on the screen is running; the recheck waits for it. */
  busy?: boolean;
  checkError?: string;
  now?: number;
}) {
  const { status } = props;
  const current = currentSetupStep(status.steps);
  const currentOffersCheck = props.checkInStep ?? current?.action === "check";
  const checkedText = props.checking
    ? "Checking now…"
    : props.checkedAt !== undefined
      ? `Checked ${acpRelativeTime(props.checkedAt, props.now)}`
      : undefined;
  return (
    <SettingsSection
      title="Setup"
      sectionId="setup"
      description="Runtime, then account, then ready for new threads."
      chip={status.label}
      chipKind={status.tone}
    >
      <ol
        className="harness-setup"
        aria-label={`${props.providerName} setup steps`}
      >
        {status.steps.map((step, index) => {
          const isCurrent = step === current;
          const controls = isCurrent ? props.controls?.[step.id] : undefined;
          const onChange = step.state === "done" ? props.onChange?.[step.id] : undefined;
          const title = HARNESS_SETUP_STEP_TITLES[step.id];
          return (
            <li
              key={step.id}
              className={`harness-setup__step harness-setup__step--${step.state}`}
              aria-current={isCurrent ? "step" : undefined}
              data-step={step.id}
            >
              <span className="harness-setup__mark" aria-hidden="true">
                {STATE_MARK[step.state] ?? String(index + 1)}
              </span>
              <div className="harness-setup__body">
                <p className="harness-setup__title">
                  <span>{index + 1}. {title}</span>
                  <span className="harness-setup__state">{step.label}</span>
                </p>
                {step.facts?.length ? (
                  <ul className="harness-setup__facts" aria-label={`${title} details`}>
                    {step.facts.map((fact) => <li key={fact}>{fact}</li>)}
                  </ul>
                ) : null}
                {step.detail && (isCurrent || step.state === "attention") ? (
                  <p className="harness-setup__detail">{step.detail}</p>
                ) : null}
                {controls ? (
                  <div className="harness-setup__controls">{controls}</div>
                ) : null}
              </div>
              {onChange ? (
                <button
                  type="button"
                  className="button button--ghost harness-setup__change"
                  aria-label={`Change ${title.toLowerCase()}`}
                  onClick={onChange}
                >
                  Change
                </button>
              ) : <span />}
            </li>
          );
        })}
      </ol>
      {checkedText || (props.onCheck && !currentOffersCheck) || props.checkError ? (
        <div className="harness-setup__foot">
          <span className="harness-setup__checked" aria-live="polite">{checkedText}</span>
          {props.checkError ? (
            <span className="settings-row__error" role="alert">{props.checkError}</span>
          ) : null}
          {props.onCheck && !currentOffersCheck ? (
            <button
              type="button"
              className="button button--secondary"
              disabled={props.checking || props.busy}
              onClick={props.onCheck}
            >
              {props.checking ? "Checking…" : "Check again"}
            </button>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  );
}

/** Bring a field into view and put focus in it, for a step's Change. */
export function revealSettingsField(id: string): void {
  const element = document.getElementById(id);
  if (!element) return;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  const focusable = element.matches("input, button, select, textarea, [tabindex]")
    ? element
    : element.querySelector<HTMLElement>("input, button, select, textarea, [tabindex]");
  focusable?.focus({ preventScroll: true });
}
