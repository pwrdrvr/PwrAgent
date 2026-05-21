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
});
