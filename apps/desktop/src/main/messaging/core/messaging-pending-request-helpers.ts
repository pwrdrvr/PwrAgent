import type { MessagingBindingRecord, MessagingQuestionnaireAnswer, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { federationTargetForBinding } from "./messaging-backend-event-helpers";

export function pendingRequestTarget(intent: MessagingSurfaceIntent, binding: MessagingBindingRecord | undefined) {
  const request = intent.requestContext ?? (intent.kind === "questionnaire" ? intent.asyncReply : undefined) ?? binding;
  if (!request) return undefined;
  const { backend, threadId } = request;
  const federationTarget = intent.requestContext?.federationTarget
    ?? (binding?.backend === backend && binding.threadId === threadId ? federationTargetForBinding(binding) : undefined);
  return { backend, threadId, federationTarget };
}

export function approvalBodyWithResponse(body: string, responseLabel: string): string {
  const blocks = body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const preservedBlocks = blocks.filter((block, index) => {
    if (index === 0) {
      return false;
    }
    return !/^Reply with\b/i.test(block);
  });

  return [...preservedBlocks, `Response Received: ${responseLabel}`].join("\n\n");
}

export function questionnaireAnswerValue(
  answer: MessagingQuestionnaireAnswer | null | undefined,
): string[] {
  const value = answer?.value.trim();
  return value ? [value] : [];
}
