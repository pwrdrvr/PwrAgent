import { describe, expect, it } from "vitest";
import type { AppServerThreadMessageEntry } from "@pwragent/shared";
import { buildTranscriptRenderItems } from "../transcript-render-items";
import { injectQuestionnaireActivities } from "../questionnaire-activity-entries";

describe("questionnaire activity transcript entries", () => {
  it("hydrates answered questionnaires into collapsed previous work", () => {
    const finalAnswer: AppServerThreadMessageEntry = {
      type: "message",
      id: "final-1",
      role: "assistant",
      phase: "final",
      text: "Breakfast is ready.",
      createdAt: 3_000,
      turn: {
        id: "turn-1",
        status: "completed",
        completedAt: 3_000,
      },
    };

    const entries = injectQuestionnaireActivities([finalAnswer], [
      {
        id: "questionnaire:request-1",
        requestId: "request-1",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "submitted",
        createdAt: 1_000,
        updatedAt: 2_000,
        questions: [
          {
            id: "food",
            header: "Food",
            question: "What should breakfast feature?",
            isOther: true,
          },
          {
            id: "drink",
            header: "Drink",
            question: "What should fill the cup?",
            isOther: true,
          },
        ],
        answers: {
          food: { answers: ["Waffles"] },
          drink: { answers: ["Coffee"] },
        },
      },
    ]);

    expect(entries[0]).toMatchObject({
      type: "activity",
      id: "questionnaire:request-1",
      summary: "Questionnaire answered",
      status: "completed",
      details: [
        {
          label: "Submitted answers",
          markdown:
            "1. Food: What should breakfast feature?\nAnswer: Waffles\n\n2. Drink: What should fill the cup?\nAnswer: Coffee",
        },
      ],
    });

    const renderItems = buildTranscriptRenderItems({ entries });
    expect(renderItems).toMatchObject([
      {
        type: "workPhaseGroup",
        label: "Previous work",
        entries: [
          {
            id: "questionnaire:request-1",
          },
        ],
      },
      {
        type: "entry",
        entry: finalAnswer,
      },
    ]);
  });
});
