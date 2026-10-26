import { useId, useRef, useState } from "react";
import type {
  PreviewThreadRewindResponse,
  ThreadRewindMode,
  ThreadRewindSupport,
} from "@pwragent/shared";
import { useModalDialog } from "../../lib/useModalDialog";
import type { ThreadRewindSummary } from "./thread-rewind";

/**
 * A provider that restores files previews which ones before the operator
 * confirms; `loading` until that dry run answers.
 */
export type ThreadRewindPreview =
  | { status: "loading" }
  | ({ status: "ready" } & Pick<
      PreviewThreadRewindResponse,
      "files" | "filesUnavailableReason" | "unavailableReason"
    >);

const LISTED_FILE_LIMIT = 4;

type ThreadRewindConfirmProps = {
  busy: boolean;
  error?: string;
  preview?: ThreadRewindPreview;
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
  const [restoreFiles, setRestoreFiles] = useState(true);
  const dialogRef = useModalDialog({
    initialFocus: cancelRef,
    onClose: () => {
      if (!props.busy) props.onCancel();
    },
  });
  const later = props.summary.laterTurnCount;
  const files = props.summary.changedFileCount;
  const ready = props.preview?.status === "ready" ? props.preview : undefined;
  const restorable = props.support.files && !ready?.unavailableReason ? ready?.files : undefined;
  const canRestoreFiles = Boolean(restorable && restorable.paths.length > 0);
  const filesNote = props.support.files
    ? props.preview?.status === "loading"
      ? `Checking which files ${props.providerLabel} can restore...`
      : ready?.filesUnavailableReason
        ?? (restorable
          ? restorable.paths.length === 0
            ? `${props.providerLabel} has changed no files since this prompt.`
            : `Restores ${restorable.paths.length} ${
                restorable.paths.length === 1 ? "file" : "files"
              } ${props.providerLabel} changed since this prompt (+${restorable.insertions} \u2212${
                restorable.deletions
              }). Changes made by shell commands are not restored.`
          : ready?.unavailableReason
            ? undefined
            : `PwrAgent could not check which files ${props.providerLabel} can restore.`)
    : files === undefined
      ? `${props.providerLabel} rewinds the conversation only. Files changed since stay as they are.`
      : files === 0
        ? `${props.providerLabel} rewinds the conversation only. Files stay as they are.`
        : `${props.providerLabel} rewinds the conversation only. The ${files} ${
            files === 1 ? "file" : "files"
          } changed since stay as they are.`;
  const mode: ThreadRewindMode =
    canRestoreFiles && restoreFiles ? "conversation-and-files" : "conversation";
  const blocked = Boolean(ready?.unavailableReason) || props.preview?.status === "loading";

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
          disabled={!canRestoreFiles || props.busy}
          type="checkbox"
          onChange={(event) => setRestoreFiles(event.currentTarget.checked)}
        />
        <span>
          Restore files
          {filesNote ? <small>{filesNote}</small> : null}
          {canRestoreFiles && restorable ? (
            <small className="thread-rewind-confirm__file-list">
              {restorable.paths.slice(0, LISTED_FILE_LIMIT).map((filePath) => (
                <span key={filePath}>{filePath}</span>
              ))}
              {restorable.paths.length > LISTED_FILE_LIMIT ? (
                <span>and {restorable.paths.length - LISTED_FILE_LIMIT} more</span>
              ) : null}
            </small>
          ) : null}
        </span>
      </label>
      {props.support.undo ? null : (
        <p className="thread-rewind-confirm__warning">
          This rewind cannot be undone.
        </p>
      )}
      {props.error ?? ready?.unavailableReason ? (
        <p className="thread-rewind-confirm__error" role="alert">
          {props.error ?? ready?.unavailableReason}
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
          disabled={props.busy || blocked}
          type="button"
          onClick={() => props.onConfirm(mode)}
        >
          {props.busy ? "Rewinding..." : "Rewind and edit"}
        </button>
      </div>
    </div>
  );
}
