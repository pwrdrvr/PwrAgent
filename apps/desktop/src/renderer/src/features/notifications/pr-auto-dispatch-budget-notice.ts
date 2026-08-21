import type { PrAutoDispatchBudgetStatus } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export function buildPrAutoDispatchBudgetNotice(params: {
  onLeaveDisabled: () => void;
  onResume: () => void;
  status: PrAutoDispatchBudgetStatus;
}): AppNoticeToastNotice | undefined {
  if (!params.status.paused) return undefined;

  return {
    actions: [
      {
        label: "Resume",
        onClick: params.onResume,
        tone: "primary",
      },
    ],
    autoDismiss: false,
    detail:
      "Thread-level Auto-fix PR choices were left unchanged. Automatic repairs remain budget-gated after you resume.",
    id: `pr-auto-dispatch-budget-paused:${params.status.pausedAt ?? "current"}`,
    message:
      "The automatic repair budget is empty, so Auto-fix PR is paused for this PwrAgent profile.",
    onDismiss: params.onLeaveDisabled,
    title: "Auto-fix PR paused",
    tone: "warning",
  };
}
