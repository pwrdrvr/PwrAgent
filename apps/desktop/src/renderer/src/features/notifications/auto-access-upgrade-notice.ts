import type { AppNoticeToastNotice } from "./AppNoticeToast";

export const AUTO_ACCESS_UPGRADE_NOTICE_ID = "auto-access-upgrade";

/**
 * Shown once to a profile whose saved launchpad access the upgrade changed:
 * new Codex and Claude threads now start on Auto instead of Default Access.
 * Every way out of the card closes it for good, so each one calls `onDismiss`.
 */
export function buildAutoAccessUpgradeNotice(params: {
  onDismiss: () => void;
  onReviewAccess: () => void;
}): AppNoticeToastNotice {
  return {
    actions: [
      {
        label: "Got it",
        onClick: params.onDismiss,
        tone: "secondary",
      },
      {
        label: "Review access",
        onClick: params.onReviewAccess,
        tone: "primary",
      },
    ],
    autoDismiss: false,
    detail:
      "To be asked first again, set Access to Default Access for each provider in Settings.",
    id: AUTO_ACCESS_UPGRADE_NOTICE_ID,
    message:
      "New Codex and Claude threads now run on Auto. The workspace sandbox stays on, and the provider approves routine requests instead of asking you. Threads you already have keep their access.",
    onDismiss: params.onDismiss,
    title: "New threads start on Auto",
    tone: "neutral",
  };
}
