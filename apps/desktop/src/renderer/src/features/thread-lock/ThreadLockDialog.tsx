import { useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { THREAD_LOCK_NOTE_MAX_LENGTH } from "@pwragent/shared";
import { useModalDialog } from "../../lib/useModalDialog";

export type ThreadLockDialogProps = {
  threadTitle: string;
  /** `lock` locks an unlocked thread; `edit` replaces a locked thread's note. */
  mode: "lock" | "edit";
  initialNote?: string;
  /** Where focus goes on close when the opener is gone, as from a menu. */
  returnFocus?: RefObject<HTMLElement | null>;
  onCancel: () => void;
  /** Rejects with a message to show in the dialog. */
  onSubmit: (note: string) => Promise<void>;
};

/**
 * Takes the note for a thread lock. Mounted only while open. The note is
 * free text, so Enter adds a line and ⌘Enter (Ctrl+Enter) submits. Portalled
 * to the body: the thread view opens it from inside its dimmed layout.
 */
export function ThreadLockDialog(props: ThreadLockDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState(props.initialNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useModalDialog<HTMLElement>({
    // A lock in flight cannot be called back, so the dialog waits for it.
    onClose: () => {
      if (!busy) props.onCancel();
    },
    initialFocus: noteRef,
    ...(props.returnFocus ? { returnFocus: props.returnFocus } : {}),
  });
  const locking = props.mode === "lock";

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onSubmit(note);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="rename-thread-backdrop" role="presentation">
      <section
        ref={dialogRef}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="rename-thread-dialog thread-lock-dialog"
        role="dialog"
      >
        <h2 id={titleId}>{locking ? "Lock Thread" : "Edit Lock Note"}</h2>
        <p id={descriptionId} className="thread-lock-dialog__lede">
          {locking
            ? `“${props.threadTitle}” stops taking new turns until it is unlocked.`
            : `The note on “${props.threadTitle}”.`}
        </p>
        <label className="rename-thread-dialog__field">
          <span>Note</span>
          <textarea
            ref={noteRef}
            maxLength={THREAD_LOCK_NOTE_MAX_LENGTH}
            placeholder="Why it is locked"
            rows={3}
            value={note}
            onChange={(event) => {
              setNote(event.currentTarget.value);
              setError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </label>
        <p className="thread-lock-dialog__hint">Shown on the thread and in the sidebar.</p>
        {locking ? (
          <div className="thread-lock-dialog__blocks">
            <p>While locked</p>
            <ul>
              <li>Composer sends and steers</li>
              <li>Queued messages</li>
              <li>CI auto-repair and PR auto-fix</li>
              <li>Messaging and peer turns</li>
              <li>Scheduled messages</li>
              <li>Agent tools that send here</li>
            </ul>
          </div>
        ) : null}
        {error ? (
          <p className="rename-thread-dialog__error" role="alert">{error}</p>
        ) : null}
        <div className="rename-thread-dialog__actions">
          <button
            className="button button--secondary"
            disabled={busy}
            type="button"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            className="button button--primary"
            disabled={busy}
            type="button"
            onClick={() => void submit()}
          >
            {locking ? "Lock Thread" : "Save Note"}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
