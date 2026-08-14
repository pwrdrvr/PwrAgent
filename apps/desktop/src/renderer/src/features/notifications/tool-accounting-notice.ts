import type { ThreadToolInvocationAlert } from "@pwragent/shared";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export function buildToolAccountingNotice(params: {
  alert: ThreadToolInvocationAlert;
  onExamine: () => void;
  onDismiss: () => void;
  threadLink?: ResolvedThreadLink;
}): AppNoticeToastNotice {
  const polling = params.alert.kind === "noisy-polling";
  return {
    actions: [
      {
        label: `Examine ${params.alert.invocationCount.toLocaleString()} case${params.alert.invocationCount === 1 ? "" : "s"}`,
        onClick: params.onExamine,
        tone: "primary" as const,
      },
      {
        label: "Dismiss",
        onClick: params.onDismiss,
        tone: "secondary",
      },
    ],
    autoDismiss: false,
    copyText: [params.alert.message, params.alert.suggestedPrompt].join("\n\n"),
    id: toolAccountingNoticeId(params.alert),
    message: params.alert.message,
    threadLink: params.threadLink,
    title: polling ? "Repeated queued checks" : "Large tool output",
    tone: params.alert.severity === "critical" ? "error" : "warning",
  };
}

export function toolAccountingNoticeId(
  alert: ThreadToolInvocationAlert,
): string {
  return [
    "tool-accounting",
    alert.backend,
    alert.threadId,
    alert.turnId ?? "no-turn",
    alert.kind,
  ].join(":");
}

export function resolveDismissedToolIncident(params: {
  dismissedSeverity?: ThreadToolInvocationAlert["severity"];
  incomingSeverity: ThreadToolInvocationAlert["severity"];
}): "escalate" | "show" | "suppress" {
  if (!params.dismissedSeverity) return "show";
  return params.dismissedSeverity === "warning" && params.incomingSeverity === "critical"
    ? "escalate"
    : "suppress";
}
