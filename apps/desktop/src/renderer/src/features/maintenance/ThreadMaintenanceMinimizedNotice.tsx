import { AppNoticeToast } from "../notifications/AppNoticeToast";
import {
  sessionCanDiscard,
  sessionNoticeText,
  type ThreadMaintenanceSessionController,
} from "./thread-maintenance-session";

/**
 * The minimized thread maintenance session, as a notice. Reopen shows the
 * dialog as it was left. Closing the notice only hides it: the session stays
 * for File → Thread Maintenance…, and the notice returns when a scan or run
 * moves on. Discard is its own button, offered only when no scan or run is
 * under way, and it never stops anything.
 */
export function ThreadMaintenanceMinimizedNotice(props: { controller: ThreadMaintenanceSessionController }) {
  const { session, status, restore, hideNotice, discard } = props.controller;
  if (!session?.minimized || session.noticeHidden) return null;
  const text = sessionNoticeText(status);
  return (
    <AppNoticeToast
      notice={{
        id: `thread-maintenance-session:${session.id}`,
        title: "Thread maintenance",
        message: text.message,
        autoDismiss: false,
        ...(text.state ? { status: { label: text.label, state: text.state } } : {}),
        dismissLabel: "Hide this notice; File → Thread Maintenance… reopens the session",
        actions: [
          { label: "Reopen", tone: "primary", onClick: restore },
          ...(sessionCanDiscard(status) ? [{ label: "Discard", tone: "secondary" as const, onClick: discard }] : []),
        ],
      }}
      onDismiss={hideNotice}
    />
  );
}
