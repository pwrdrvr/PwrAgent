import type { ThreadToolInvocationAlert } from "@pwragent/shared";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export function buildToolAccountingNotice(params: {
  alert: ThreadToolInvocationAlert;
  onDismiss: () => void;
  onSteer?: () => void;
  threadLink?: ResolvedThreadLink;
}): AppNoticeToastNotice {
  const polling = params.alert.kind === "noisy-polling";
  const steerAction = params.onSteer
    ? [{
        label: polling ? "Use monitor job" : "Steer safer output",
        onClick: params.onSteer,
        tone: "primary" as const,
      }]
    : [];
  return {
    actions: [
      ...steerAction,
      {
        label: "Dismiss",
        onClick: params.onDismiss,
        tone: "secondary",
      },
    ],
    autoDismiss: false,
    copyText: [params.alert.message, params.alert.suggestedPrompt].join("\n\n"),
    id: [
      "tool-accounting",
      params.alert.backend,
      params.alert.threadId,
      params.alert.kind,
    ].join(":"),
    message: params.alert.message,
    threadLink: params.threadLink,
    title: polling ? "Repeated queued checks" : "Large tool output",
    tone: params.alert.severity === "critical" ? "error" : "warning",
  };
}
