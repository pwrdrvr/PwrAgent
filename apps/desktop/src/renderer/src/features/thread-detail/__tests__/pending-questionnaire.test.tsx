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
    turnId: "turn-1",
    itemId: "input-1",
    requestId: "input-request-1",
    currentIndex: 0,
    phase: "answering",
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

function buildFreeformState(): PendingQuestionnaireState {
  return {
    method: "item/tool/requestUserInput",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "input-1",
    requestId: "input-request-1",
    currentIndex: 0,
    phase: "answering",
    answers: [null],
    questions: [
      {
        id: "breakfast",
        header: "Breakfast",
        question: "What's for breakfast?",
        options: [],
        allowFreeform: true,
        secret: false,
      },
    ],
  };
}

describe("PendingQuestionnaire", () => {
  it("lets a multi-select question take several options and Other before moving on", () => {
    const onSubmit = vi.fn();
    let state: PendingQuestionnaireState = {
      ...buildState(),
      questions: [{
        id: "fruits",
        header: "",
        question: "Pick fruits",
        options: ["Apple", "Pear", "Plum"].map((label, index) => ({
          key: String.fromCharCode(65 + index), label, description: "", recommended: false,
        })),
        allowFreeform: true,
        multiSelect: true,
        secret: false,
      }],
      answers: [null],
    };
    const view = () => (
      <PendingQuestionnaire state={state} onChange={(next) => { state = next; }} onSubmit={onSubmit} />
    );
    const { rerender } = render(view());

    expect(screen.getByText("Choose any that apply.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Apple/ }));
    rerender(view());
    fireEvent.click(screen.getByRole("button", { name: /Plum/ }));
    rerender(view());
    fireEvent.change(screen.getByRole("textbox", { name: "Other answer" }), { target: { value: "Kiwi" } });
    rerender(view());

    // Choosing never submitted the last question on the operator's behalf.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Apple/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Pear/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /Plum/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "Other answer" })).toHaveValue("Kiwi");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith(state);
  });

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
    // The badge marks the recommendation once; the label drops the marker.
    expect(screen.getByText("Small patch")).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.queryByText(/\(Recommended\)/)).not.toBeInTheDocument();
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
    expect(screen.getByText("Question 2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Question 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Large refactor/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: /Unit only/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        answers: [
          expect.objectContaining({ kind: "option", optionKey: "B" }),
          expect.objectContaining({ kind: "option", optionKey: "A" }),
        ],
      })
    );
  });

  it("keeps freeform answers compact and caps autosizing growth", () => {
    const onChange = vi.fn();
    render(
      <PendingQuestionnaire
        state={buildFreeformState()}
        onChange={onChange}
        onSubmit={async () => undefined}
      />,
    );

    const textarea = screen.getByLabelText("Other answer") as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute("rows", "1");

    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 400,
    });
    fireEvent.change(textarea, {
      target: {
        value: "Line one\nLine two\nLine three\nLine four\nLine five",
      },
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(textarea.style.overflowY).toBe("auto");
    expect(Number.parseFloat(textarea.style.height)).toBeLessThan(120);
  });
});
