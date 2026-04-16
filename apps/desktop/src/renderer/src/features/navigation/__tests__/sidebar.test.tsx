import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { within } from "@testing-library/react";
import { vi } from "vitest";
import { Sidebar } from "../Sidebar";

const sharedThread = {
  id: "thread-1",
  title: "Cross-project cleanup",
  summary: "Line up the desktop shell with the app server",
  source: "codex" as const,
  gitBranch: "codex/thread-centric-ui",
  updatedAt: Date.now(),
  inbox: {
    inInbox: true,
    reason: "new-thread" as const
  },
  linkedDirectories: [
    {
      id: "dir-a",
      label: "PwrAgnt",
      path: "/Users/huntharo/pwrdrvr/PwrAgnt",
      worktreePath: "/Users/huntharo/.codex/worktrees/0f38/PwrAgnt",
      kind: "local" as const
    },
    {
      id: "dir-b",
      label: "openclaw-codex-app-server",
      path: "/Users/huntharo/pwrdrvr/openclaw-codex-app-server",
      kind: "worktree" as const
    }
  ]
};

describe("Sidebar", () => {
  it("keeps Inbox first and groups a thread under each linked directory lens", () => {
    render(
      <Sidebar
        browseMode="directories"
        fetchedAt={Date.now()}
        inboxThreads={[sharedThread]}
        loading={false}
        refreshing={false}
        selectedThreadId="thread-1"
        threads={[
          sharedThread,
          {
            id: "thread-2",
            title: "Unlinked planning thread",
            summary: undefined,
            source: "codex",
            updatedAt: Date.now(),
            inbox: {
              inInbox: false
            },
            linkedDirectories: []
          }
        ]}
        onBrowseModeChange={() => undefined}
        onRefresh={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["Inbox", "Browse"]);
    expect(screen.getByRole("button", { name: "directories" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("heading", { level: 3, name: "PwrAgnt" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 3, name: "openclaw-codex-app-server" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 3, name: "No linked directory" })
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("heading", { level: 3, name: "PwrAgnt" })).getByText("📁")
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Cross-project cleanup/i })).toHaveLength(2);
  });

  it("copies a linked directory path from the recents chip", () => {
    const copyText = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        copyText
      }
    });

    render(
      <Sidebar
        browseMode="recents"
        fetchedAt={Date.now()}
        inboxThreads={[sharedThread]}
        loading={false}
        refreshing={false}
        selectedThreadId="thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onRefresh={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy path for PwrAgnt" }));

    expect(copyText).toHaveBeenCalledWith("/Users/huntharo/pwrdrvr/PwrAgnt");
  });
});
