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
            text: "Show me the current desktop thread shell"
          },
          {
            id: "message-2",
            role: "assistant",
            text: "The desktop shell is live and listing Codex threads."
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

    expect(screen.getByText("Show me the current desktop thread shell")).toBeInTheDocument();
    expect(
      screen.getByText("The desktop shell is live and listing Codex threads.")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));

    expect(loadOlder).toHaveBeenCalledTimes(1);
  });
});
