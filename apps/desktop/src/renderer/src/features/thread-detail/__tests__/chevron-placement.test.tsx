import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadActivityEntry } from "@pwragent/shared";
import { TranscriptActivity } from "../TranscriptActivity";
import { TranscriptWorkPhaseGroup } from "../TranscriptWorkPhaseGroup";

afterEach(cleanup);

const activityEntry: AppServerThreadActivityEntry = {
  type: "activity",
  id: "activity-1",
  summary: "Turn usage",
  // A detail makes the entry collapsible, so the toggle + chevron render.
  details: [{ id: "detail-1", kind: "read", label: "read a file" }],
};

describe("transcript disclosure chevron placement", () => {
  it("renders the activity chevron before its label (left of the label)", () => {
    const { container } = render(<TranscriptActivity entry={activityEntry} />);

    const toggle = container.querySelector(".transcript-activity__toggle");
    expect(toggle).not.toBeNull();

    const children = [...(toggle as HTMLElement).children];
    expect(children[0]).toHaveClass("transcript-activity__chevron");
    expect(children[1]).toHaveClass("transcript-activity__label");
  });

  it("renders the previous-messages chevron as an empty element before the label", () => {
    const { container } = render(
      <TranscriptWorkPhaseGroup
        collapsible
        expanded={false}
        label="3 previous messages"
        entries={[]}
        skills={[]}
        onToggle={vi.fn()}
      />
    );

    const toggle = container.querySelector(".transcript-work-phase-group__toggle");
    expect(toggle).not.toBeNull();

    const children = [...(toggle as HTMLElement).children];
    // Chevron is the first child (left of the label).
    expect(children[0]).toHaveClass("transcript-work-phase-group__chevron");
    // Migrated off the literal "v"/"^" text glyph to a CSS border chevron,
    // so the element carries no text of its own.
    expect(children[0]?.textContent).toBe("");
    expect((toggle as HTMLElement).textContent).toContain("3 previous messages");
  });

  it("does not repeat a single tool label before its command output", () => {
    render(
      <TranscriptActivity
        entry={{
          type: "activity",
          id: "grep-1",
          summary: "grep",
          details: [
            {
              id: "grep-1:detail",
              kind: "command",
              label: "grep",
              command: {
                displayCommand: "tool call update",
                output: "found 20 matches",
              },
            },
          ],
        }}
      />
    );

    expect(screen.getAllByText("grep")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "grep" }));

    expect(screen.getAllByText("grep")).toHaveLength(1);
    expect(screen.getByText("$ tool call update")).toBeInTheDocument();
    expect(screen.getByText("found 20 matches")).toBeInTheDocument();
  });
});
