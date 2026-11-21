import { useEffect, useRef, type ReactNode } from "react";
import { useModalDialog } from "../../../lib/useModalDialog";
import { CloseIcon } from "./guided-setup-icons";

export type GuidedRailStep = {
  /** Shown under the step number; a finished step may show its outcome. */
  label: string;
};

/**
 * The frame every guided flow renders in: a modal card over Settings with
 * the step rail across the top, one task in the body, and Back / Continue in
 * the footer. Escape and the close button leave the flow; whatever a step
 * already saved stays saved.
 */
export function GuidedSetupFrame(props: {
  /** Names the dialog for assistive technology, e.g. "Set up messaging". */
  title: string;
  /** Breadcrumb after "Settings", e.g. "Messaging — Telegram". */
  crumb: string;
  steps: readonly GuidedRailStep[];
  /** Index of the current step in `steps`. */
  currentIndex: number;
  /** Refuse to close while a step is mid-write. */
  busy?: boolean;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
  /** Changes when the body shows a different step, so focus can move to it. */
  stepKey: string;
}) {
  const dialogRef = useModalDialog({
    onClose: () => {
      if (!props.busy) props.onClose();
    },
    initialFocus: "dialog",
  });
  const bodyRef = useRef<HTMLDivElement>(null);
  // A new step replaces the body. Move focus to it, so keyboard and screen
  // reader users start at the step's heading rather than on a footer button
  // whose meaning just changed.
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    bodyRef.current?.focus();
  }, [props.stepKey]);

  return (
    <div
      ref={dialogRef}
      className="guided-setup-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      tabIndex={-1}
    >
      <div className="guided-setup-overlay__scrim" />
      <div className="guided-setup">
        <header className="guided-setup__titlebar">
          <span className="guided-setup__eyebrow">Settings</span>
          <span className="guided-setup__sep">/</span>
          <span className="guided-setup__crumb">{props.crumb}</span>
          <span className="guided-setup__spacer" />
          <button
            type="button"
            className="guided-setup__close"
            aria-label={`Close ${props.title.toLowerCase()}`}
            disabled={props.busy}
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </header>
        <nav className="guided-setup__rail" aria-label="Setup progress">
          {props.steps.map((step, idx) => {
            const state =
              idx < props.currentIndex
                ? "done"
                : idx === props.currentIndex
                  ? "current"
                  : "pending";
            return (
              <div
                key={idx}
                className={`guided-setup__rail-step is-${state}`}
                aria-current={state === "current" ? "step" : undefined}
              >
                <div className="guided-setup__rail-num">
                  {state === "done" ? `Step ${idx + 1} ✓` : `Step ${idx + 1}`}
                </div>
                <div className="guided-setup__rail-label">{step.label}</div>
              </div>
            );
          })}
        </nav>
        <div
          ref={bodyRef}
          className="guided-setup__body"
          tabIndex={-1}
          data-step={props.stepKey}
        >
          {props.children}
        </div>
        <footer className="guided-setup__footer">{props.footer}</footer>
      </div>
    </div>
  );
}

export function GuidedFooterBack(props: { onBack: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="guided-setup__btn guided-setup__btn--ghost"
      disabled={props.disabled}
      onClick={props.onBack}
    >
      ← Back
    </button>
  );
}

export function GuidedFooterSpacer() {
  return <span className="guided-setup__spacer" />;
}

export function GuidedFooterHint(props: { children: ReactNode }) {
  return <span className="guided-setup__hint">{props.children}</span>;
}
