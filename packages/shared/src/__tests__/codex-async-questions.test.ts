import { describe, expect, it } from "vitest";
import {
  codexAsyncQuestionItemId,
  formatCodexAsyncQuestionReply,
  isCodexAsyncQuestionAnswered,
  parseCodexAsyncQuestionReply,
} from "../codex-async-questions";

describe("Codex async question replies", () => {
  it("names a question the way Codex clients do", () => {
    expect(codexAsyncQuestionItemId("audience-question", 0)).toBe(
      "[\"request_user_input_async\",\"audience-question\",0]",
    );
  });

  it("formats the envelope Codex records for an answered question", () => {
    // Codex's astra_async_question_and_answer scenario sends this exact text.
    expect(formatCodexAsyncQuestionReply([{
      questionItemId: codexAsyncQuestionItemId("audience-question", 0),
      question: "Who should receive the launch update?",
      answer: "Customers",
    }])).toBe(
      "<send_user_message_question_reply>\n"
      + "[{\"answer\":\"Customers\",\"question\":\"Who should receive the launch update?\","
      + "\"questionItemId\":\"[\\\"request_user_input_async\\\",\\\"audience-question\\\",0]\"}]\n"
      + "</send_user_message_question_reply>",
    );
  });

  it("batches answers, trims them, and skips blank ones", () => {
    const text = formatCodexAsyncQuestionReply([
      { questionItemId: "one", question: "First?", answer: "  Yes \n" },
      { questionItemId: "two", question: "Second?", answer: "   " },
      { questionItemId: "three", question: "Third?", answer: "No" },
    ]);
    expect(parseCodexAsyncQuestionReply(text ?? "")).toEqual([
      { questionItemId: "one", question: "First?", answer: "Yes" },
      { questionItemId: "three", question: "Third?", answer: "No" },
    ]);
    expect(formatCodexAsyncQuestionReply([
      { questionItemId: "one", question: "First?", answer: " " },
    ])).toBeUndefined();
  });

  it("bounds the echoed question and flattens its line breaks", () => {
    const text = formatCodexAsyncQuestionReply([{
      questionItemId: "one",
      question: `Line one\nLine two ${"é".repeat(400)}`,
      answer: "Yes",
    }]);
    const [reply] = parseCodexAsyncQuestionReply(text ?? "") ?? [];
    // 18 ASCII bytes, then as many 2-byte "é" as fit in the remaining 494.
    expect(reply?.question).toBe(`Line one Line two ${"é".repeat(247)}`);
  });

  it("reads single, batched, and IDE-prefixed envelopes", () => {
    const one = "{\"questionItemId\":\"one\",\"question\":\"First?\",\"answer\":\"Yes\",\"extra\":true}";
    const expected = [{ questionItemId: "one", question: "First?", answer: "Yes" }];
    for (const payload of [one, `[${one}]`]) {
      expect(parseCodexAsyncQuestionReply(
        ` \n<send_user_message_question_reply>\n${payload}\n</send_user_message_question_reply>\n `,
      )).toEqual(expected);
    }
    expect(parseCodexAsyncQuestionReply(
      "# Context from my IDE setup:\n\n## Open tabs:\n- a.ts\n\n## My request for Codex:\n"
      + `<send_user_message_question_reply>${one}</send_user_message_question_reply>`,
    )).toEqual(expected);
  });

  it("leaves malformed or embedded envelopes as ordinary text", () => {
    for (const text of [
      "> Which environment?\n\nStaging",
      "<send_user_message_question_reply>[]</send_user_message_question_reply>",
      "<send_user_message_question_reply>[{\"questionItemId\":\"one\",\"question\":\"First?\",\"answer\":\"Yes\"},null]</send_user_message_question_reply>",
      "Quoted: <send_user_message_question_reply>{\"questionItemId\":\"one\",\"question\":\"First?\",\"answer\":\"Yes\"}</send_user_message_question_reply>",
      "<send_user_message_question_reply>{\"questionItemId\":\"one\",\"question\":\"First?\",\"answer\":\"Yes\"}</send_user_message_question_reply> trailing text",
    ]) {
      expect(parseCodexAsyncQuestionReply(text)).toBeUndefined();
    }
  });

  it("treats a reply to the whole source message as answering each question", () => {
    const answered = new Set([codexAsyncQuestionItemId("call_a", 1), "call_b"]);
    expect(isCodexAsyncQuestionAnswered(answered, "call_a", 0)).toBe(false);
    expect(isCodexAsyncQuestionAnswered(answered, "call_a", 1)).toBe(true);
    expect(isCodexAsyncQuestionAnswered(answered, "call_b", 3)).toBe(true);
  });
});
