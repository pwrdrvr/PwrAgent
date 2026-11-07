import type { AppNoticeToastNotice } from "./AppNoticeToast";

export const AUTOMATIC_ARCHIVE_RETIRED_NOTICE_ID = "automatic-archive-retired";

/**
 * Shown once to a profile whose hourly sweep used to archive threads: it had
 * archived threads, and automatic archiving was not turned off. Every way out
 * of the card closes it for good, so each one calls `onDismiss`.
 */
export function buildAutomaticArchiveRetiredNotice(params: {
  hibernationOn: boolean;
  onDismiss: () => void;
  onOpenHibernation: () => void;
  onOpenThreadMaintenance?: () => void;
}): AppNoticeToastNotice {
  return {
    actions: [
      ...(params.onOpenThreadMaintenance
        ? [{ label: "Thread Maintenance…", onClick: params.onOpenThreadMaintenance, tone: "primary" as const }]
        : []),
      { label: "Hibernation Settings", onClick: params.onOpenHibernation, tone: "secondary" },
    ],
    autoDismiss: false,
    id: AUTOMATIC_ARCHIVE_RETIRED_NOTICE_ID,
    message: [
      "Your threads stay where they are until you archive them.",
      params.hibernationOn
        ? "To free disk space, idle checkouts now hibernate and come back when you send the thread a message."
        : "Turn on hibernation in Settings → Worktrees to free the disk space of idle checkouts.",
    ].join(" "),
    onDismiss: params.onDismiss,
    title: "PwrAgent no longer archives threads on its own",
    tone: "neutral",
  };
}
