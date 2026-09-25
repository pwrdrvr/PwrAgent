import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationInboundConditionGroup } from "@pwragent/shared";
import { AutomationConditionEditor } from "../AutomationConditionEditor";

afterEach(() => {
  cleanup();
});

const GROUP: AutomationInboundConditionGroup = {
  join: "any",
  conditions: [
    {
      id: "condition-sender",
      field: "sender",
      operator: "is_one_of",
      values: ["U0SPINNAKER", "U0DATADOG"],
    },
    {
      id: "condition-text",
      field: "message_text",
      operator: "contains",
      values: ["ERROR"],
    },
  ],
};

function renderEditor(group: AutomationInboundConditionGroup = GROUP) {
  return render(
    <AutomationConditionEditor
      conversationId="C0ALERTS"
      group={group}
      observedSenders={[]}
      provider="slack"
      senderLabels={{ U0DATADOG: "Datadog", U0SPINNAKER: "spinnaker" }}
      onChange={() => undefined}
      onSenderLabelsChange={() => undefined}
    />,
  );
}

describe("AutomationConditionEditor", () => {
  it("draws each condition as its own card, joined by the group's word", () => {
    const { container } = renderEditor();

    const conditions = container.querySelectorAll(".automation-condition");
    expect(conditions).toHaveLength(2);
    for (const condition of conditions) {
      expect(
        condition.querySelectorAll(":scope > .automation-condition__card"),
      ).toHaveLength(1);
    }
    // The joiner sits between two cards, so the first has none.
    expect(
      conditions[0]?.querySelector(".automation-condition__joiner"),
    ).toBeNull();
    expect(
      conditions[1]?.querySelector(".automation-condition__joiner"),
    ).toHaveTextContent("or");
  });

  it("gives every control the field chrome", () => {
    const { container } = renderEditor();

    // An unclassed control falls back to Chromium's native grey field.
    for (const control of container.querySelectorAll(
      ".automation-condition__card select, .automation-condition__card input",
    )) {
      expect(
        control.classList.contains("automation-condition__select")
        || control.classList.contains("automation-condition__input")
        || control.classList.contains("automation-sender-picker__input"),
      ).toBe(true);
    }
  });

  it("keeps picked senders inside the field and focuses its input from the padding", () => {
    const { container } = renderEditor();

    const field = container.querySelector(".automation-sender-picker__field");
    expect(field).not.toBeNull();
    expect(field).toContainElement(
      screen.getByRole("button", { name: "Remove spinnaker" }),
    );
    // Selects are comboboxes too, so the sender input is found by its class.
    const input = container.querySelector<HTMLInputElement>(
      "input.automation-sender-picker__input",
    );
    expect(field).toContainElement(input);
    expect(input).toHaveAttribute("placeholder", "Add another…");

    expect(input).toHaveAccessibleName("Add a sender");

    fireEvent.mouseDown(field!);
    expect(input).toHaveFocus();

    // The blank end of a wrapped chip line belongs to the chip list, not the
    // field, and still reads as part of the text box.
    input!.blur();
    fireEvent.mouseDown(
      container.querySelector(".automation-sender-picker__chips")!,
    );
    expect(input).toHaveFocus();

    // A chip's remove button keeps its own press.
    input!.blur();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Remove Datadog" }));
    expect(input).not.toHaveFocus();
  });

  it("offers the full search hint before any sender is picked", () => {
    const { container } = renderEditor({
      join: "all",
      conditions: [
        { id: "condition-sender", field: "sender", operator: "is_one_of", values: [] },
      ],
    });

    expect(
      container.querySelector("input.automation-sender-picker__input"),
    ).toHaveAttribute(
      "placeholder",
      "Add a sender — search people, bots, or apps…",
    );
  });
});
