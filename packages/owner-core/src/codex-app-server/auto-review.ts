import type { AppServerNotification } from "@pwragent/shared";
import type {
  GuardianApprovalReviewStatus,
  ItemGuardianApprovalReviewCompletedNotification,
  ItemGuardianApprovalReviewStartedNotification,
} from "@pwrdrvr/codex-app-server-protocol/v2";

const REVIEW_LABELS: Record<GuardianApprovalReviewStatus, string> = {
  inProgress: "Reviewing",
  approved: "Approved",
  denied: "Denied",
  timedOut: "Timed out",
  aborted: "Aborted",
};

/** Translate Codex's review events into live transcript activity, never approvals. */
export function normalizeAutoReviewNotification(
  method: string,
  value: unknown,
): AppServerNotification | undefined {
  if (method !== "item/autoApprovalReview/started"
    && method !== "item/autoApprovalReview/completed") {
    return undefined;
  }
  const params = value as
    | ItemGuardianApprovalReviewStartedNotification
    | ItemGuardianApprovalReviewCompletedNotification
    | undefined;
  if (!params?.threadId || !params.reviewId || !params.review?.status) {
    return undefined;
  }
  const label = REVIEW_LABELS[params.review.status];
  if (!label) return undefined;
  const completed = method === "item/autoApprovalReview/completed";
  const action = params.action;
  const actionLabel = action?.type === "command"
    ? action.command
    : action?.type === "networkAccess"
      ? action.target
      : action?.type === "mcpToolCall"
        ? action.toolTitle ?? `${action.server}/${action.toolName}`
        : action?.type === "requestPermissions"
          ? action.reason
          : action?.type;
  const detail = [
    actionLabel,
    params.review.riskLevel ? `Risk: ${params.review.riskLevel}` : undefined,
    params.review.userAuthorization ? `Authorization: ${params.review.userAuthorization}` : undefined,
    params.review.rationale,
  ].filter(Boolean).join("\n\n");
  return {
    method: completed ? "item/completed" : "item/started",
    params: {
      threadId: params.threadId,
      turnId: params.turnId,
      item: {
        id: `auto-review-${params.reviewId}`,
        type: "autoApprovalReview",
        text: `Auto review: ${label}`,
        data: {
          detail,
          status: params.review.status === "inProgress" ? "in_progress"
            : params.review.status === "approved" ? "completed"
              : params.review.status === "aborted" ? "cancelled" : "failed",
        },
      },
    },
  };
}
