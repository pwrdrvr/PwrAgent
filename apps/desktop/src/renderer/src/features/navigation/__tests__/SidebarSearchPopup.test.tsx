import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { SidebarSearchPopup } from "../SidebarSearchPopup";

describe("SidebarSearchPopup", () => {
  it("finds Agent threads by role and marks the result", () => {
    const threads: NavigationThreadSummary[] = [
      {
        id: "agent-1",
        title: "Housekeeping",
        titleSource: "explicit",
        source: "codex",
        inbox: { inInbox: true },
        linkedDirectories: [],
        agent: {
          name: "Jeeves",
          instructions: "Help people decide what to do next.",
          instructionLineCount: 1,
          instructionsTooLong: false,
          updatedAt: 1_000,
        },
      },
    ];

    render(
      <SidebarSearchPopup
        threads={threads}
        onJumpToThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), {
      target: { value: "Agent" },
    });

    expect(screen.getByText("Housekeeping")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent thread")).toHaveTextContent("Agent");
  });
});
