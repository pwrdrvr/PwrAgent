/**
 * Codex asks non-blocking questions through its `request_user_input_async`
 * tool. The tool returns to the model at once, and Codex records the call as
 * an assistant message with `delivery: "async"` and structured `questions`.
 * There is no pending server request to answer. The answer is an ordinary
 * user message whose text is a reply envelope that names each question.
 *
 * The envelope and the question identity match Codex's own clients: the TUI
 * builds the identity as `JSON.stringify([tool name, item id, index])` and
 * reads replies back from history to mark questions answered. Sending
 * anything else still reaches the model as plain text, but no Codex client
 * can tell the question was answered.
 */

const CODEX_ASYNC_QUESTION_TOOL_NAME = "request_user_input_async";
const REPLY_OPEN = "<send_user_message_question_reply>";
const REPLY_CLOSE = "</send_user_message_question_reply>";
const IDE_CONTEXT_PREFIX = "# Context from my IDE setup:\n";
const IDE_REQUEST_MARKER = "\n## My request for Codex:\n";
// Codex drops the identity from an oversized reply and bounds the question
// it echoes to the model.
const MAX_QUESTION_ITEM_ID_BYTES = 512;
const MAX_REPLY_QUESTION_BYTES = 512;

export type CodexAsyncQuestion = {
  title: string;
  options: string[] | null;
};

export type CodexAsyncQuestionReply = {
  questionItemId: string;
  question: string;
  answer: string;
};

export function codexAsyncQuestionItemId(messageId: string, index: number): string {
  return JSON.stringify([CODEX_ASYNC_QUESTION_TOOL_NAME, messageId, index]);
}

/**
 * Builds the user-message text that answers one or more async questions.
 * Returns undefined when no reply carries a non-empty answer.
 */
export function formatCodexAsyncQuestionReply(
  replies: readonly CodexAsyncQuestionReply[],
): string | undefined {
  const entries = replies.flatMap((reply) => {
    const answer = reply.answer.trim();
    if (!answer || utf8Length(reply.questionItemId) > MAX_QUESTION_ITEM_ID_BYTES) {
      return [];
    }
    return [{
      answer,
      question: truncateUtf8(reply.question, MAX_REPLY_QUESTION_BYTES).replace(/[\r\n]/g, " "),
      questionItemId: reply.questionItemId,
    }];
  });
  if (entries.length === 0) {
    return undefined;
  }
  return `${REPLY_OPEN}\n${JSON.stringify(entries)}\n${REPLY_CLOSE}`;
}

/**
 * Reads a reply envelope back out of user-message text. Only a complete
 * envelope is interpreted, optionally after Codex's IDE context prefix.
 */
export function parseCodexAsyncQuestionReply(
  text: string,
): CodexAsyncQuestionReply[] | undefined {
  let body = text.trim();
  if (body.startsWith(IDE_CONTEXT_PREFIX)) {
    const markerIndex = body.lastIndexOf(IDE_REQUEST_MARKER);
    if (markerIndex < 0) {
      return undefined;
    }
    body = body.slice(markerIndex + IDE_REQUEST_MARKER.length).trim();
  }
  if (!body.startsWith(REPLY_OPEN) || !body.endsWith(REPLY_CLOSE)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(REPLY_OPEN.length, body.length - REPLY_CLOSE.length));
  } catch {
    return undefined;
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const replies: CodexAsyncQuestionReply[] = [];
  for (const value of values) {
    const record = value && typeof value === "object"
      ? value as Record<string, unknown>
      : undefined;
    if (
      !record
      || typeof record.questionItemId !== "string"
      || typeof record.question !== "string"
      || typeof record.answer !== "string"
    ) {
      return undefined;
    }
    replies.push({
      questionItemId: record.questionItemId,
      question: record.question,
      answer: record.answer,
    });
  }
  return replies.length > 0 ? replies : undefined;
}

/**
 * True when a reply answered this question. Older Codex Desktop replies name
 * the whole source message instead of one question, so either identity counts.
 */
export function isCodexAsyncQuestionAnswered(
  answeredIds: ReadonlySet<string>,
  messageId: string,
  index: number,
): boolean {
  return answeredIds.has(codexAsyncQuestionItemId(messageId, index))
    || answeredIds.has(messageId);
}

// Codex measures these limits in UTF-8 bytes. This package has neither DOM
// nor Node types, so count code points by hand instead of using TextEncoder.
function utf8CodePointLength(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    bytes += utf8CodePointLength(char.codePointAt(0) ?? 0);
  }
  return bytes;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = utf8CodePointLength(char.codePointAt(0) ?? 0);
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}
