import type { AppNoticeToastNotice } from "./AppNoticeToast";

/**
 * Thread lifecycle actions that can fail *after* the control that started
 * them is gone from the screen.
 *
 * Each of these is fire-and-forget: the rename dialog closes before
 * `renameThread` resolves, the context menu closes before `archiveThread`
 * resolves, `discardLaunchpad` drops the selection before it persists the
 * discard, and a create failure has no thread to anchor to at all. There is
 * therefore nothing left inline to hang the message on, which is why these
 * route to the durable toast stack instead of a static slot in the sidebar.
 *
 * Failures whose originating control IS still on screen deliberately do NOT
 * appear here — `pickDirectoryError` renders beside the composer's "Add
 * directory" button, and `launchpadError` renders in the launchpad composer's
 * footer, which is still mounted for every producer except the discard.
 */
export type ThreadActionErrorKind =
  | "archive-thread"
  | "create-thread"
  | "discard-launchpad"
  | "rename-thread";

export type ThreadActionErrorSignal = {
  kind: ThreadActionErrorKind;
  message: string;
};

const THREAD_ACTION_ERROR_TITLES: Record<ThreadActionErrorKind, string> = {
  "archive-thread": "Archive failed",
  "create-thread": "Could not start thread",
  "discard-launchpad": "Discard failed",
  "rename-thread": "Rename failed",
};

/**
 * One durable notice per action kind. Re-keying on the thread would be
 * wrong today: the hook holds a single error slot per action, so a second
 * failure replaces the first rather than accumulating, and a per-thread id
 * would strand the earlier toast with no producer left to clear it.
 */
export function threadActionErrorNoticeId(kind: ThreadActionErrorKind): string {
  return `thread-action-error:${kind}`;
}

export function resolveThreadActionErrorNotice(
  signal: ThreadActionErrorSignal,
): AppNoticeToastNotice {
  return {
    // Sticky: a backend failure the operator never saw is worse than a
    // toast they have to dismiss. The producer clears it on the next
    // attempt, so a successful retry takes it down on its own.
    autoDismiss: false,
    copyText: signal.message,
    id: threadActionErrorNoticeId(signal.kind),
    message: signal.message,
    title: THREAD_ACTION_ERROR_TITLES[signal.kind],
    tone: "error",
  };
}
