import { useId, useRef, useState } from "react";
import type { ThreadRewindMode, ThreadRewindSupport } from "@pwragent/shared";
import { useModalDialog } from "../../lib/useModalDialog";
import type { ThreadRewindSummary } from "./thread-rewind";

type ThreadRewindConfirmProps = {
  busy: boolean;
  error?: string;
  providerLabel: string;
  summary: ThreadRewindSummary;
  support: ThreadRewindSupport;
  onCancel: () => void;
  onConfirm: (mode: ThreadRewindMode) => void;
};

/**
 * Confirms a rewind to before one prompt. It opens under that prompt in the
 * transcript and says what the provider removes, and what it puts back.
 */
export function ThreadRewindConfirm(props: ThreadRewindConfirmProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [restoreFiles, setRestoreFiles] = useState(props.support.files);
  const dialogRef = useModalDialog({
    initialFocus: cancelRef,
    onClose: () => {
      if (!props.busy) props.onCancel();
    },
  });
  const later = props.summary.laterTurnCount;
  const files = props.summary.changedFileCount;
  const filesNote = props.support.files
    ? undefined
    : files === undefined
      ? `${props.providerLabel} rewinds the conversation only. Files changed since stay as they are.`
      : files === 0
        ? `${props.providerLabel} rewinds the conversation only. Files stay as they are.`
        : `${props.providerLabel} rewinds the conversation only. The ${files} ${
            files === 1 ? "file" : "files"
          } changed since stay as they are.`;
  const mode: ThreadRewindMode =
    props.support.files && restoreFiles ? "conversation-and-files" : "conversation";

  return (
    <div
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-modal="true"
      className="thread-rewind-confirm"
      role="dialog"
    >
      <h3 id={titleId}>Rewind to before this message?</h3>
      <p>
        {later === 0 ? (
          <>This message and its reply are removed</>
        ) : (
          <>
            This message and the{" "}
            <strong>
              {later} {later === 1 ? "turn" : "turns"} after it
            </strong>{" "}
            are removed
          </>
        )}{" "}
        from the {props.providerLabel} conversation. Its text returns to the
        composer so you can edit and resend it.
      </p>
      <label className="composer__checkbox thread-rewind-confirm__files">
        <input
          checked={mode === "conversation-and-files"}
          disabled={!props.support.files || props.busy}
          type="checkbox"
          onChange={(event) => setRestoreFiles(event.currentTarget.checked)}
        />
        <span>
          Restore files
          {filesNote ? <small>{filesNote}</small> : null}
        </span>
      </label>
      {props.support.undo ? null : (
        <p className="thread-rewind-confirm__warning">
          {props.providerLabel} does not keep the removed turns, so this rewind
          cannot be undone.
        </p>
      )}
      {props.error ? (
        <p className="thread-rewind-confirm__error" role="alert">
          {props.error}
        </p>
      ) : null}
      <div className="thread-rewind-confirm__actions">
        <button
          ref={cancelRef}
          disabled={props.busy}
          type="button"
          onClick={props.onCancel}
        >
          Cancel
        </button>
        <button
          className="thread-rewind-confirm__confirm"
          disabled={props.busy}
          type="button"
          onClick={() => props.onConfirm(mode)}
        >
          {props.busy ? "Rewinding..." : "Rewind and edit"}
        </button>
      </div>
    </div>
  );
}
