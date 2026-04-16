import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { App } from "../App";

describe("App", () => {
  it("renders the live recent-thread shell", async () => {
    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        ping: () => "pong",
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
            lastUserMessage: "Open the desktop plan and build the Codex client.",
            lastAssistantMessage:
              "The Codex client is wired and the thread browser is live."
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
    expect(screen.getByText("codex/build-codex-client")).toBeInTheDocument();
    expect(screen.getByText(/1 linked directory/i)).toBeInTheDocument();
    expect(
      await screen.findByText("Open the desktop plan and build the Codex client.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("The Codex client is wired and the thread browser is live.")
    ).toBeInTheDocument();
    expect(screen.getByText("darwin")).toBeInTheDocument();
  });
});
