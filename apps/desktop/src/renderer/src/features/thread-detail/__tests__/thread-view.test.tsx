import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ThreadView } from "../ThreadView";

describe("ThreadView", () => {
  it("renders a directory-less thread with transcript history and context", () => {
    render(
      <ThreadView
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              readThread: true,
              startTurn: false,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            }
          },
          {
            kind: "grok",
            label: "Grok app server",
            available: false,
            methods: [],
            capabilities: {
              listThreads: false,
              createThread: false,
              resumeThread: false,
              readThread: false,
              startTurn: false,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: false,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: false
            },
            unavailableReason: "XAI_API_KEY is not set"
          }
        ]}
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
    fireEvent.click(screen.getByRole("button", { name: "Open context rail" }));

    expect(screen.getByText("No linked directory")).toBeInTheDocument();
    expect(
      screen.getByText("The desktop client now reads the full transcript.")
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Thread details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin context rail" })).toBeInTheDocument();
    expect(screen.getByText("Codex app server")).toBeInTheDocument();
    expect(screen.getByText("Grok app server")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});
