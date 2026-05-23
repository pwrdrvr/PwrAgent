import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { ThreadHeader } from "../ThreadHeader";

afterEach(() => {
  cleanup();
});

const thread: NavigationThreadSummary = {
  id: "thread-1",
  title: "AI API Rate Limiting",
  titleSource: "explicit",
  source: "codex",
  executionMode: "default",
  updatedAt: Date.now(),
  linkedDirectories: [],
  inbox: {
    inInbox: true,
  },
};

describe("ThreadHeader", () => {
  it("renders the project breadcrumb and reveals the selected row from title click", () => {
    const onRevealSelectedThreadInList = vi.fn();

    render(
      <ThreadHeader
        projectLabel="PwrSnap"
        thread={thread}
        onRevealSelectedThreadInList={onRevealSelectedThreadInList}
      />,
    );

    expect(screen.getByText("PwrSnap")).toHaveClass("thread-header__eyebrow");
    expect(
      screen.getByRole("heading", { level: 2, name: "AI API Rate Limiting" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show selected thread in thread list",
      }),
    );

    expect(onRevealSelectedThreadInList).toHaveBeenCalledOnce();
  });

  it("shows the Agent marker when the selected thread has persona metadata", () => {
    render(
      <ThreadHeader
        thread={{
          ...thread,
          agent: {
            name: "Inbox Triage",
            instructions: "Keep updates concise.",
            instructionLineCount: 1,
            instructionsTooLong: false,
            updatedAt: 1_000,
          },
        }}
      />,
    );

    const chip = screen.getByText("Agent: Inbox Triage");
    expect(chip).toHaveClass("chip--mode");
    expect(chip).toHaveAttribute("title", "Inbox Triage, 1 instruction line");
  });
});
