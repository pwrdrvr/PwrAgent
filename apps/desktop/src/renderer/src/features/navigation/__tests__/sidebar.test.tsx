import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary, NavigationDirectorySummary } from "@pwragent/shared";
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
      archiveThread: true,
      restoreThread: true,
      renameThread: true,
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
      archiveThread: false,
      restoreThread: false,
      renameThread: false,
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
      label: "PwrAgent",
      path: "/Users/huntharo/pwrdrvr/PwrAgent",
      worktreePath: "/Users/huntharo/.codex/worktrees/0f38/PwrAgent",
      kind: "worktree" as const,
    },
  ],
};

const updatedSinceSeenThread = {
  ...sharedThread,
  id: "thread-updated",
  title: "Updated thread",
  inbox: {
    inInbox: true,
    reason: "updated-since-seen" as const,
    lastSeenUpdatedAt: sharedThread.updatedAt - 1,
  },
};

const directories: NavigationDirectorySummary[] = [
  {
    key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
    kind: "directory",
    label: "PwrAgent",
    path: "/Users/huntharo/pwrdrvr/PwrAgent",
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
  vi.restoreAllMocks();
  cleanup();
});

describe("Sidebar", () => {
  it("renders Recents as the first thread lens and keeps directory rows available", () => {
    const onOpenSettings = vi.fn();
    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenSettings={onOpenSettings}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("heading", { level: 2, name: "Browse" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Thread browser" })).toBeInTheDocument();
    const lensButtons = within(
      screen.getByRole("tablist", { name: "Thread lenses" })
    ).getAllByRole("button");
    expect(lensButtons.map((button) => button.textContent)).toEqual([
      "recents",
      "directories",
    ]);
    expect(screen.getByRole("button", { name: "directories" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getAllByText("PwrAgent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cross-project cleanup").length).toBeGreaterThan(0);
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThan(0);
  });

  it("keeps recents to a single worktree indicator on the directory chip", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
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

    const browseSection = screen.getByRole("region", { name: "Thread browser" });
    const threadButton = within(browseSection as HTMLElement).getByRole("button", {
      name: /Cross-project cleanup/i,
    });

    expect(within(threadButton).getByLabelText("Copy path for worktree PwrAgent")).toHaveTextContent(
      "PwrAgent"
    );
    expect(within(threadButton).queryByText("worktree")).not.toBeInTheDocument();
  });

  it("shows local versus worktree location chips in directory rows", () => {
    const localThread = {
      ...sharedThread,
      id: "thread-local",
      title: "Local cleanup",
      linkedDirectories: [
        {
          id: "dir-a",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "local" as const,
        },
      ],
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[
          {
            ...directories[0],
            threadKeys: ["codex:thread-1", "codex:thread-local"],
          },
        ]}
        inboxThreads={[sharedThread, localThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[sharedThread, localThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const browseSection = screen.getByRole("region", { name: "Thread browser" });
    fireEvent.click(
      within(browseSection as HTMLElement).getByRole("button", { name: "PwrAgent1" })
    );
    const worktreeThreadButton = within(browseSection as HTMLElement).getByRole("button", {
      name: /Cross-project cleanup/i,
    });
    const localThreadButton = within(browseSection as HTMLElement).getByRole("button", {
      name: /Local cleanup/i,
    });

    expect(within(worktreeThreadButton).getByText("worktree")).toBeInTheDocument();
    expect(within(worktreeThreadButton).queryByText("PwrAgent")).not.toBeInTheDocument();
    expect(within(localThreadButton).getByText("local")).toBeInTheDocument();
  });

  it("opens the directory launchpad from the plus button", () => {
    const onOpenLaunchpad = vi.fn(async () => undefined);

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={directories}
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
        name: "Open new thread launchpad for PwrAgent",
      })
    );

    expect(onOpenLaunchpad).toHaveBeenCalledWith(directories[0], undefined);
  });

  it("does not highlight an opened-only launchpad as a pending draft", () => {
    const openedOnlyDirectories: NavigationDirectorySummary[] = [
      {
        ...directories[0]!,
        launchpad: {
          directoryKey: directories[0]!.key,
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          createdAt: 1,
          updatedAt: 1,
        },
      },
    ];

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={openedOnlyDirectories}
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

    expect(
      screen.getByRole("button", { name: "Open new thread launchpad for PwrAgent" }),
    ).not.toHaveClass("has-draft");
  });

  it("highlights launchpads with pending prompt data", () => {
    const pendingDirectories: NavigationDirectorySummary[] = [
      {
        ...directories[0]!,
        launchpad: {
          directoryKey: directories[0]!.key,
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
          backend: "codex",
          executionMode: "default",
          prompt: "Pending work",
          workMode: "local",
          createdAt: 1,
          updatedAt: 2,
        },
      },
    ];

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={pendingDirectories}
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

    expect(
      screen.getByRole("button", { name: "Open new thread launchpad for PwrAgent" }),
    ).toHaveClass("has-draft");
  });

  it("shows the thinking indicator instead of unread for an active initiated turn", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        thinkingThreadKeys={{ "codex:thread-1": true }}
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const browseSection = screen.getByRole("region", { name: "Thread browser" });
    const threadButton = within(browseSection as HTMLElement).getByRole("button", {
      name: /Cross-project cleanup/i,
    });

    const thinkingIndicator = threadButton.querySelector('[data-thread-status="thinking"]');
    expect(thinkingIndicator).not.toBeNull();
    expect(thinkingIndicator).toHaveAttribute("aria-label", "Thinking");
    expect(thinkingIndicator).toHaveAttribute("title", "Thinking");
    expect(threadButton.querySelector('[data-thread-status="unread"]')).toBeNull();
  });

  it("shows an approval chip for threads waiting on an approval request", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        approvalRequestThreadKeys={{ "codex:thread-1": true }}
        selectedItemKey={undefined}
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const browseSection = screen.getByRole("region", { name: "Thread browser" });
    const threadButton = within(browseSection as HTMLElement).getByRole("button", {
      name: /Cross-project cleanup/i,
    });

    const approvalChip = within(threadButton).getByTitle("Waiting for approval");
    expect(approvalChip).toHaveTextContent("Waiting for approval");
    expect(approvalChip).not.toHaveTextContent("!");
    expect(approvalChip).toHaveAttribute("title", "Waiting for approval");
  });

  it("does not duplicate new-thread inbox membership as an attention marker in recents", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
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

    const browseSection = screen.getByRole("region", { name: "Thread browser" });
    const threadButton = within(browseSection as HTMLElement).getByRole("button", {
      name: /Cross-project cleanup/i,
    });

    expect(threadButton.querySelector('[data-thread-status="thinking"]')).toBeNull();
    expect(threadButton.querySelector('[data-thread-status="unread"]')).toBeNull();
  });

  it("shows an unread marker in recents for threads updated since they were seen", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[updatedSinceSeenThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[updatedSinceSeenThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const browseSection = screen.getByRole("region", { name: "Thread browser" });
    const threadButton = within(browseSection as HTMLElement).getByRole("button", {
      name: /Updated thread/i,
    });

    expect(threadButton.querySelector('[data-thread-status="thinking"]')).toBeNull();
    const unreadIndicator = threadButton.querySelector('[data-thread-status="unread"]');
    expect(unreadIndicator).not.toBeNull();
    expect(unreadIndicator).toHaveAttribute("aria-label", "Unread update");
    expect(unreadIndicator).toHaveAttribute("title", "Unread update");
    expect(
      threadButton.querySelector('[data-thread-status="unread"] .thread-row__status-cookie')
    ).not.toBeNull();
    expect(unreadIndicator).not.toHaveTextContent("!");
  });

  it("does not render the retired inbox lens", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[updatedSinceSeenThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[sharedThread, updatedSinceSeenThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    expect(screen.queryByRole("button", { name: "inbox" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "recents" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("opens thread actions from the row overflow button", () => {
    const onArchiveThread = vi.fn(async () => undefined);

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
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
        onArchiveThread={onArchiveThread}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open thread actions" })
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive Thread" }));

    expect(onArchiveThread).toHaveBeenCalledWith(sharedThread);
  });

  it("pins from the row menu and renders pinned threads above recents", () => {
    const onSetThreadPin = vi.fn(async () => undefined);
    const pinnedThread = {
      ...updatedSinceSeenThread,
      pinnedRank: "1024",
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[sharedThread, pinnedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadPin={onSetThreadPin}
      />
    );

    const browseSection = screen.getByRole("region", { name: "Thread browser" });
    const rows = within(browseSection as HTMLElement).getAllByRole("button", {
      name: /Cross-project cleanup|Updated thread/i,
    });
    expect(rows[0]).toHaveTextContent("Updated thread");
    expect(rows[0]).toHaveTextContent("Pinned");
    expect(screen.getByRole("separator", { name: "Unpinned threads" })).toBeInTheDocument();

    const unpinnedRow = within(browseSection as HTMLElement).getByRole("button", {
      name: /Cross-project cleanup/i,
    });
    const overflowButton = unpinnedRow
      .closest(".thread-row-shell")
      ?.querySelector(".thread-row__overflow-button") as HTMLButtonElement;
    fireEvent.click(overflowButton);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin Thread" }));

    expect(onSetThreadPin).toHaveBeenCalledWith(sharedThread, true);
  });

  it("shows copy actions below the thread context menu divider", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
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
        onArchiveThread={async () => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open thread actions" }));

    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("separator")).toBeInTheDocument();
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Rename Thread",
      "Archive Thread",
      "Copy Thread ID",
      "Copy Worktree Path",
      "Copy Branch Name",
    ]);
  });

  it("flips the thread actions menu above the overflow button near the viewport bottom", () => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 640,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        if (this.classList.contains("thread-context-menu")) {
          return {
            bottom: 680,
            height: 150,
            left: 420,
            right: 588,
            top: 530,
            width: 168,
            x: 420,
            y: 530,
            toJSON: () => ({}),
          };
        }
        if (this.getAttribute("aria-label") === "Open thread actions") {
          return {
            bottom: 530,
            height: 26,
            left: 420,
            right: 450,
            top: 500,
            width: 30,
            x: 420,
            y: 500,
            toJSON: () => ({}),
          };
        }
        return {
          bottom: 0,
          height: 0,
          left: 0,
          right: 0,
          top: 0,
          width: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      }
    );

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
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
        onArchiveThread={async () => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open thread actions" }));

    expect(screen.getByRole("menu")).toHaveStyle({
      left: "420px",
      top: "346px",
    });
  });

  it("copies thread context menu values", () => {
    const copyText = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        copyText,
      },
    });

    const renderMenu = (): void => {
      render(
        <Sidebar
          backends={backends}
          browseMode="recents"
          createThreadError={undefined}
          directories={directories}
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
          onArchiveThread={async () => undefined}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Open thread actions" }));
    };

    renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Thread ID" }));
    cleanup();

    renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Worktree Path" }));
    cleanup();

    renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Branch Name" }));

    expect(copyText).toHaveBeenNthCalledWith(1, "thread-1");
    expect(copyText).toHaveBeenNthCalledWith(
      2,
      "/Users/huntharo/.codex/worktrees/0f38/PwrAgent"
    );
    expect(copyText).toHaveBeenNthCalledWith(3, "codex/thread-centric-ui");
  });

  it("hides optional copy actions without matching thread metadata", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[
          {
            ...sharedThread,
            gitBranch: undefined,
            linkedDirectories: [
              {
                id: "dir-a",
                label: "PwrAgent",
                path: "/Users/huntharo/pwrdrvr/PwrAgent",
                kind: "local" as const,
              },
            ],
          },
        ]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[
          {
            ...sharedThread,
            gitBranch: undefined,
            linkedDirectories: [
              {
                id: "dir-a",
                label: "PwrAgent",
                path: "/Users/huntharo/pwrdrvr/PwrAgent",
                kind: "local" as const,
              },
            ],
          },
        ]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onArchiveThread={async () => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open thread actions" }));

    expect(screen.queryByRole("menuitem", { name: "Copy Worktree Path" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Copy Branch Name" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy Thread ID" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy Local Path" })).toBeInTheDocument();
  });

  it("hides archive actions when the backend does not support archiving", () => {
    const backendsWithoutArchive = backends.map((backend) =>
      backend.kind === "codex"
        ? {
            ...backend,
            capabilities: {
              ...backend.capabilities,
              archiveThread: false,
            },
          }
        : backend
    );

    render(
      <Sidebar
        backends={backendsWithoutArchive}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
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
        onArchiveThread={async () => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open thread actions" }));

    expect(screen.getByRole("menuitem", { name: "Rename Thread" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Archive Thread" })).not.toBeInTheDocument();
  });

  it("renames a thread from the thread context menu", () => {
    const onRenameThread = vi.fn(async () => undefined);

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
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
        onRenameThread={onRenameThread}
      />
    );

    const threadButton = screen.getByText("Cross-project cleanup").closest("button");
    expect(threadButton).not.toBeNull();
    fireEvent.contextMenu(threadButton as HTMLElement, { clientX: 12, clientY: 34 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Thread" }));

    const dialog = screen.getByRole("dialog", { name: "Rename Thread" });
    const input = within(dialog).getByLabelText("Name");
    fireEvent.change(input, { target: { value: "  Renamed cleanup  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename Thread" }));

    expect(onRenameThread).toHaveBeenCalledWith(sharedThread, "Renamed cleanup");
  });

  it("focuses and selects the current name when opening the rename dialog", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
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
        onRenameThread={async () => undefined}
      />
    );

    const threadButton = screen.getByText("Cross-project cleanup").closest("button");
    expect(threadButton).not.toBeNull();
    fireEvent.contextMenu(threadButton as HTMLElement, { clientX: 12, clientY: 34 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Thread" }));

    const dialog = screen.getByRole("dialog", { name: "Rename Thread" });
    const input = within(dialog).getByLabelText("Name") as HTMLInputElement;

    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Cross-project cleanup".length);
  });

  it("collapses a fully selected rename field to either end with arrow keys", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
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
        onRenameThread={async () => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open thread actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Thread" }));

    const dialog = screen.getByRole("dialog", { name: "Rename Thread" });
    const input = within(dialog).getByLabelText("Name") as HTMLInputElement;

    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(0);

    input.select();
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(input.selectionStart).toBe("Cross-project cleanup".length);
    expect(input.selectionEnd).toBe("Cross-project cleanup".length);
  });

  it("keeps the rename dialog open for blank names", () => {
    const onRenameThread = vi.fn(async () => undefined);

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
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
        onRenameThread={onRenameThread}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open thread actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Thread" }));

    const dialog = screen.getByRole("dialog", { name: "Rename Thread" });
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "   " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename Thread" }));

    expect(onRenameThread).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Thread name cannot be blank.")).toBeInTheDocument();
  });

  it("archives directly from the thread context menu", () => {
    const onArchiveThread = vi.fn(async () => undefined);

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
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
        onArchiveThread={onArchiveThread}
      />
    );

    const threadButton = screen.getByText("Cross-project cleanup").closest("button");
    expect(threadButton).not.toBeNull();
    fireEvent.contextMenu(threadButton as HTMLElement, { clientX: 12, clientY: 34 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive Thread" }));

    expect(screen.queryByRole("dialog", { name: "Archive Thread" })).not.toBeInTheDocument();
    expect(onArchiveThread).toHaveBeenCalledWith(sharedThread);
  });

  it("renders directory rows without the raw chevron glyph affordance", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={directories}
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
    Object.defineProperty(window, "pwragent", {
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

    fireEvent.click(screen.getByRole("button", { name: "Copy path for worktree PwrAgent" }));

    expect(copyText).toHaveBeenCalledWith("/Users/huntharo/.codex/worktrees/0f38/PwrAgent");
    expect(
      screen.queryByText("Line up the desktop shell with the app server")
    ).not.toBeInTheDocument();
  });

  it("shows compact runtime identity chips that copy full values", async () => {
    const copyText = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragent", {
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
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        runtimeIdentity={{
          branch: "codex/fix-thread-naming-ephemeral",
          cwd: "/Users/huntharo/pwrdrvr/PwrAgent/.worktrees/pwragent-fix-thread-naming-moioth2352",
        }}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    expect(screen.getByText(".worktrees/pwragent-fix-t...ng-moioth2352")).toBeInTheDocument();
    expect(screen.getByText("codex/fix-thread-naming-ephemeral")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy working directory" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy branch name" }));

    expect(copyText).toHaveBeenNthCalledWith(
      1,
      "/Users/huntharo/pwrdrvr/PwrAgent/.worktrees/pwragent-fix-thread-naming-moioth2352"
    );
    expect(copyText).toHaveBeenNthCalledWith(2, "codex/fix-thread-naming-ephemeral");
    expect(await screen.findAllByText("PwrAgent")).not.toHaveLength(0);
  });

  it("labels detached HEAD and copies the full commit SHA", () => {
    const copyText = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragent", {
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
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        runtimeIdentity={{
          commitSha: "ab12cd3344556677889900aabbccddeeff001122",
          cwd: "/Users/huntharo/.codex/worktrees/5d4b/PwrAgent",
          detachedHead: true,
        }}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    expect(screen.getByText("HEAD")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy commit SHA" }));
    expect(copyText).toHaveBeenCalledWith("ab12cd3344556677889900aabbccddeeff001122");
  });

  it("shows when the local branch diverged from the codex thread branch", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
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

  it("opens a new-thread draft from the masthead action", async () => {
    const onCreateThread = vi.fn(async () => undefined);

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
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

    expect(onCreateThread).toHaveBeenCalledTimes(1);
  });
});
