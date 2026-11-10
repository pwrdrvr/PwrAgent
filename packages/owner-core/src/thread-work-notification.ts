import {
  threadNotificationSnippet,
  type AppServerThreadMessageOrigin,
  type AppServerTurnInputItem,
  type ThreadIncomingWorkSummary,
} from "@pwragent/shared";

/** Read the contribution list, never attribute a whole grouped steer to its first sender. */
export function buildIncomingWorkSummary(params: {
  messageOrigin?: AppServerThreadMessageOrigin;
  input: AppServerTurnInputItem[];
  agentMessages?: { origin?: AppServerThreadMessageOrigin; input: AppServerTurnInputItem[] }[];
}, recipientTitle?: string): ThreadIncomingWorkSummary | undefined {
  const messages = (params.agentMessages ?? [{ origin: params.messageOrigin, input: params.input }])
    .filter((message) => message.origin?.kind === "agent");
  if (messages.length === 0) return undefined;
  return {
    ...(recipientTitle ? { recipientTitle: threadNotificationSnippet(recipientTitle, 80) } : {}),
    messages: messages.slice(0, 3).map((message) => ({
      origin: message.origin!,
      preview: threadNotificationSnippet(message.input
        .flatMap((item) => item.type === "text" ? [item.text] : []).join("\n")) || "Attachment",
    })),
    omittedMessageCount: Math.max(0, messages.length - 3),
  };
}
