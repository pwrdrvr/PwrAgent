import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  AppServerToolRequestUserInputNotification,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  answerQuestionnaireOption,
  answerQuestionnaireText,
  buildQuestionnaireResponse,
  canAdvanceQuestionnaire,
  canSubmitQuestionnaire,
  createQuestionnaireState,
  goToNextQuestion,
  goToPreviousQuestion,
  toggleQuestionnaireOption,
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
  it("answers a multi-select question with every chosen label and the Other text (model)", () => {
    const labels = ["Apple", "Pear", "Plum", "Fig"];
    const step = fc.oneof(
      fc.record({ kind: fc.constant("toggle" as const), index: fc.nat({ max: labels.length - 1 }) }),
      fc.record({ kind: fc.constant("text" as const), text: fc.constantFrom("", "  ", "Kiwi", " Kiwi ") }),
    );
    fc.assert(fc.property(fc.array(step, { maxLength: 12 }), (steps) => {
      let state = createQuestionnaireState(buildRequest([{
        id: "fruits", header: "", question: "Pick fruits", isOther: true, isSecret: false, multiSelect: true,
        options: labels.map((label) => ({ label, description: "" })),
      }]))!;
      // Model: a set of chosen options and the last Other text.
      const chosen = new Set<number>();
      let text = "";
      for (const next of steps) {
        if (next.kind === "toggle") {
          state = toggleQuestionnaireOption(state, state.questions[0]!.options[next.index]!.key);
          if (chosen.has(next.index)) chosen.delete(next.index);
          else chosen.add(next.index);
        } else {
          state = answerQuestionnaireText(state, next.text);
          text = next.text;
        }
      }
      const expected = [
        ...labels.filter((_, index) => chosen.has(index)),
        ...(text.trim() ? [text.trim()] : []),
      ];
      expect(state.currentIndex).toBe(0);
      expect(canSubmitQuestionnaire(state)).toBe(expected.length > 0);
      expect(buildQuestionnaireResponse(state).answers.fruits?.answers).toEqual(expected);
    }));
  });

  it("keeps a single-select question's toggle a no-op", () => {
    const state = createQuestionnaireState(buildRequest([{
      id: "color", header: "", question: "Pick a color", isOther: false, isSecret: false,
      options: [{ label: "Red", description: "" }],
    }]))!;
    expect(state.questions[0]?.multiSelect).toBe(false);
    expect(toggleQuestionnaireOption(state, "A")).toBe(state);
  });

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
