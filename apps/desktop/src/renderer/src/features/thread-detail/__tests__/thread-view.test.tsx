import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { ThreadView } from "../ThreadView";

describe("ThreadView", () => {
  it("renders a directory-less thread with transcript history and context", () => {
    render(
      <ThreadView
        fetchedAt={Date.now()}
        loading={false}
        loadingMore={false}
        messageCount={2}
        platform="darwin"
        selectedThread={{
          id: "thread-2",
          title: "Plan the app-server protocol",
          summary: "Inspect Codex thread/read output and normalize it for desktop.",
          source: "codex",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
        transcriptMessages={[
          {
            id: "message-1",
            role: "user",
            text: "Inspect the app-server output."
          },
          {
            id: "message-2",
            role: "assistant",
            text: "The desktop client now reads the full transcript."
          }
        ]}
        onLoadOlder={async () => undefined}
        onRefresh={async () => undefined}
      />
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Plan the app-server protocol" })
    ).toBeInTheDocument();
    expect(screen.getByText("No linked directory")).toBeInTheDocument();
    expect(
      screen.getByText("The desktop client now reads the full transcript.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpin context rail" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});
