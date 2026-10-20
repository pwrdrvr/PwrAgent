import {
  codexAsyncQuestionItemId,
  formatCodexAsyncQuestionReply,
  type CodexAsyncQuestion,
} from "@pwragent/shared";

/**
 * One question's answer while it is being written. Shared by the transcript
 * card and the To-dos row, so both send the same reply.
 */
export type AsyncQuestionDraft = {
  option?: string;
  text: string;
};

/** The agent's first option is its recommendation, preselected. */
export function initialAsyncQuestionDrafts(
  questions: readonly CodexAsyncQuestion[],
): AsyncQuestionDraft[] {
  return questions.map((question) => ({ option: question.options?.[0], text: "" }));
}

/** Typed text replaces the chosen option. Empty leaves the question out. */
export function asyncQuestionDraftAnswer(draft: AsyncQuestionDraft | undefined): string {
  return draft?.text.trim() || draft?.option || "";
}

/** The reply for the given questions, by item id; undefined if none has an answer. */
export function formatAsyncQuestionDraftReply(
  messageId: string,
  questions: readonly CodexAsyncQuestion[],
  drafts: readonly AsyncQuestionDraft[],
  indexes: readonly number[],
): string | undefined {
  return formatCodexAsyncQuestionReply(indexes.map((index) => ({
    questionItemId: codexAsyncQuestionItemId(messageId, index),
    question: questions[index]?.title ?? "",
    answer: asyncQuestionDraftAnswer(drafts[index]),
  })));
}
