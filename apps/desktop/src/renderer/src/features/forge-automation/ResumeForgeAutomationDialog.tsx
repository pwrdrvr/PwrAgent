import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type {
  ProjectHeldWakeup,
  ResolveProjectHeldWakeupsRequest,
  ResolveProjectHeldWakeupsResponse,
} from "@pwragent/shared";
import { useModalDialog } from "../../lib/useModalDialog";
import { formatForgeAutomationTime } from "./forge-automation-view";

export type ResumeForgeAutomationDialogProps = {
  projectLabel: string;
  wakeups: readonly ProjectHeldWakeup[];
  /** Where focus goes on close when the opener is gone, as from a menu. */
  returnFocus?: RefObject<HTMLElement | null>;
  /** Sends or discards held wake-ups now. */
  onResolve: (
    resolutions: ResolveProjectHeldWakeupsRequest["resolutions"],
  ) => Promise<ResolveProjectHeldWakeupsResponse>;
  onCancel: () => void;
  /** Saves the project as active. Rejects with a message to show. */
  onResume: () => Promise<void>;
  /** Clock for each row's time. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Resume forge activity when wake-ups were held while the project was paused
 * (design 5a). Each row can be sent or discarded at once; anything left stays
 * held in its thread under the Held chip. Resuming replays nothing that the
 * pause skipped.
 */
export function ResumeForgeAutomationDialog(props: ResumeForgeAutomationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [wakeups, setWakeups] = useState<readonly ProjectHeldWakeup[]>(props.wakeups);
  const [pendingEntryIds, setPendingEntryIds] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useModalDialog<HTMLElement>({
    onClose: () => {
      if (!busy) props.onCancel();
    },
    ...(props.returnFocus ? { returnFocus: props.returnFocus } : {}),
  });
  const now = props.now?.() ?? Date.now();
  const resumeButtonRef = useRef<HTMLButtonElement>(null);
  /** The row a Send or Discard came from, so focus can follow it. */
  const rowFocusRef = useRef<{ index: number; action: "send" | "discard" } | undefined>(undefined);

  // A settled row unmounts, and a pending one disables its buttons, so the
  // focused button is gone either way. Once the row settles, focus the same
  // action on the row now in its place, else the row above, else Resume.
  useEffect(() => {
    const request = rowFocusRef.current;
    const dialog = dialogRef.current;
    if (!request || pendingEntryIds.size > 0 || !dialog) return;
    rowFocusRef.current = undefined;
    const active = document.activeElement;
    if (
      active
      && active !== document.body
      && dialog.contains(active)
      && !(active as HTMLButtonElement).disabled
    ) {
      return;
    }
    const rows = dialog.querySelectorAll<HTMLElement>(".forge-automation-dialog__held-row");
    const row = rows[Math.min(request.index, rows.length - 1)];
    const target = row?.querySelector<HTMLButtonElement>(`[data-held-action="${request.action}"]`)
      ?? resumeButtonRef.current;
    target?.focus();
  }, [dialogRef, pendingEntryIds, wakeups]);

  /** Removes every row the owner settled and reports the ones it could not. */
  const resolve = async (
    targets: readonly ProjectHeldWakeup[],
    action: "send" | "discard",
  ): Promise<boolean> => {
    setError(undefined);
    const response = await props.onResolve(targets.map((wakeup) => ({
      entryId: wakeup.entryId,
      backend: wakeup.backend,
      threadId: wakeup.threadId,
      action,
    })));
    const failed = response.results.filter((result) => result.status === "failed");
    const settled = new Set(response.results
      .filter((result) => result.status !== "failed")
      .map((result) => result.entryId));
    setWakeups((current) => current.filter((wakeup) => !settled.has(wakeup.entryId)));
    if (failed.length > 0) {
      setError(failed[0]?.error ?? (action === "send"
        ? "A held wake-up could not be sent."
        : "A held wake-up could not be discarded."));
      return false;
    }
    return true;
  };

  const resolveRow = async (wakeup: ProjectHeldWakeup, action: "send" | "discard") => {
    if (busy || pendingEntryIds.has(wakeup.entryId)) return;
    rowFocusRef.current = {
      index: Math.max(0, wakeups.findIndex((candidate) => candidate.entryId === wakeup.entryId)),
      action,
    };
    setPendingEntryIds((current) => new Set(current).add(wakeup.entryId));
    try {
      await resolve([wakeup], action);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : String(resolveError));
    } finally {
      setPendingEntryIds((current) => {
        const next = new Set(current);
        next.delete(wakeup.entryId);
        return next;
      });
    }
  };

  const resume = async (discardAll: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (discardAll && wakeups.length > 0 && !(await resolve(wakeups, "discard"))) {
        setBusy(false);
        return;
      }
      await props.onResume();
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : String(resumeError));
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
        className="rename-thread-dialog forge-automation-dialog forge-automation-dialog--resume"
        role="dialog"
      >
        <h2 id={titleId}>Resume forge activity in {props.projectLabel}?</h2>
        <p id={descriptionId} className="forge-automation-dialog__lede">
          These arrived while the project was paused. Send one now, discard it, or leave it held in its thread.
        </p>
        {wakeups.length > 0 ? (
          <ul aria-label="Held wake-ups" className="forge-automation-dialog__held">
            {wakeups.map((wakeup) => {
              const title = wakeup.threadTitle ?? "Untitled thread";
              const rowBusy = busy || pendingEntryIds.has(wakeup.entryId);
              return (
                <li key={wakeup.entryId} className="forge-automation-dialog__held-row">
                  <span className="forge-automation-dialog__held-title">{title}</span>
                  <span className="forge-automation-dialog__held-actions">
                    <button
                      aria-label={`Discard wake-up for ${title}`}
                      className="button button--ghost"
                      data-held-action="discard"
                      disabled={rowBusy}
                      type="button"
                      onClick={() => void resolveRow(wakeup, "discard")}
                    >
                      Discard
                    </button>
                    <button
                      aria-label={`Send wake-up to ${title}`}
                      className="button button--secondary"
                      data-held-action="send"
                      disabled={rowBusy}
                      type="button"
                      onClick={() => void resolveRow(wakeup, "send")}
                    >
                      Send
                    </button>
                  </span>
                  <span className="forge-automation-dialog__held-meta">
                    {wakeup.summary} · {formatForgeAutomationTime(wakeup.createdAt, now)}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="forge-automation-dialog__hint">Nothing is held now.</p>
        )}
        <p className="forge-automation-dialog__hint">
          Anything you leave stays held in its thread, under the Held chip, until you send or delete it there.
        </p>
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
            className="button button--secondary"
            disabled={busy || wakeups.length === 0}
            type="button"
            onClick={() => void resume(true)}
          >
            Discard All and Resume
          </button>
          <button
            ref={resumeButtonRef}
            className="button button--primary"
            disabled={busy}
            type="button"
            onClick={() => void resume(false)}
          >
            Resume
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
