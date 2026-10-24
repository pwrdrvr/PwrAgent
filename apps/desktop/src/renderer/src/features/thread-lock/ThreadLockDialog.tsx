import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { THREAD_LOCK_NOTE_MAX_LENGTH } from "@pwragent/shared";
import { getDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { useModalDialog } from "../../lib/useModalDialog";

type RecentNotesApi = Pick<
  DesktopApi,
  "listRecentThreadLockNotes" | "rememberThreadLockNote" | "forgetThreadLockNote"
>;

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
  /** Where recent notes are read and remembered. Defaults to the window's bridge. */
  recentNotesApi?: RecentNotesApi;
};

/**
 * Takes the note for a thread lock. Mounted only while open. The note is
 * free text, so Enter adds a line and ⌘Enter (Ctrl+Enter) submits. Portalled
 * to the body: the thread view opens it from inside its dimmed layout.
 *
 * The operator's recent short notes sit under the field as chips. The row is
 * one Tab stop; the arrows move inside it, and Enter, Space or a click fills
 * the note and moves focus to the primary button, so a repeat reason is Tab,
 * Enter, Enter. ⌘1–⌘9 are not used: they switch profiles. Each chip's ×
 * forgets the note; it is not a Tab stop, so Delete or Backspace on the chip
 * does the same from the keyboard.
 */
export function ThreadLockDialog(props: ThreadLockDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState(props.initialNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const recentNotesApi = props.recentNotesApi ?? getDesktopApi();
  const [recentNotes, setRecentNotes] = useRecentThreadLockNotes(recentNotesApi);
  const [rovingIndex, setRovingIndex] = useState<number>();
  // Where focus goes once a removed chip has left the DOM: a chip index, or
  // the note field when the row is gone.
  const focusAfterRemovalRef = useRef<number | "note">(undefined);
  const recentRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const submitRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog<HTMLElement>({
    // A lock in flight cannot be called back, so the dialog waits for it.
    onClose: () => {
      if (!busy) props.onCancel();
    },
    initialFocus: noteRef,
    ...(props.returnFocus ? { returnFocus: props.returnFocus } : {}),
  });
  const locking = props.mode === "lock";
  const trimmedNote = note.trim();
  const selectedIndex = recentNotes.indexOf(trimmedNote);
  // Tab enters the row where the operator last was, else on the chip that
  // matches the note, else on the first.
  const tabStop = Math.min(
    rovingIndex ?? (selectedIndex >= 0 ? selectedIndex : 0),
    recentNotes.length - 1,
  );

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onSubmit(note);
      // Only a note the operator saved becomes a recent one. Saving the note
      // the dialog opened with is not authoring it: that note may be an agent
      // tool's, a peer's or a messaging contact's. Failing to remember must
      // not turn a lock that succeeded into an error.
      if (trimmedNote !== (props.initialNote ?? "").trim()) {
        void recentNotesApi?.rememberThreadLockNote?.({ note }).catch(() => undefined);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setBusy(false);
    }
  };

  const pickRecent = (index: number) => {
    const recent = recentNotes[index];
    if (recent === undefined || busy) return;
    setNote(recent);
    setError(undefined);
    setRovingIndex(index);
    submitRef.current?.focus();
  };

  const removeRecent = (index: number) => {
    const recent = recentNotes[index];
    if (recent === undefined || busy) return;
    const remaining = recentNotes.filter((_, at) => at !== index);
    // Focus stays in the row on the chip that took this one's place, or the
    // one before it at the end, so removing several is one key repeated.
    const nextIndex = Math.min(index, remaining.length - 1);
    focusAfterRemovalRef.current = nextIndex >= 0 ? nextIndex : "note";
    setRecentNotes(remaining);
    setRovingIndex(nextIndex >= 0 ? nextIndex : undefined);
    void recentNotesApi?.forgetThreadLockNote?.({ note: recent }).catch(() => undefined);
  };

  // Before paint, so focus never rests on <body> once the chip is gone.
  useLayoutEffect(() => {
    const target = focusAfterRemovalRef.current;
    if (target === undefined) return;
    focusAfterRemovalRef.current = undefined;
    if (target === "note") noteRef.current?.focus();
    else recentRefs.current[target]?.focus();
  }, [recentNotes]);

  const moveInRecents = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeRecent(index);
      return;
    }
    const last = recentNotes.length - 1;
    const target =
      event.key === "ArrowLeft" || event.key === "ArrowUp" ? Math.max(index - 1, 0)
      : event.key === "ArrowRight" || event.key === "ArrowDown" ? Math.min(index + 1, last)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : undefined;
    if (target === undefined) return;
    event.preventDefault();
    setRovingIndex(target);
    recentRefs.current[target]?.focus();
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
        {recentNotes.length > 0 ? (
          <div
            aria-label="Recent notes"
            className="thread-lock-dialog__recents"
            role="group"
          >
            <span aria-hidden="true" className="thread-lock-dialog__recents-label">Recent</span>
            {recentNotes.map((recent, index) => (
              <span key={recent} className="thread-lock-dialog__recent">
                <button
                  ref={(element) => {
                    recentRefs.current[index] = element;
                  }}
                  aria-keyshortcuts="Delete Backspace"
                  aria-pressed={index === selectedIndex}
                  className="thread-lock-dialog__recent-pick"
                  disabled={busy}
                  tabIndex={index === tabStop ? 0 : -1}
                  type="button"
                  onClick={() => pickRecent(index)}
                  onFocus={() => setRovingIndex(index)}
                  onKeyDown={(event) => moveInRecents(event, index)}
                >
                  {recent}
                </button>
                <button
                  aria-label={`Remove “${recent}” from recent notes`}
                  className="thread-lock-dialog__recent-remove"
                  disabled={busy}
                  tabIndex={-1}
                  type="button"
                  onClick={() => removeRecent(index)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
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
            ref={submitRef}
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

/**
 * The operator's recent lock notes, read once as the dialog opens. A window
 * without the bridge, or a failed read, offers none rather than an error.
 */
function useRecentThreadLockNotes(
  api: RecentNotesApi | undefined,
): [string[], (notes: string[]) => void] {
  const [notes, setNotes] = useState<string[]>([]);
  const list = api?.listRecentThreadLockNotes;
  useEffect(() => {
    if (!list) return;
    let cancelled = false;
    list()
      .then((response) => {
        if (!cancelled) setNotes(response.notes);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [list]);
  return [notes, setNotes];
}
