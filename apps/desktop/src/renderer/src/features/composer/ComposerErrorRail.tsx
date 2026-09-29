import { useEffect, useState, type ReactNode } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import { TranscriptCopyButton } from "../thread-detail/TranscriptCopyButton";
import { summarizeComposerError } from "./composer-error-message";

export type ComposerErrorEntry = {
  /** Stable per source, so dismissing one error never hides another. */
  id: string;
  /** What failed, in the operator's terms. */
  label: string;
  message: string | undefined;
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
}): ReactNode {
  const [dismissed, setDismissed] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    setDismissed((current) => {
      const next = new Map(current);
      for (const [id, message] of current) {
        if (props.entries.find((entry) => entry.id === id)?.message !== message) {
          next.delete(id);
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [props.entries]);

  const visible = props.entries.filter(
    (entry): entry is ComposerErrorEntry & { message: string } =>
      Boolean(entry.message) && dismissed.get(entry.id) !== entry.message,
  );
  if (visible.length === 0) return null;

  return (
    <div className="composer-error-rail">
      {visible.map((entry) => (
        <ComposerErrorRow
          key={entry.id}
          desktopApi={props.desktopApi}
          label={entry.label}
          message={entry.message}
          onDismiss={() => {
            setDismissed((current) => new Map(current).set(entry.id, entry.message));
          }}
        />
      ))}
    </div>
  );
}

function ComposerErrorRow(props: {
  desktopApi?: Pick<DesktopApi, "copyText">;
  label: string;
  message: string;
  onDismiss: () => void;
}) {
  const { summary, detail } = summarizeComposerError(props.message);
  return (
    <details
      className="composer__queued composer__queued--env-action composer__queued--env-action-failed composer-error-row"
      aria-label={props.label}
      role="alert"
    >
      <summary
        className="composer__queued-env-action-summary"
        // Nothing to open: keep the row a plain one-liner.
        onClick={detail ? undefined : (event) => event.preventDefault()}
      >
        <span
          className="composer__queued-env-action-chevron"
          aria-hidden="true"
          data-inert={detail ? undefined : "true"}
        />
        <span className="composer__queued-env-action-summary-text">
          <span className="composer__queued-label">{props.label}</span>
          <span className="composer__queued-text">{summary}</span>
        </span>
        <span
          className="composer__queued-env-action-actions"
          // Buttons inside a <summary> would otherwise also toggle the row.
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <TranscriptCopyButton
            className="transcript-copy-button--composer-error"
            copiedLabel="Copied error"
            desktopApi={props.desktopApi}
            label={`Copy error: ${props.label}`}
            text={props.message}
          />
          <button
            className="composer__secondary-action composer__queued-env-action-dismiss"
            type="button"
            onClick={() => props.onDismiss()}
          >
            Dismiss
          </button>
        </span>
      </summary>
      {detail ? (
        <div className="composer__queued-env-action-body">
          <pre className="composer__queued-env-action-output composer-error-row__detail">
            {detail}
          </pre>
        </div>
      ) : null}
    </details>
  );
}
