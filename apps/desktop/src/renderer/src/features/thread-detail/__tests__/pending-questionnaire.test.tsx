import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingQuestionnaireState } from "../questionnaire";
import { PendingQuestionnaire } from "../PendingQuestionnaire";

afterEach(() => {
  cleanup();
});

function buildState(): PendingQuestionnaireState {
  return {
    method: "item/tool/requestUserInput",
    threadId: "thread-1",
    runId: "turn-1",
    turnId: "turn-1",
    itemId: "input-1",
    requestId: "input-request-1",
    currentIndex: 0,
    answers: [null, null],
    questions: [
      {
        id: "scope",
        header: "Scope",
        question: "How much should change?",
        options: [
          {
            key: "A",
            label: "Small patch (Recommended)",
            description: "Keep this scoped.",
            recommended: true,
          },
          {
            key: "B",
            label: "Large refactor",
            description: "Touch adjacent flows.",
            recommended: false,
          },
        ],
        allowFreeform: false,
        secret: false,
      },
      {
        id: "tests",
        header: "Tests",
        question: "Which test path?",
        options: [
          {
            key: "A",
            label: "Unit only",
            description: "Fast coverage.",
            recommended: false,
          },
          {
            key: "B",
            label: "Unit and E2E",
            description: "Full path.",
            recommended: false,
          },
        ],
        allowFreeform: false,
        secret: false,
      },
    ],
  };
}

describe("PendingQuestionnaire", () => {
  it("renders plan questions without approval controls", () => {
    render(
      <PendingQuestionnaire
        state={buildState()}
        onChange={() => undefined}
        onSubmit={async () => undefined}
      />
    );

    expect(screen.getByRole("group", { name: "Pending input" })).toBeInTheDocument();
    expect(screen.getByText("Question 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Small patch (Recommended)")).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeInTheDocument();
  });

  it("emits changed state for option selection and navigation", () => {
    let state = buildState();
    const onChange = vi.fn((next: PendingQuestionnaireState) => {
      state = next;
      rerenderQuestionnaire();
    });
    const onSubmit = vi.fn(async () => undefined);
    const { rerender } = render(
      <PendingQuestionnaire state={state} onChange={onChange} onSubmit={onSubmit} />
    );
    const rerenderQuestionnaire = () => {
      rerender(
        <PendingQuestionnaire state={state} onChange={onChange} onSubmit={onSubmit} />
      );
    };

    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Large refactor/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: /Unit only/ }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByText("Question 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Large refactor/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
