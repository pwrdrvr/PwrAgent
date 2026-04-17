import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragnt/shared";
import { Sidebar } from "../Sidebar";

const backends: BackendSummary[] = [
  {
    kind: "codex",
    label: "Codex app server",
    available: true,
    methods: ["thread/start"],
    capabilities: {
      listThreads: true,
      createThread: true,
      resumeThread: true,
      readThread: true,
      startTurn: true,
      interruptTurn: true,
      steerTurn: true,
      transcriptPagination: true,
      toolUse: false,
      approvalRequests: false,
      multiDirectoryThreads: true,
    },
    executionModes: [
      {
        mode: "default",
        label: "Default Access",
        available: true,
        isDefault: true,
      },
      {
        mode: "full-access",
        label: "Full Access",
        available: true,
      },
    ],
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
      multiDirectoryThreads: false,
    },
    executionModes: [
      {
        mode: "default",
        label: "Default Access",
        available: false,
        isDefault: true,
        unavailableReason: "XAI_API_KEY is not set",
      },
    ],
    unavailableReason: "XAI_API_KEY is not set",
  },
];

const sharedThread = {
  id: "thread-1",
  title: "Cross-project cleanup",
  titleSource: "explicit" as const,
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

afterEach(() => {
  cleanup();
});

describe("Sidebar", () => {
  it("keeps Inbox first and groups a thread under each linked directory lens", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        fetchedAt={Date.now()}
        inboxThreads={[sharedThread]}
        loading={false}
        creatingThread={undefined}
        refreshing={false}
        selectedThreadKey="codex:thread-1"
        threads={[
          sharedThread,
          {
            id: "thread-2",
            title: "Unlinked planning thread",
            titleSource: "explicit",
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
        onCreateThread={async () => undefined}
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
    expect(screen.getAllByRole("button", { name: /Cross-project cleanup/i }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    const pwrAgntSection = screen
      .getByRole("heading", { level: 3, name: "PwrAgnt" })
      .closest("section");
    expect(pwrAgntSection).not.toBeNull();
    const groupedThread = within(pwrAgntSection as HTMLElement).getByRole("button", {
      name: /Cross-project cleanup/i,
    });
    expect(groupedThread).toHaveClass("thread-row");
    expect(groupedThread).not.toHaveClass("thread-row--compact");
    expect(within(groupedThread).getByText("Codex")).toBeInTheDocument();
    expect(within(groupedThread).getByText("codex/thread-centric-ui")).toBeInTheDocument();
  });

  it("lumps scratch workspaces under a shared Workspaces directory group", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        fetchedAt={Date.now()}
        inboxThreads={[]}
        loading={false}
        creatingThread={undefined}
        refreshing={false}
        selectedThreadKey={undefined}
        threads={[
          {
            id: "thread-3",
            title: "Untitled thread",
            titleSource: "explicit",
            summary: undefined,
            source: "codex",
            updatedAt: Date.now(),
            inbox: {
              inInbox: false
            },
            linkedDirectories: [
              {
                id: "scratch-1",
                label: "2026-04-17-a15d5e",
                path: "/Users/huntharo/.pwragnt/projects/2026-04-17-a15d5e",
                kind: "local"
              }
            ]
          },
          {
            id: "thread-4",
            title: "Second untitled thread",
            titleSource: "explicit",
            summary: undefined,
            source: "codex",
            updatedAt: Date.now(),
            inbox: {
              inInbox: false
            },
            linkedDirectories: [
              {
                id: "scratch-2",
                label: "2026-04-17-b83f91",
                path: "/Users/huntharo/.pwragnt/projects/2026-04-17-b83f91",
                kind: "local"
              }
            ]
          }
        ]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onRefresh={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    expect(screen.getByRole("heading", { level: 3, name: "Workspaces" })).toBeInTheDocument();
    expect(screen.getByText("2 threads")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 3, name: "2026-04-17-a15d5e" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 3, name: "2026-04-17-b83f91" })
    ).not.toBeInTheDocument();
  });

  it("merges codex worktree paths into the stable repo directory group", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        fetchedAt={Date.now()}
        inboxThreads={[]}
        loading={false}
        creatingThread={undefined}
        refreshing={false}
        selectedThreadKey={undefined}
        threads={[
          {
            id: "thread-5",
            title: "Check web API proxy support",
            titleSource: "explicit",
            summary: undefined,
            source: "codex",
            updatedAt: Date.now(),
            inbox: {
              inInbox: false
            },
            linkedDirectories: [
              {
                id: "web-app-root",
                label: "web-app",
                path: "/Users/huntharo/GIPHY/web-app",
                kind: "local"
              }
            ]
          },
          {
            id: "thread-6",
            title: "Explain web app login flow",
            titleSource: "explicit",
            summary: undefined,
            source: "codex",
            updatedAt: Date.now(),
            inbox: {
              inInbox: false
            },
            linkedDirectories: [
              {
                id: "web-app-worktree-1",
                label: "web-app",
                path: "/Users/huntharo/.codex/worktrees/0cb4/web-app",
                kind: "local"
              }
            ]
          },
          {
            id: "thread-7",
            title: "Investigate chunk file errors",
            titleSource: "explicit",
            summary: undefined,
            source: "codex",
            updatedAt: Date.now(),
            inbox: {
              inInbox: false
            },
            linkedDirectories: [
              {
                id: "web-app-worktree-2",
                label: "web-app",
                path: "/Users/huntharo/.codex/worktrees/1f9a/web-app",
                kind: "local"
              }
            ]
          }
        ]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onRefresh={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    expect(screen.getAllByRole("heading", { level: 3, name: "web-app" })).toHaveLength(1);
    expect(screen.getByText("3 threads")).toBeInTheDocument();
  });

  it("ages old non-inbox threads out of directory groups", () => {
    const now = new Date("2026-04-17T13:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      render(
        <Sidebar
          backends={backends}
          browseMode="directories"
          createThreadError={undefined}
          fetchedAt={now}
          inboxThreads={[]}
          loading={false}
          creatingThread={undefined}
          refreshing={false}
          selectedThreadKey={undefined}
          threads={[
            {
              id: "thread-recent",
              title: "Check web API proxy support",
              titleSource: "explicit",
              summary: undefined,
              source: "codex",
              updatedAt: now - 5 * 24 * 60 * 60 * 1000,
              inbox: {
                inInbox: false
              },
              linkedDirectories: [
                {
                  id: "web-app-root",
                  label: "web-app",
                  path: "/Users/huntharo/GIPHY/web-app",
                  kind: "local"
                }
              ]
            },
            {
              id: "thread-old",
              title: "Explain web app login flow",
              titleSource: "explicit",
              summary: undefined,
              source: "codex",
              updatedAt: now - 38 * 24 * 60 * 60 * 1000,
              inbox: {
                inInbox: false
              },
              linkedDirectories: [
                {
                  id: "web-app-root-2",
                  label: "web-app",
                  path: "/Users/huntharo/GIPHY/web-app",
                  kind: "local"
                }
              ]
            }
          ]}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onRefresh={async () => undefined}
          onSelectThread={() => undefined}
        />
      );

      expect(screen.getByRole("heading", { level: 3, name: "web-app" })).toBeInTheDocument();
      expect(screen.getByText("1 thread")).toBeInTheDocument();
      expect(screen.getByText("Check web API proxy support")).toBeInTheDocument();
      expect(screen.queryByText("Explain web app login flow")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not place unresolved worktree threads under No linked directory", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        fetchedAt={Date.now()}
        inboxThreads={[]}
        loading={false}
        creatingThread={undefined}
        refreshing={false}
        selectedThreadKey={undefined}
        threads={[
          {
            id: "thread-missing-cwd",
            title: "Plan Slidev theme extraction",
            titleSource: "explicit",
            summary: undefined,
            source: "codex",
            projectKey: "/Users/huntharo/.codex/worktrees/be87/search-product",
            updatedAt: Date.now(),
            inbox: {
              inInbox: false
            },
            linkedDirectories: []
          },
          {
            id: "thread-unlinked",
            title: "Untitled thread",
            titleSource: "explicit",
            summary: undefined,
            source: "grok",
            updatedAt: Date.now(),
            inbox: {
              inInbox: false
            },
            linkedDirectories: []
          }
        ]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onRefresh={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    expect(screen.getByRole("heading", { level: 3, name: "No linked directory" })).toBeInTheDocument();
    expect(screen.getByText("1 thread")).toBeInTheDocument();
    expect(screen.getByText("Untitled thread")).toBeInTheDocument();
    expect(screen.queryByText("Plan Slidev theme extraction")).not.toBeInTheDocument();
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
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        fetchedAt={Date.now()}
        inboxThreads={[sharedThread]}
        loading={false}
        creatingThread={undefined}
        refreshing={false}
        selectedThreadKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onRefresh={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy path for PwrAgnt" }));

    expect(copyText).toHaveBeenCalledWith("/Users/huntharo/pwrdrvr/PwrAgnt");
    expect(
      screen.queryByText("Line up the desktop shell with the app server")
    ).not.toBeInTheDocument();
  });

  it("opens a new-thread picker with enabled and disabled backend options", async () => {
    const onCreateThread = vi.fn(async () => undefined);

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        fetchedAt={Date.now()}
        inboxThreads={[sharedThread]}
        loading={false}
        creatingThread={undefined}
        refreshing={false}
        selectedThreadKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={onCreateThread}
        onRefresh={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    expect(screen.getByRole("menu", { name: "New thread backend" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", {
        name: "Create thread with Codex in Default Access",
      })
    ).toBeEnabled();
    expect(
      screen.getByRole("menuitem", {
        name: "Create thread with Codex in Full Access",
      })
    ).toBeEnabled();
    expect(
      screen.getByRole("menuitem", {
        name: "Create thread with Grok in Default Access",
      })
    ).toBeDisabled();

    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Create thread with Codex in Default Access",
      })
    );

    expect(onCreateThread).toHaveBeenCalledWith("codex", "default");
  });
});
