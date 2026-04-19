import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary, NavigationDirectorySummary } from "@pwragnt/shared";
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
  executionMode: "default" as const,
  updatedAt: Date.now(),
  inbox: {
    inInbox: true,
    reason: "new-thread" as const,
  },
  linkedDirectories: [
    {
      id: "dir-a",
      label: "PwrAgnt",
      path: "/Users/huntharo/pwrdrvr/PwrAgnt",
      worktreePath: "/Users/huntharo/.codex/worktrees/0f38/PwrAgnt",
      kind: "local" as const,
    },
  ],
};

const directories: NavigationDirectorySummary[] = [
  {
    key: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
    kind: "directory",
    label: "PwrAgnt",
    path: "/Users/huntharo/pwrdrvr/PwrAgnt",
    threadKeys: ["codex:thread-1"],
    needsAttentionCount: 1,
    latestUpdatedAt: sharedThread.updatedAt,
    gitStatus: {
      currentBranch: "main",
      upstreamBranch: "origin/main",
      syncState: "in-sync",
      branches: ["main", "release"],
    },
  },
];

afterEach(() => {
  cleanup();
});

describe("Sidebar", () => {
  it("keeps Inbox first and renders compact directory rows from directory summaries", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={directories}
        fetchedAt={Date.now()}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["Inbox", "Browse"]);
    expect(screen.getByRole("button", { name: "directories" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getAllByText("PwrAgnt").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cross-project cleanup").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
  });

  it("opens the directory launchpad from the plus button", () => {
    const onOpenLaunchpad = vi.fn(async () => undefined);

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={directories}
        fetchedAt={Date.now()}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={onOpenLaunchpad}
        onSelectThread={() => undefined}
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open new thread launchpad for PwrAgnt",
      })
    );

    expect(onOpenLaunchpad).toHaveBeenCalledWith(directories[0], undefined);
  });

  it("renders directory rows without the raw chevron glyph affordance", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={directories}
        fetchedAt={Date.now()}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    expect(screen.queryByText("▾")).not.toBeInTheDocument();
  });

  it("copies a linked directory path from the recents chip", () => {
    const copyText = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        copyText,
      },
    });

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        fetchedAt={Date.now()}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy path for PwrAgnt" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy path for worktree PwrAgnt" }));

    expect(copyText).toHaveBeenCalledWith("/Users/huntharo/pwrdrvr/PwrAgnt");
    expect(copyText).toHaveBeenNthCalledWith(2, "/Users/huntharo/.codex/worktrees/0f38/PwrAgnt");
    expect(
      screen.queryByText("Line up the desktop shell with the app server")
    ).not.toBeInTheDocument();
  });

  it("shows when the local branch diverged from the codex thread branch", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        fetchedAt={Date.now()}
        inboxThreads={[
          {
            ...sharedThread,
            observedGitBranch: "main",
          },
        ]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[
          {
            ...sharedThread,
            observedGitBranch: "main",
          },
        ]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    expect(screen.getByText("now main")).toBeInTheDocument();
  });

  it("opens a new-thread picker with enabled and disabled backend options", async () => {
    const onCreateThread = vi.fn(async () => undefined);

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        fetchedAt={Date.now()}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={onCreateThread}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    const menu = screen.getByRole("menu", { name: "New thread backend" });
    expect(menu).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", {
        name: "Create thread with Codex in Default Access",
      })
    ).toBeEnabled();
    expect(
      within(menu).getByRole("menuitem", {
        name: "Create thread with Codex in Full Access",
      })
    ).toBeEnabled();
    expect(
      within(menu).getByRole("menuitem", {
        name: "Create thread with Grok in Default Access",
      })
    ).toBeDisabled();
  });
});
