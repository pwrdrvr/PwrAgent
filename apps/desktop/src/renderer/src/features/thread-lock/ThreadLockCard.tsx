import { useId, useState } from "react";
import type { ThreadLock } from "@pwragent/shared";
import { LockIcon } from "../../icons";

const LOCKED_AT_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "You · Oct 5, 6:31 PM": who set the lock, and when. */
export function describeThreadLockOrigin(lock: ThreadLock): string {
  const who = lock.source === "agent_tool"
    ? "Agent tool"
    : lock.source === "peer"
      ? "Another instance"
      : "You";
  return `${who} · ${LOCKED_AT_FORMAT.format(lock.lockedAt)}`;
}

export type ThreadLockCardProps = {
  lock: ThreadLock;
  /** Rejects with a message to show on the card. */
  onUnlock?: () => Promise<void>;
  onEditNote?: () => void;
};

/**
 * Sits centered over a locked thread, whose transcript and composer dim
 * behind it. Only the card takes the pointer: the transcript under the dim
 * still scrolls and selects, since reading or copying is the usual reason to
 * open a locked thread.
 */
export function ThreadLockCard(props: ThreadLockCardProps) {
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { onUnlock } = props;

  return (
    <div className="thread-lock-layer">
      <section aria-labelledby={headingId} className="thread-lock-card">
        <h2 id={headingId} className="thread-lock-card__heading">
          <LockIcon size={15} aria-hidden="true" />
          Thread locked
        </h2>
        <p className={`thread-lock-card__note${props.lock.note ? "" : " thread-lock-card__note--empty"}`}>
          {props.lock.note ?? "No note."}
        </p>
        <div className="thread-lock-card__actions">
          {onUnlock ? (
            <button
              className="button button--primary"
              disabled={busy}
              type="button"
              onClick={async () => {
                setBusy(true);
                setError(undefined);
                try {
                  await onUnlock();
                } catch (unlockError) {
                  setError(unlockError instanceof Error ? unlockError.message : String(unlockError));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Unlock
            </button>
          ) : null}
          {props.onEditNote ? (
            <button
              className="button button--secondary"
              disabled={busy}
              type="button"
              onClick={props.onEditNote}
            >
              {props.lock.note ? "Edit Note" : "Add Note"}
            </button>
          ) : null}
          <span className="thread-lock-card__origin">{describeThreadLockOrigin(props.lock)}</span>
        </div>
        {error ? <p className="thread-lock-card__error" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
