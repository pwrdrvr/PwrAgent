import {
  parseThreadCorrespondenceMessage,
  threadNotificationSnippet,
  type AgentEvent,
  type AppServerThreadMessageOrigin,
  type ThreadIncomingWorkSummary,
} from "@pwragent/shared";

function senderLabel(origin: AppServerThreadMessageOrigin): string {
  const source = origin.sourceThread;
  const title = source?.title?.trim() || (source ? `Thread ${source.threadId}` : "Another thread");
  return threadNotificationSnippet(source?.instanceLabel ? `${title} (${source.instanceLabel})` : title, 80);
}

export function incomingWorkText(summary: ThreadIncomingWorkSummary, threadId: string): string {
  const recipient = threadNotificationSnippet(summary.recipientTitle || `Thread ${threadId}`, 80);
  return [
    "Incoming thread work",
    ...summary.messages.slice(0, 3).map((message) =>
      `${senderLabel(message.origin)} → ${recipient}\n${threadNotificationSnippet(message.preview)}`
    ),
    ...(summary.omittedMessageCount > 0
      ? [`+${summary.omittedMessageCount} more messages; full instructions are in the thread.`]
      : []),
  ].join("\n");
}

export function correspondenceNotice(event: AgentEvent): { id: string; state?: string; text: string } | undefined {
  if (event.notification.method !== "item/completed") return undefined;
  const item = event.notification.params.item as {
    id?: string; type?: string; text?: string; origin?: AppServerThreadMessageOrigin;
  };
  if (item?.type !== "agentMessage"
    || item.origin?.kind !== "pwragent"
    || item.origin.systemReason !== "thread-correspondence") return undefined;
  const parsed = parseThreadCorrespondenceMessage(item.text ?? "");
  const recipient = threadNotificationSnippet(parsed?.destination?.title
    || (parsed?.destination ? `Thread ${parsed.destination.threadId}` : "Another thread"), 80);
  const status = parsed?.state === "started" ? "Delivered"
    : parsed?.state === "queued" ? "Queued"
      : parsed?.state === "failed" ? "Failed to send"
        : parsed?.state === "held" ? "Held for retry"
          : parsed?.state === "cancelled" ? "Cancelled"
            : "Delivery update";
  return {
    id: item.id ?? "correspondence",
    state: parsed?.state,
    text: `${senderLabel(item.origin)} → ${recipient} · ${status}\n${threadNotificationSnippet(parsed?.body ?? "")}`,
  };
}

export function automatedWorkStartedLabel(origin: AppServerThreadMessageOrigin | undefined, name?: string): string {
  if (origin?.kind === "pwragent") {
    if (origin.dependencyId) return "Continue after resumed this thread.";
    if (origin.prAutomation?.kind === "watch") return "PR watch resumed this thread.";
    if (origin.prAutomation?.kind === "auto-fix") return "PR auto-fix started.";
    return "PwrAgent started work.";
  }
  return name ? `Automation started: ${name}` : "Automation started.";
}
