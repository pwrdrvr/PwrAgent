import { describe, expect, it } from "vitest";
import type { AppServerToolRequestUserInputNotification } from "@pwragent/shared";
import {
  answerQuestionnaireOption,
  answerQuestionnaireText,
  buildQuestionnaireResponse,
  canAdvanceQuestionnaire,
  canSubmitQuestionnaire,
  createQuestionnaireState,
  goToNextQuestion,
  goToPreviousQuestion,
} from "../questionnaire";

function buildRequest(
  questions: AppServerToolRequestUserInputNotification["params"]["questions"]
): AppServerToolRequestUserInputNotification {
  return {
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "input-1",
      requestId: "input-request-1",
      questions,
    },
  };
}

describe("questionnaire helpers", () => {
  it("formats selected option answers for the Codex request_user_input response shape", () => {
    const state = createQuestionnaireState(
      buildRequest([
        {
          id: "approach",
          header: "Approach",
          question: "Which path should I take?",
          isOther: false,
          isSecret: false,
          options: [
            {
              label: "Small patch (Recommended)",
              description: "Keep this scoped."
            },
            {
              label: "Large refactor",
              description: "Touch adjacent flows."
            }
          ]
        }
      ])
    );

    expect(state).toBeDefined();
    const answered = answerQuestionnaireOption(state!, "A");

    expect(canSubmitQuestionnaire(answered)).toBe(true);
    expect(buildQuestionnaireResponse(answered)).toEqual({
      answers: {
        approach: {
          answers: ["Small patch (Recommended)"]
        }
      }
    });
  });

  it("preserves answers while navigating backward and forward", () => {
    const state = createQuestionnaireState(
      buildRequest([
        {
          id: "scope",
          header: "Scope",
          question: "How much should change?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Small", description: "One component." },
            { label: "Large", description: "Multiple components." }
          ]
        },
        {
          id: "tests",
          header: "Tests",
          question: "Which test path?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Unit only", description: "Fast coverage." },
            { label: "Unit and E2E", description: "Full path." }
          ]
        }
      ])
    );

    const firstAnswer = answerQuestionnaireOption(state!, "B");
    expect(canAdvanceQuestionnaire(firstAnswer)).toBe(true);

    const secondQuestion = goToNextQuestion(firstAnswer);
    const secondAnswer = answerQuestionnaireOption(secondQuestion, "A");
    const backToFirst = goToPreviousQuestion(secondAnswer);
    const forwardAgain = goToNextQuestion(backToFirst);

    expect(backToFirst.answers[0]).toMatchObject({
      kind: "option",
      optionKey: "B",
      value: "Large"
    });
    expect(forwardAgain.answers[1]).toMatchObject({
      kind: "option",
      optionKey: "A",
      value: "Unit only"
    });
    expect(canSubmitQuestionnaire(forwardAgain)).toBe(true);
  });

  it("requires non-empty free-form answers before submitting", () => {
    const state = createQuestionnaireState(
      buildRequest([
        {
          id: "other",
          header: "Other",
          question: "What should I do instead?",
          isOther: true,
          isSecret: false,
          options: null
        }
      ])
    );

    expect(state).toBeDefined();
    expect(canSubmitQuestionnaire(state!)).toBe(false);
    expect(canSubmitQuestionnaire(answerQuestionnaireText(state!, "   "))).toBe(false);

    const answered = answerQuestionnaireText(state!, "Use the smaller implementation.");
    expect(canSubmitQuestionnaire(answered)).toBe(true);
    expect(buildQuestionnaireResponse(answered)).toEqual({
      answers: {
        other: {
          answers: ["Use the smaller implementation."]
        }
      }
    });
  });

  it("rejects malformed requests without valid questions", () => {
    expect(createQuestionnaireState(buildRequest([]))).toBeUndefined();
    expect(
      createQuestionnaireState(
        buildRequest([
          {
            id: "missing-options",
            header: "Missing options",
            question: "This cannot be answered.",
            isOther: false,
            isSecret: false,
            options: null
          }
        ])
      )
    ).toBeUndefined();
  });
});
