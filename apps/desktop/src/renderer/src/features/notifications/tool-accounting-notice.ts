import type { ThreadToolInvocationAlert } from "@pwragent/shared";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import type { AppNoticeToastNotice } from "./AppNoticeToast";
import type { ThreadIncidentSummary } from "./thread-incident-summary";
import {
  formatIncidentMicros,
  threadIncidentNoticeId,
} from "./thread-incident-summary";

export function buildToolAccountingNotice(params: {
  onExamine: () => void;
  onDismiss: () => void;
  onMute?: () => void;
  showCost: boolean;
  summary: ThreadIncidentSummary;
  threadLink?: ResolvedThreadLink;
}): AppNoticeToastNotice {
  const summary = params.summary;
  const critical = summary.severity === "critical";
  return {
    actions: [
      {
        label: `Examine ${summary.flaggedInvocationCount.toLocaleString()} case${summary.flaggedInvocationCount === 1 ? "" : "s"}`,
        onClick: params.onExamine,
        tone: "primary" as const,
      },
      {
        label: "Dismiss",
        onClick: params.onDismiss,
        tone: "secondary" as const,
      },
      /* Muting is offered only below critical. Silencing "output is getting
         large" is a reasonable call; silencing "output hit the cap and was
         truncated" is not something to offer in one click. */
      ...(params.onMute && !critical
        ? [{
            label: "Don't warn again",
            onClick: params.onMute,
            tone: "secondary" as const,
          }]
        : []),
    ],
    autoDismiss: false,
    copyText: describeToolAccountingIncident({ showCost: true, summary }),
    id: threadIncidentNoticeId(summary),
    message: describeToolAccountingIncident({
      showCost: params.showCost,
      summary,
    }),
    threadLink: params.threadLink,
    title: critical
      ? "Tool output hit the cap"
      : summary.pollingInvocationCount >= summary.flaggedInvocationCount
        ? "Repeated queued checks"
        : "Large tool output",
    tone: critical ? "error" : "warning",
  };
}

/**
 * One paragraph of thread-scoped stats rather than one card per turn. Cost
 * lines appear only when the operator has pricing display enabled and the
 * ledger has priced rows — the rest of the card still stands without them.
 */
export function describeToolAccountingIncident(params: {
  showCost: boolean;
  summary: ThreadIncidentSummary;
}): string {
  const summary = params.summary;
  const lines = [
    `${summary.flaggedInvocationCount.toLocaleString()} tool call${summary.flaggedInvocationCount === 1 ? "" : "s"} flagged across ${summary.turnsWithWarnings.toLocaleString()} turn${summary.turnsWithWarnings === 1 ? "" : "s"}.`,
  ];
  if (summary.pollingInvocationCount > 0) {
    lines.push(
      `${summary.pollingInvocationCount.toLocaleString()} ${summary.pollingInvocationCount === 1 ? "is a repeated queued check" : "are repeated queued checks"} waking the model to replay its context.`,
    );
  }
  if (summary.overCapCount > 0) {
    lines.push(
      `${summary.overCapCount.toLocaleString()} hit the output cap and ${summary.overCapCount === 1 ? "was" : "were"} truncated.`,
    );
  }
  if (params.showCost && summary.spentSinceFirstWarningMicros !== undefined) {
    const spent = formatIncidentMicros(
      summary.spentSinceFirstWarningMicros,
      summary.currency,
    );
    lines.push(
      summary.estimatedReplayWasteMicros !== undefined
        ? `${spent} spent since the first warning, of which about ${formatIncidentMicros(summary.estimatedReplayWasteMicros, summary.currency)} is replayed tool output.`
        : `${spent} spent since the first warning.`,
    );
  } else if (summary.replayedTokens > 0) {
    lines.push(
      `About ${summary.replayedTokens.toLocaleString()} tokens of tool output have been replayed through later round trips.`,
    );
  }
  return lines.join(" ");
}

export function toolAccountingNoticeId(
  alert: Pick<ThreadToolInvocationAlert, "backend" | "threadId">,
): string {
  return threadIncidentNoticeId({
    backend: alert.backend,
    threadId: alert.threadId,
  });
}
