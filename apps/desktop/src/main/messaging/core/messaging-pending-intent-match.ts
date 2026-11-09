import type { MessagingBindingRecord, MessagingPendingIntentRecord } from "@pwragent/messaging-interface";

export function isAsyncQuestionnaireForThread(
  pendingIntent: MessagingPendingIntentRecord,
  params: {
    backend: MessagingBindingRecord["backend"];
    threadId: MessagingBindingRecord["threadId"];
  },
): boolean {
  const intent = pendingIntent.intent;
  return (
    intent.kind === "questionnaire"
    && intent.asyncReply?.backend === params.backend
    && intent.asyncReply.threadId === params.threadId
  );
}
