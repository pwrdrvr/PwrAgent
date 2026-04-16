import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { TranscriptList } from "../TranscriptList";

describe("TranscriptList", () => {
  it("renders transcript history and exposes incremental history loading when available", () => {
    const loadOlder = vi.fn(async () => undefined);

    render(
      <TranscriptList
        loading={false}
        loadingMore={false}
        messages={[
          {
            id: "message-1",
            role: "user",
            text: "Open [`ce:work`](/Users/huntharo/.codex/skills/ce-work/SKILL.md)\n\n- Check Unit 4\n- Keep Unit 3 isolated"
          },
          {
            id: "message-2",
            role: "assistant",
            text: "The desktop shell is live.\n\nRun `pnpm test -- --project desktop-renderer` next."
          }
        ]}
        pagination={{
          supportsPagination: true,
          hasPreviousPage: true,
          previousCursor: "cursor-1"
        }}
        onLoadOlder={loadOlder}
      />
    );

    expect(screen.getByRole("link", { name: "`ce:work`" })).toHaveAttribute(
      "href",
      "file:///Users/huntharo/.codex/skills/ce-work/SKILL.md"
    );
    expect(screen.getByText("Check Unit 4")).toBeInTheDocument();
    expect(screen.getByText("Keep Unit 3 isolated")).toBeInTheDocument();
    expect(screen.getByText("pnpm test -- --project desktop-renderer")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "`ce:work`" }).closest("article")
    ).toHaveClass("transcript-message--user");
    expect(
      screen.getByText("pnpm test -- --project desktop-renderer").closest("article")
    ).toHaveClass("transcript-message--assistant");

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));

    expect(loadOlder).toHaveBeenCalledTimes(1);
  });
});
