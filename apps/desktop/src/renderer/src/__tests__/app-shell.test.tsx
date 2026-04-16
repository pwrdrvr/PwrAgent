import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { App } from "../App";

describe("App", () => {
  it("renders the live thread shell with transcript history", async () => {
    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        ping: () => "pong",
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
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
              available: true,
              methods: ["thread/list", "thread/read"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: true,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: false
              }
            }
          ]
        }),
        getNavigationSnapshot: async () => ({
          backend: "codex",
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadIds: ["thread-1"],
          threads: [
            {
              id: "thread-1",
              title: "Build Codex client",
              summary: "Wire the app-server transport and list threads",
              source: "codex",
              gitBranch: "codex/build-codex-client",
              linkedDirectories: [
                {
                  id: "/Users/huntharo/pwrdrvr/PwrAgnt",
                  label: "PwrAgnt",
                  path: "/Users/huntharo/pwrdrvr/PwrAgnt",
                  kind: "worktree"
                }
              ],
              inbox: {
                inInbox: true,
                reason: "new-thread",
              },
              updatedAt: Date.now()
            }
          ]
        }),
        markThreadSeen: async () => ({
          backend: "codex",
          threadId: "thread-1",
          seenAt: Date.now(),
        }),
        onWindowFocus: () => () => undefined,
        readThread: async () => ({
          backend: "codex",
          fetchedAt: Date.now(),
          threadId: "thread-1",
          replay: {
            messages: [
              {
                id: "message-1",
                role: "user",
                text: "Open the desktop plan and build the Codex client."
              },
              {
                id: "message-2",
                role: "assistant",
                text: "The Codex client is wired and the thread browser is live."
              }
            ],
            lastUserMessage: "Open the desktop plan and build the Codex client.",
            lastAssistantMessage:
              "The Codex client is wired and the thread browser is live.",
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false
            }
          }
        }),
        platform: "darwin",
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Threads" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Inbox" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "recents" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh threads" })
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Build Codex client"
      })
    ).toBeInTheDocument();
    const inboxHeading = screen.getByRole("heading", { level: 2, name: "Inbox" });
    const inboxSection = inboxHeading.closest("section");
    expect(inboxSection).not.toBeNull();
    expect(within(inboxSection as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(screen.getAllByText("PwrAgnt").length).toBeGreaterThan(0);
    expect(screen.getAllByText("codex/build-codex-client").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 3, name: "Transcript" })).toBeInTheDocument();
    expect(
      await screen.findByText("Open the desktop plan and build the Codex client.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("The Codex client is wired and the thread browser is live.")
    ).toBeInTheDocument();
    const openContextButton = screen.getByRole("button", { name: "Open context rail" });
    openContextButton.click();
    expect(
      await screen.findByRole("heading", { level: 3, name: "Thread details" })
    ).toBeInTheDocument();
    expect(screen.getByText("Codex app server")).toBeInTheDocument();
    expect(screen.getByText("Grok app server")).toBeInTheDocument();
    expect(screen.getByText("darwin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});
