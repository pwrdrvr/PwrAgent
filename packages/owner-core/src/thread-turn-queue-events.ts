import type { AgentEvent, AppServerTurnInputItem } from "@pwragent/shared";
import type { ThreadTurnQueueEntry, ThreadTurnQueueLifecycleEvent } from "./thread-turn-queue";
import { buildIncomingWorkSummary } from "./thread-work-notification";

/** One protocol projection for the queue's lifecycle on every owner host. */
export function buildTurnQueueLifecycleEvent(event: ThreadTurnQueueLifecycleEvent, recipientTitle?: string): AgentEvent {
  const baseParams = {
    threadId: event.entry.threadId,
    queueEntryId: event.entry.id,
    queueEntryCreatedAt: event.entry.createdAt,
    origin: event.entry.origin,
    ...(event.entry.messageOrigin ? { messageOrigin: event.entry.messageOrigin } : {}),
    ...(event.type === "started" ? {
      incomingWork: buildIncomingWorkSummary(event.entry, recipientTitle),
    } : {}),
    automationRunId: event.entry.automationRunId,
    automationName: event.entry.automationName,
  };

  return {
    backend: event.entry.backend,
    notification: {
      method: "thread/turnQueue/updated",
      params:
        event.type === "queued"
          ? {
              ...baseParams,
              status: "queued",
              ...(event.inputUpdated ? { inputUpdated: true } : {}),
              position: event.position,
              // Windows that did not submit this entry mirror a chip
              // from the event; carry the text so they need not wait
              // for the next navigation snapshot.
              displayText: queuedTurnDisplayText(event.entry.input),
              manualReleaseRequired:
                event.entry.manualReleaseRequired === true,
              ...queuedTurnPauseParams(event.entry),
              ...(event.entry.holdReason
                ? { errorMessage: event.entry.holdReason }
                : {}),
            }
          : event.type === "started"
            ? {
                ...baseParams,
                status: "started",
                turnId: event.turnId,
              }
            : event.type === "failed"
              ? {
                  ...baseParams,
                  status: "failed",
                  errorMessage: event.error.message,
                }
              : event.type === "held"
                ? {
                    ...baseParams,
                    status: "held",
                    position: event.position,
                    displayText: queuedTurnDisplayText(event.entry.input),
                    errorMessage: event.reason,
                    manualReleaseRequired: true,
                    ...queuedTurnPauseParams(event.entry),
                  }
                : event.type === "blocked"
                  ? {
                      ...baseParams,
                      status: "blocked",
                      errorMessage: event.error.message,
                    }
                  : event.type === "cancelled"
                    ? {
                        ...baseParams,
                        status: "cancelled",
                      }
                    : {
                        ...baseParams,
                        status: "terminal",
                        turnId: event.turnId,
                        terminalStatus: event.status,
                      },
    },
  };
}

export function queuedTurnPauseParams(entry: ThreadTurnQueueEntry): { paused?: true; pauseRevision?: number } {
  return {
    ...(entry.paused ? { paused: true } : {}),
    ...(entry.pauseRevision ? { pauseRevision: entry.pauseRevision } : {}),
  };
}

/** First text of a queued turn's input, truncated for chip display. */
export function queuedTurnDisplayText(input: AppServerTurnInputItem[]): string {
  const text = input
    .filter(
      (item): item is Extract<AppServerTurnInputItem, { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text.length > 200 ? `${text.slice(0, 200)}\u2026` : text;
}

