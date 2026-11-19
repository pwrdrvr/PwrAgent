import type { MessagingQuestionnaireAnswer } from "@pwragent/messaging-interface";

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
