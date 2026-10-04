import { useState, type ReactNode } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import { TranscriptCopyButton } from "../thread-detail/TranscriptCopyButton";
import { summarizeComposerError } from "./composer-error-message";
import { useTurnFailureDismissed } from "../notifications/LinkedTurnFailureMessage";
import { turnFailureAcknowledgements } from "../notifications/turn-failure-acknowledgements";

export type ComposerErrorEntry = {
  /** Stable per source, so dismissing one error never hides another. */
  id: string;
  /** What failed, in the operator's terms. */
  label: string;
  message: string | undefined;
  /** Changes on every report, so an identical repeat is a new error to dismiss. */
  occurrence?: number;
  retry?: { label: string; onClick: () => void };
  dismissible?: boolean;
};

/**
 * Failures of composer actions, in the band above the input beside the
 * environment-action rows. They used to be paragraphs under the composer's own
 * chips, which grew the composer, could not be dismissed or copied, and printed
 * the raw IPC message. Dismissal is per message: a source that reports again
 * with a different message, or clears and fails again, shows again.
 */
export function ComposerErrorRail(props: {
  desktopApi?: Pick<DesktopApi, "copyText">;
  entries: readonly ComposerErrorEntry[];
  failureScope?: string;
}): ReactNode {
  const visible = props.entries.filter(
    (entry): entry is ComposerErrorEntry & { message: string } =>
      Boolean(entry.message),
  );
  if (visible.length === 0) return null;

  return (
    <div className="composer-error-rail">
      {visible.map((entry) => (
        // A new thread, message, or occurrence owns fresh dismissal state.
        // Clearing a source unmounts its row without an effect-driven update.
        <ComposerErrorRow
          key={JSON.stringify([props.failureScope, entry.id, dismissalKey(entry)])}
          desktopApi={props.desktopApi}
          failureScope={props.failureScope}
          label={entry.label}
          message={entry.message}
          retry={entry.retry}
          dismissible={entry.dismissible}
        />
      ))}
    </div>
  );
}

function dismissalKey(entry: ComposerErrorEntry): string {
  return JSON.stringify([entry.occurrence ?? 0, entry.message]);
}

function ComposerErrorRow(props: {
  failureScope?: string;
  desktopApi?: Pick<DesktopApi, "copyText">;
  label: string;
  message: string;
  retry?: ComposerErrorEntry["retry"];
  dismissible?: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const failureDismissed = useTurnFailureDismissed(props.failureScope, props.message);
  const { summary, detail } = summarizeComposerError(props.message);
  if (dismissed || failureDismissed) return null;
  const toggleContent = (
    <>
      <span
        className="composer__queued-env-action-chevron"
        aria-hidden="true"
        data-inert={detail ? undefined : "true"}
      />
      <span className="composer__queued-env-action-summary-text">
        <span className="composer__queued-label">{props.label}</span>
        <span className="composer__queued-text">{summary}</span>
      </span>
    </>
  );
  // Not a <details>: Copy and Dismiss beside the disclosure would sit inside
  // its <summary>, which axe rejects as nested interactive controls.
  return (
    <div
      className="composer__queued composer__queued--env-action composer__queued--env-action-failed composer-error-row"
      data-open={open ? "true" : undefined}
      aria-label={props.label}
      role="alert"
    >
      <div className="composer-error-row__header">
        {detail ? (
          <button
            aria-expanded={open}
            className="composer__queued-env-action-summary composer-error-row__toggle"
            type="button"
            onClick={() => setOpen((current) => !current)}
          >
            {toggleContent}
          </button>
        ) : (
          <div className="composer__queued-env-action-summary composer-error-row__toggle">
            {toggleContent}
          </div>
        )}
        <span className="composer__queued-env-action-actions">
          {props.retry ? (
            <button
              className="composer__secondary-action"
              type="button"
              onClick={props.retry.onClick}
            >
              {props.retry.label}
            </button>
          ) : null}
          <TranscriptCopyButton
            className="transcript-copy-button--composer-error"
            copiedLabel="Copied error"
            desktopApi={props.desktopApi}
            label={`Copy error: ${props.label}`}
            text={props.message}
          />
          {props.dismissible !== false ? (
            <button
              className="composer__secondary-action composer__queued-env-action-dismiss"
              type="button"
              onClick={() => {
                turnFailureAcknowledgements.dismissMatching(props.failureScope, props.message);
                setDismissed(true);
              }}
            >
              Dismiss
            </button>
          ) : null}
        </span>
      </div>
      {detail && open ? (
        <div className="composer__queued-env-action-body">
          <pre className="composer__queued-env-action-output composer-error-row__detail">
            {detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
