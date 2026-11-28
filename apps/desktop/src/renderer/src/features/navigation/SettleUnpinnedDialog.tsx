import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  SettleDirectoryUnpinnedCandidate,
  SettleDirectoryUnpinnedResponse,
} from "@pwragent/shared/contracts/thread-settle";
import { useModalDialog } from "../../lib/useModalDialog";

type SettleUnpinnedDirectory = { key: string; label: string };

type SettleUnpinnedDialogProps = {
  directory: SettleUnpinnedDirectory;
  /** Without threads, the owner's candidates; with them, settles exactly those. */
  settle: (
    directory: SettleUnpinnedDirectory,
    threads?: SettleDirectoryUnpinnedCandidate[],
  ) => Promise<SettleDirectoryUnpinnedResponse>;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
};

type DialogState =
  | { kind: "loading" }
  | { kind: "ready"; preview: SettleDirectoryUnpinnedResponse }
  | { kind: "settling"; preview: SettleDirectoryUnpinnedResponse }
  | { kind: "failed"; message: string; preview?: SettleDirectoryUnpinnedResponse };

function formatThreads(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

/**
 * Settle Unpinned…: lists the project's idle Unpinned threads by title, as
 * the owner counts them, and settles exactly that list on confirm. Threads
 * that are working or have a queued send are left where they are.
 */
export function SettleUnpinnedDialog(props: SettleUnpinnedDialogProps) {
  const { directory, settle, onClose } = props;
  const [state, setState] = useState<DialogState>({ kind: "loading" });
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({
    onClose,
    initialFocus: cancelRef,
    ...(props.returnFocus === undefined ? {} : { returnFocus: props.returnFocus }),
  });

  useEffect(() => {
    let current = true;
    settle(directory).then(
      (preview) => { if (current) setState({ kind: "ready", preview }); },
      (error: unknown) => {
        if (current) setState({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => { current = false; };
  }, [directory, settle]);

  const preview = state.kind === "loading" ? undefined : state.preview;
  const candidates = preview?.candidates ?? [];
  const confirm = (): void => {
    if (!preview || candidates.length === 0) return;
    setState({ kind: "settling", preview });
    settle(directory, candidates).then(
      () => onClose(),
      (error: unknown) => setState({
        kind: "failed", preview, message: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  return (
    <div
      className="pr-detach-warning-modal"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        aria-labelledby="settle-unpinned-title"
        aria-describedby="settle-unpinned-summary"
        aria-modal="true"
        className="pr-detach-warning-dialog settle-unpinned-dialog"
        role="dialog"
      >
        <h2 id="settle-unpinned-title">
          {candidates.length > 0
            ? `Settle ${formatThreads(candidates.length)} in ${directory.label}?`
            : `Settle unpinned threads in ${directory.label}`}
        </h2>
        <p id="settle-unpinned-summary">
          {state.kind === "loading"
            ? "Finding idle unpinned threads…"
            : candidates.length > 0
              ? "Each moves to Settled and is marked read. A new turn brings a thread back to Unpinned."
              : "No idle unpinned threads to settle."}
          {preview && preview.skippedBusy > 0
            ? ` ${formatThreads(preview.skippedBusy)} still working or waiting to send ${preview.skippedBusy === 1 ? "stays" : "stay"} in Unpinned.`
            : ""}
        </p>
        {candidates.length > 0 ? (
          <ul className="pr-detach-warning-dialog__list settle-unpinned-dialog__list">
            {candidates.map((thread) => (
              <li key={`${thread.backend}:${thread.threadId}`}>{thread.title}</li>
            ))}
          </ul>
        ) : null}
        {state.kind === "failed" ? (
          <p className="settle-unpinned-dialog__error" role="alert">{state.message}</p>
        ) : null}
        <div className="pr-detach-warning-dialog__actions">
          <button ref={cancelRef} type="button" onClick={onClose}>
            Cancel
          </button>
          {candidates.length > 0 ? (
            <button
              className="settle-unpinned-dialog__confirm"
              type="button"
              disabled={state.kind === "settling"}
              onClick={confirm}
            >
              {state.kind === "settling" ? "Settling…" : `Settle ${formatThreads(candidates.length)}`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
