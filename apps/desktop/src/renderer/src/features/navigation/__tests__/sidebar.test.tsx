import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary, NavigationDirectorySummary } from "@pwragent/shared";
import { Sidebar } from "../Sidebar";

async function clickElement(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

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

function createDataTransfer(threadKey: string) {
  return {
    effectAllowed: "move",
    getData: vi.fn((type: string) => (type === "text/plain" ? threadKey : "")),
    setDragImage: vi.fn(),
    setData: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document
    .querySelectorAll(".thread-row--drag-image")
    .forEach((element) => element.remove());
  cleanup();
});

describe("Sidebar", () => {
  it("renders Inbox as the first thread lens and keeps directory rows available", () => {
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
    const lensTabs = within(
      screen.getByRole("tablist", { name: "Thread lenses" })
    ).getAllByRole("tab");
    expect(lensTabs.map((tab) => tab.textContent)).toEqual([
      "Updated",
      "Created",
      "Directories",
    ]);
    expect(screen.getByRole("tab", { name: "Directories" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getAllByText("PwrAgent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cross-project cleanup").length).toBeGreaterThan(0);
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThan(0);
  });

  it("shows the active PwrAgent and Codex profiles with account tooltip details", async () => {
    render(
      <Sidebar
        backends={[
          {
            ...backends[0]!,
            account: {
              type: "chatgpt",
              email: "work@example.com",
              planType: "pro",
            },
            rateLimits: [
              {
                name: "5h limit",
                remaining: 85,
                limit: 100,
              },
              {
                name: "Weekly limit",
                usedPercent: 40,
              },
              {
                name: "GPT-5.3-Codex-Spark 5h limit",
                usedPercent: 2,
              },
              {
                name: "GPT-5.3-Codex-Spark Weekly limit",
                usedPercent: 3,
              },
            ],
          },
        ]}
        activeProfile="work"
        profiles={[
          {
            name: "work",
            displayName: "work",
            active: true,
            default: false,
            profileDir: "/home/example/.pwragent/profiles/work",
            canDelete: false,
            codexProfile: {
              name: "work3",
              displayName: "work3",
              codexHome: "/home/example/.codex/profiles/work3",
              source: "directory",
              exists: true,
              selected: true,
              hasAuthFile: true,
              hasConfigFile: true,
            },
          },
        ]}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    const profileButton = screen.getByRole("button", {
      name: "Open PwrAgent profile menu",
    });
    expect(profileButton).toHaveTextContent("profile:work, codex:work3");

    fireEvent.mouseEnter(profileButton);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("PwrAgent profile: work");
    expect(tooltip).toHaveTextContent("Codex profile: work3");
    expect(tooltip).toHaveTextContent("Codex account: work@example.com");
    expect(tooltip).toHaveTextContent("Plan: pro");
    expect(tooltip).toHaveTextContent("5h limit");
    expect(tooltip).toHaveTextContent("85% left");
    expect(tooltip).toHaveTextContent("Weekly limit: 60% left");
    expect(tooltip).toHaveTextContent("Spark 5h limit: 98% left");
    expect(tooltip).toHaveTextContent("Spark Weekly limit: 97% left");
  });

  it("keeps the sidebar Codex profile identity fixed after settings refresh", () => {
    const { rerender } = render(
      <Sidebar
        backends={backends}
        activeProfile="work"
        profiles={[
          {
            name: "work",
            displayName: "work",
            active: true,
            default: false,
            profileDir: "/home/example/.pwragent/profiles/work",
            canDelete: false,
            codexProfile: {
              name: "work3",
              displayName: "work3",
              codexHome: "/home/example/.codex/profiles/work3",
              source: "directory",
              exists: true,
              selected: true,
              hasAuthFile: true,
              hasConfigFile: true,
            },
          },
        ]}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    rerender(
      <Sidebar
        backends={backends}
        activeProfile="work"
        profiles={[
          {
            name: "work",
            displayName: "work",
            active: true,
            default: false,
            profileDir: "/home/example/.pwragent/profiles/work",
            canDelete: false,
            codexProfile: {
              name: "personal",
              displayName: "personal",
              codexHome: "/home/example/.codex/profiles/personal",
              source: "directory",
              exists: true,
              selected: true,
              hasAuthFile: true,
              hasConfigFile: true,
            },
          },
        ]}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    expect(screen.getByRole("button", {
      name: "Open PwrAgent profile menu",
    })).toHaveTextContent("profile:work, codex:work3");
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

  it("renders Inbox as the updated-activity thread lens", () => {
    const onBrowseModeChange = vi.fn();

    render(
      <Sidebar
        backends={backends}
        browseMode="inbox"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[updatedSinceSeenThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[sharedThread, updatedSinceSeenThread]}
        onBrowseModeChange={onBrowseModeChange}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    expect(screen.getByRole("tab", { name: "Updated" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Created" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByRole("button", { name: /Updated thread/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Created" }));

    expect(onBrowseModeChange).toHaveBeenCalledWith("recents");
  });

  it("renders Recents from the creation-time thread order", () => {
    const updatedLater = {
      ...sharedThread,
      id: "updated-later",
      title: "Updated later",
      createdAt: 1_000,
      updatedAt: 9_000,
      inbox: { inInbox: false },
    };
    const createdLater = {
      ...sharedThread,
      id: "created-later",
      title: "Created later",
      createdAt: 2_000,
      updatedAt: 2_000,
      inbox: { inInbox: false },
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[updatedLater, createdLater]}
        recentThreads={[createdLater, updatedLater]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[updatedLater, createdLater]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const browseSection = screen.getByRole("region", { name: "Thread browser" });
    const rows = within(browseSection as HTMLElement).getAllByRole("button", {
      name: /Updated later|Created later/i,
    });
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Created later"),
      expect.stringContaining("Updated later"),
    ]);
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

  it("exposes Move Up / Move Down with shortcut hints on a pinned thread's context menu", async () => {
    // Discoverability: the Cmd+Arrow keyboard shortcut for
    // reordering pinned threads is invisible without a surfaced
    // affordance. Mirrors the macOS-native pattern of showing
    // the shortcut hint inline on the menu item.
    const onReorderThreadPins = vi.fn(async () => undefined);
    const pinnedTop = {
      ...sharedThread,
      id: "thread-top",
      title: "Top pinned thread",
      pinnedRank: "1024",
    };
    const pinnedBottom = {
      ...sharedThread,
      id: "thread-bottom",
      title: "Bottom pinned thread",
      pinnedRank: "2048",
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[pinnedTop, pinnedBottom]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onReorderThreadPins={onReorderThreadPins}
        onSelectThread={() => undefined}
        onSetThreadPin={async () => undefined}
      />,
    );

    // Open context menu on the TOP pinned thread → Move Up
    // disabled, Move Down enabled, both shortcut hints visible.
    const topRow = screen
      .getByRole("button", { name: /Top pinned thread/i })
      .closest(".thread-row-shell") as HTMLElement;
    fireEvent.click(
      topRow.querySelector(".thread-row__overflow-button") as HTMLButtonElement,
    );

    const moveUp = await screen.findByRole("menuitem", { name: /Move Up/i });
    const moveDown = await screen.findByRole("menuitem", {
      name: /Move Down/i,
    });
    expect(moveUp).toBeDisabled();
    expect(moveDown).not.toBeDisabled();
    // Unified shortcut with directory pinning (Cmd+Shift+Arrow).
    expect(moveUp).toHaveTextContent("⌘⇧↑");
    expect(moveDown).toHaveTextContent("⌘⇧↓");
    // aria-keyshortcuts so screen readers can announce the binding
    // independently of the visual chip (which is aria-hidden).
    expect(moveUp).toHaveAttribute("aria-keyshortcuts", "Meta+Shift+ArrowUp");
    expect(moveDown).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+Shift+ArrowDown",
    );

    // Click Move Down on the top thread → swap order.
    await clickElement(moveDown);
    expect(onReorderThreadPins).toHaveBeenCalledWith("codex", [
      pinnedBottom.id,
      pinnedTop.id,
    ]);
  });

  it("omits Move Up / Move Down from an unpinned thread's context menu", async () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onReorderThreadPins={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadPin={async () => undefined}
      />,
    );

    const row = screen
      .getByRole("button", { name: /Cross-project cleanup/i })
      .closest(".thread-row-shell") as HTMLElement;
    fireEvent.click(
      row.querySelector(".thread-row__overflow-button") as HTMLButtonElement,
    );

    await screen.findByRole("menuitem", { name: "Pin Thread" });
    expect(
      screen.queryByRole("menuitem", { name: /Move Up/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Move Down/i }),
    ).not.toBeInTheDocument();
  });

  it("renders pinned threads above directory threads inside each expanded directory", () => {
    const pinnedThread = {
      ...updatedSinceSeenThread,
      pinnedRank: "1024",
    };
    const directoryWithPinnedThread = {
      ...directories[0],
      threadKeys: ["codex:thread-1", "codex:thread-updated"],
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[directoryWithPinnedThread]}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread, pinnedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const directoryThreads = screen
      .getByRole("separator", { name: "Directory threads for PwrAgent" })
      .closest(".directory-row__threads") as HTMLElement;
    expect(
      screen.queryByRole("separator", {
        name: "Pinned threads for PwrAgent",
      }),
    ).not.toBeInTheDocument();

    const rows = within(directoryThreads).getAllByRole("button", {
      name: /Cross-project cleanup|Updated thread/i,
    });
    expect(rows[0]).toHaveTextContent("Updated thread");
    expect(rows[0]).toHaveTextContent("Pinned");
    expect(rows[1]).toHaveTextContent("Cross-project cleanup");
  });

  it("does not render a directory pin divider when no directory threads are pinned", () => {
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
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    expect(
      screen.queryByRole("separator", {
        name: "Pinned threads for PwrAgent",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("separator", {
        name: "Directory threads for PwrAgent",
      }),
    ).not.toBeInTheDocument();
  });

  it("pins a same-directory thread by dropping it on the directory divider", () => {
    const onReorderThreadPins = vi.fn(async () => undefined);
    const pinnedThread = {
      ...updatedSinceSeenThread,
      pinnedRank: "1024",
    };
    const directoryWithPinnedThread = {
      ...directories[0],
      threadKeys: ["codex:thread-1", "codex:thread-updated"],
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[directoryWithPinnedThread]}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread, pinnedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onReorderThreadPins={onReorderThreadPins}
        onSelectThread={() => undefined}
      />
    );

    fireEvent.drop(
      screen.getByRole("separator", { name: "Directory threads for PwrAgent" }),
      { dataTransfer: createDataTransfer("codex:thread-1") },
    );

    expect(onReorderThreadPins).toHaveBeenCalledWith("codex", [
      "thread-updated",
      "thread-1",
    ]);
  });

  it("shows recents drop targets for row edges and the pin divider", () => {
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
        selectedItemKey="codex:thread-1"
        threads={[sharedThread, pinnedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onReorderThreadPins={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const draggedRow = screen
      .getByRole("button", { name: /Cross-project cleanup/i })
      .closest(".thread-row-shell");
    expect(draggedRow).not.toBeNull();
    const dataTransfer = createDataTransfer("codex:thread-1");
    fireEvent.dragStart(draggedRow!, { dataTransfer });

    const pinnedRow = screen
      .getByRole("button", { name: /Updated thread/i })
      .closest(".thread-row-shell");
    expect(pinnedRow).not.toBeNull();
    vi.spyOn(pinnedRow!, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 300,
      toJSON: () => ({}),
      top: 0,
      width: 300,
      x: 0,
      y: 0,
    });

    fireEvent.dragOver(pinnedRow!, {
      clientY: 75,
      dataTransfer,
    });
    expect(pinnedRow).toHaveClass("is-drop-target-before");

    fireEvent.dragLeave(pinnedRow!, {
      relatedTarget: null,
    });
    expect(pinnedRow).not.toHaveClass("is-drop-target-before");

    const divider = screen.getByRole("separator", { name: "Unpinned threads" });
    fireEvent.dragOver(divider, {
      dataTransfer,
    });
    expect(divider).toHaveClass("is-drop-target");
  });

  it("ignores attempts to drop a thread on another directory pin divider", () => {
    const onReorderThreadPins = vi.fn(async () => undefined);
    const projectBPinnedThread = {
      ...sharedThread,
      id: "thread-project-b-pinned",
      title: "Project B pinned setup",
      pinnedRank: "2048",
      linkedDirectories: [
        {
          id: "dir-b",
          label: "ProjectB",
          path: "/Users/huntharo/pwrdrvr/ProjectB",
          kind: "local" as const,
        },
      ],
    };
    const projectBUnpinnedThread = {
      ...projectBPinnedThread,
      id: "thread-project-b-unpinned",
      title: "Project B setup",
      pinnedRank: undefined,
    };
    const projectBDirectory: NavigationDirectorySummary = {
      key: "directory:/Users/huntharo/pwrdrvr/ProjectB",
      kind: "directory",
      label: "ProjectB",
      path: "/Users/huntharo/pwrdrvr/ProjectB",
      threadKeys: ["codex:thread-project-b-pinned", "codex:thread-project-b-unpinned"],
      needsAttentionCount: 0,
      latestUpdatedAt: projectBPinnedThread.updatedAt,
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[directories[0], projectBDirectory]}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread, projectBPinnedThread, projectBUnpinnedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onReorderThreadPins={onReorderThreadPins}
        onSelectThread={() => undefined}
      />
    );

    const projectBSummary = screen
      .getAllByRole("button", { name: /ProjectB/i })
      .find((button) => button.getAttribute("aria-expanded") === "false");
    expect(projectBSummary).toBeDefined();

    fireEvent.click(projectBSummary!);
    fireEvent.drop(
      screen.getByRole("separator", { name: "Directory threads for ProjectB" }),
      { dataTransfer: createDataTransfer("codex:thread-1") },
    );

    expect(onReorderThreadPins).not.toHaveBeenCalled();
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

  it("copies linked directory and branch metadata from recents chips", async () => {
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

    const directoryChip = screen.getByRole("button", {
      name: "Copy path for worktree PwrAgent",
    });
    fireEvent.mouseEnter(directoryChip);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "/Users/huntharo/.codex/worktrees/0f38/PwrAgent\nClick to copy to clipboard"
    );
    fireEvent.mouseLeave(directoryChip);

    await clickElement(directoryChip);
    const branchChip = screen.getByRole("button", {
      name: "Copy branch codex/thread-centric-ui",
    });
    fireEvent.mouseEnter(branchChip);
    await waitFor(() => {
      expect(
        screen
          .getAllByRole("tooltip")
          .some(
            (tooltip) =>
              tooltip.textContent ===
              "codex/thread-centric-ui\nClick to copy to clipboard"
          )
      ).toBe(true);
    });
    fireEvent.mouseLeave(branchChip);
    await clickElement(branchChip);

    expect(copyText).toHaveBeenNthCalledWith(
      1,
      "/Users/huntharo/.codex/worktrees/0f38/PwrAgent"
    );
    expect(copyText).toHaveBeenNthCalledWith(2, "codex/thread-centric-ui");
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

    const cwdButton = screen.getByRole("button", { name: "Copy working directory" });
    fireEvent.mouseEnter(cwdButton);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "/Users/huntharo/pwrdrvr/PwrAgent/.worktrees/pwragent-fix-thread-naming-moioth2352\nClick to copy to clipboard"
    );
    fireEvent.mouseLeave(cwdButton);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const branchButton = within(screen.getByLabelText("Runtime identity")).getByRole(
      "button",
      { name: "Copy branch name" }
    );
    fireEvent.mouseEnter(branchButton);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "codex/fix-thread-naming-ephemeral\nClick to copy to clipboard"
    );
    fireEvent.mouseLeave(branchButton);

    await clickElement(cwdButton);
    await clickElement(branchButton);

    expect(copyText).toHaveBeenNthCalledWith(
      1,
      "/Users/huntharo/pwrdrvr/PwrAgent/.worktrees/pwragent-fix-thread-naming-moioth2352"
    );
    expect(copyText).toHaveBeenNthCalledWith(2, "codex/fix-thread-naming-ephemeral");
    expect(await screen.findAllByText("PwrAgent")).not.toHaveLength(0);
  });

  it("labels detached HEAD and copies the full commit SHA", async () => {
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
    await clickElement(screen.getByRole("button", { name: "Copy commit SHA" }));
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

/**
 * Directory pinning (plan 2026-05-09-002 Unit O). Mirrors the
 * thread-pin sidebar tests above but on the directory rail of the
 * Directories lens. Covers: drag-pin via divider, drag-reorder
 * among pinned directories, context-menu pin/unpin toggle, and
 * workspace/unlinked exclusion (only `kind: "directory"` entries
 * carry pin affordances).
 */
describe("Sidebar directory pinning", () => {
  function createDirectoryDataTransfer(directoryKey: string) {
    return {
      effectAllowed: "move",
      getData: vi.fn((type: string) =>
        type === "application/x-pwragent-directory" || type === "text/plain"
          ? directoryKey
          : "",
      ),
      setDragImage: vi.fn(),
      setData: vi.fn(),
    };
  }

  const projectADirectory: NavigationDirectorySummary = {
    key: "directory:/Users/huntharo/pwrdrvr/ProjectA",
    kind: "directory",
    label: "ProjectA",
    path: "/Users/huntharo/pwrdrvr/ProjectA",
    threadKeys: [],
    needsAttentionCount: 0,
    latestUpdatedAt: 1000,
  };

  const projectBDirectory: NavigationDirectorySummary = {
    key: "directory:/Users/huntharo/pwrdrvr/ProjectB",
    kind: "directory",
    label: "ProjectB",
    path: "/Users/huntharo/pwrdrvr/ProjectB",
    threadKeys: [],
    needsAttentionCount: 0,
    latestUpdatedAt: 2000,
  };

  const workspaceDirectory: NavigationDirectorySummary = {
    key: "workspace:/Users/huntharo/code",
    kind: "workspace",
    label: "Workspace",
    path: "/Users/huntharo/code",
    threadKeys: [],
    needsAttentionCount: 0,
    latestUpdatedAt: 500,
  };

  const unlinkedDirectory: NavigationDirectorySummary = {
    key: "unlinked",
    kind: "unlinked",
    label: "No linked directory",
    threadKeys: [],
    needsAttentionCount: 0,
    latestUpdatedAt: 300,
  };

  /**
   * The directory row exposes two buttons per row: the summary (with
   * `aria-expanded`) and the launchpad button (with the longer
   * `Open new thread launchpad for X` aria-label). Both match a
   * `/ProjectA/i` name regex, so we filter to the summary by
   * `aria-expanded`.
   */
  function getDirectorySummary(label: RegExp): HTMLElement {
    const matches = screen.getAllByRole("button", { name: label });
    const summary = matches.find((button) =>
      button.hasAttribute("aria-expanded"),
    );
    if (!summary) {
      throw new Error(
        `Could not find directory summary button matching ${label}`,
      );
    }
    return summary;
  }

  function renderSidebar(
    directoriesArg: NavigationDirectorySummary[],
    overrides: {
      onSetDirectoryPin?: (
        directory: NavigationDirectorySummary,
        pinned: boolean,
      ) => Promise<void>;
      onReorderDirectoryPins?: (directoryKeys: string[]) => Promise<void>;
    } = {},
  ): void {
    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={directoriesArg}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onSetDirectoryPin={overrides.onSetDirectoryPin}
        onReorderDirectoryPins={overrides.onReorderDirectoryPins}
      />,
    );
  }

  it("renders pinned directories above the divider and unpinned below", () => {
    const pinned: NavigationDirectorySummary = {
      ...projectADirectory,
      pinnedRank: "1024",
    };

    renderSidebar([pinned, projectBDirectory], {
      onSetDirectoryPin: async () => undefined,
      onReorderDirectoryPins: async () => undefined,
    });

    const divider = screen.getByRole("separator", {
      name: "Unpinned directories",
    });
    const pinnedSummary = getDirectorySummary(/ProjectA/i);
    const unpinnedSummary = getDirectorySummary(/ProjectB/i);

    // Pinned directory renders before the divider; unpinned after.
    expect(
      pinnedSummary.compareDocumentPosition(divider) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      divider.compareDocumentPosition(unpinnedSummary) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("pins an unpinned directory when it is dropped on the pinned divider", () => {
    const onReorderDirectoryPins = vi.fn(async () => undefined);
    const pinned: NavigationDirectorySummary = {
      ...projectADirectory,
      pinnedRank: "1024",
    };

    renderSidebar([pinned, projectBDirectory], {
      onSetDirectoryPin: async () => undefined,
      onReorderDirectoryPins,
    });

    fireEvent.drop(
      screen.getByRole("separator", { name: "Unpinned directories" }),
      { dataTransfer: createDirectoryDataTransfer(projectBDirectory.key) },
    );

    expect(onReorderDirectoryPins).toHaveBeenCalledWith([
      pinned.key,
      projectBDirectory.key,
    ]);
  });

  it("reorders pinned directories when one is dropped on another pinned directory", () => {
    const onReorderDirectoryPins = vi.fn(async () => undefined);
    const pinnedA: NavigationDirectorySummary = {
      ...projectADirectory,
      pinnedRank: "1024",
    };
    const pinnedB: NavigationDirectorySummary = {
      ...projectBDirectory,
      pinnedRank: "2048",
    };

    renderSidebar([pinnedA, pinnedB], {
      onSetDirectoryPin: async () => undefined,
      onReorderDirectoryPins,
    });

    // Drop pinnedB onto pinnedA's header. With JSDOM's default
    // bounding rect (all zeros), getDropIndicatorPosition returns
    // "before", so moveDirectoryKey relocates pinnedB to the slot
    // before pinnedA → [B, A]. This locks the call site without
    // depending on a synthesized clientY/rect interaction.
    const pinnedASummary = getDirectorySummary(/ProjectA/i);
    const headerA = pinnedASummary.closest(".directory-row__header");
    expect(headerA).not.toBeNull();

    fireEvent.drop(headerA!, {
      dataTransfer: createDirectoryDataTransfer(pinnedB.key),
    });

    expect(onReorderDirectoryPins).toHaveBeenCalledWith([
      pinnedB.key,
      pinnedA.key,
    ]);
  });

  it("opens a context menu offering Pin Directory on an unpinned row", async () => {
    const onSetDirectoryPin = vi.fn(async () => undefined);

    renderSidebar([projectADirectory], {
      onSetDirectoryPin,
      onReorderDirectoryPins: async () => undefined,
    });

    const summary = getDirectorySummary(/ProjectA/i);
    fireEvent.contextMenu(summary);

    const pinItem = await screen.findByRole("menuitem", {
      name: "Pin Directory",
    });
    expect(pinItem).toBeInTheDocument();
    await clickElement(pinItem);

    expect(onSetDirectoryPin).toHaveBeenCalledWith(projectADirectory, true);
    // Menu dismisses on action — the menuitem should no longer be
    // mounted after the click.
    expect(
      screen.queryByRole("menuitem", { name: "Pin Directory" }),
    ).not.toBeInTheDocument();
  });

  it("opens a context menu offering Unpin Directory on a pinned row", async () => {
    const onSetDirectoryPin = vi.fn(async () => undefined);
    const pinned: NavigationDirectorySummary = {
      ...projectADirectory,
      pinnedRank: "1024",
    };

    renderSidebar([pinned], {
      onSetDirectoryPin,
      onReorderDirectoryPins: async () => undefined,
    });

    const summary = getDirectorySummary(/ProjectA/i);
    fireEvent.contextMenu(summary);

    const unpinItem = await screen.findByRole("menuitem", {
      name: "Unpin Directory",
    });
    await clickElement(unpinItem);

    expect(onSetDirectoryPin).toHaveBeenCalledWith(pinned, false);
  });

  it("opens the context menu for workspace rows (workspaces are pinnable)", async () => {
    const onSetDirectoryPin = vi.fn(async () => undefined);

    renderSidebar([workspaceDirectory, projectADirectory], {
      onSetDirectoryPin,
      onReorderDirectoryPins: async () => undefined,
    });

    const workspaceSummary = getDirectorySummary(/Workspace/i);
    fireEvent.contextMenu(workspaceSummary);

    const pinItem = await screen.findByRole("menuitem", {
      name: "Pin Directory",
    });
    await clickElement(pinItem);

    expect(onSetDirectoryPin).toHaveBeenCalledWith(workspaceDirectory, true);
  });

  it("never opens the context menu for the unlinked pseudo-directory bucket", () => {
    const onSetDirectoryPin = vi.fn(async () => undefined);

    renderSidebar([unlinkedDirectory, projectADirectory], {
      onSetDirectoryPin,
      onReorderDirectoryPins: async () => undefined,
    });

    const unlinkedSummary = getDirectorySummary(/No linked directory/i);
    fireEvent.contextMenu(unlinkedSummary);

    expect(
      screen.queryByRole("menuitem", { name: "Pin Directory" }),
    ).not.toBeInTheDocument();
    expect(onSetDirectoryPin).not.toHaveBeenCalled();
  });

  it("suppresses the synthetic post-drag click on the directory summary button", () => {
    // Regression: an earlier ref-based suppression flag could get
    // stuck `true` if `dragend` didn't fire (e.g., React detached
    // the listener during a re-render that moved the row between
    // pinned/unpinned). The current implementation stores a
    // timestamp at every drag-end and bails on clicks within
    // POST_DRAG_CLICK_SUPPRESS_MS. This test covers both halves:
    // (1) a click immediately after drag-end is suppressed, and
    // (2) a click well after drag-end fires the expand toggle.
    const pinnedA: NavigationDirectorySummary = {
      ...projectADirectory,
      pinnedRank: "1024",
      threadKeys: ["codex:thread-1"],
    };
    const pinnedB: NavigationDirectorySummary = {
      ...projectBDirectory,
      pinnedRank: "2048",
      threadKeys: [],
    };

    renderSidebar([pinnedA, pinnedB], {
      onSetDirectoryPin: async () => undefined,
      onReorderDirectoryPins: async () => undefined,
    });

    // Initial state: ProjectA's row is collapsed (no selected
    // thread, no launchpad selected). aria-expanded === "false".
    const summary = getDirectorySummary(/ProjectA/i);
    expect(summary.getAttribute("aria-expanded")).toBe("false");

    // Drop something on the section (simulates the trailing edge
    // of a reorder gesture). This stamps the suppression
    // timestamp via the section's onDrop handler.
    const sectionA = summary.closest(".directory-row") as HTMLElement;
    fireEvent.drop(sectionA, {
      dataTransfer: createDirectoryDataTransfer(pinnedB.key),
    });

    // The synthetic post-drag click that browsers fire on the
    // element under the mouse should be suppressed — the row must
    // stay collapsed.
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("false");

    // After the suppression window elapses, a normal click toggles
    // expand again. POST_DRAG_CLICK_SUPPRESS_MS is 150ms; wait
    // longer than that, then click.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        fireEvent.click(summary);
        expect(summary.getAttribute("aria-expanded")).toBe("true");
        resolve();
      }, 200);
    });
  });

  it("does not re-expand a user-collapsed directory when another directory is unpinned", async () => {
    // Regression: the auto-expand effect in DirectoriesList runs on
    // every `props.directories` reference change, not just on
    // `selectedItemKey` change. Its skip check used
    // `if (current[directory.key])` — but `false` (user explicitly
    // collapsed) is falsy, so the effect re-overrode the user's
    // collapse every time directories changed. Triggered visibly
    // when right-clicking → "Unpin Directory" on directory A:
    //   1. unpin mutates `directories` (A loses pinnedRank)
    //   2. effect re-runs, finds B contains the selected thread,
    //      sees current[B] === false, overwrites to true
    //   3. B silently expands behind the user's back
    const threadInB = {
      ...sharedThread,
      id: "thread-in-projectb",
      title: "Work happening in ProjectB",
      linkedDirectories: [
        {
          id: "dir-projectb",
          label: "ProjectB",
          path: projectBDirectory.path!,
          kind: "local" as const,
        },
      ],
    };
    const threadKey = "codex:thread-in-projectb";

    const pinnedA: NavigationDirectorySummary = {
      ...projectADirectory,
      pinnedRank: "1024",
    };
    const pinnedB: NavigationDirectorySummary = {
      ...projectBDirectory,
      pinnedRank: "2048",
      threadKeys: [threadKey],
    };

    const onSetDirectoryPin = vi.fn(async () => undefined);

    const { rerender } = render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[pinnedA, pinnedB]}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={threadKey}
        threads={[threadInB]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onSetDirectoryPin={onSetDirectoryPin}
        onReorderDirectoryPins={async () => undefined}
      />,
    );

    // The auto-expand effect runs on mount with `selectedItemKey`
    // pointing at a thread in B → B opens automatically. That's
    // the intended behavior (drop the user into the directory
    // they're working in).
    const bSummary = getDirectorySummary(/ProjectB/i);
    await waitFor(() => {
      expect(bSummary.getAttribute("aria-expanded")).toBe("true");
    });

    // User explicitly collapses B (they don't want the threads list
    // taking sidebar space right now). expandedByKey[B] = false.
    fireEvent.click(bSummary);
    expect(bSummary.getAttribute("aria-expanded")).toBe("false");

    // Now: user right-clicks A and unpins it. The IPC fan-out
    // produces a new `directories` array with A's pinnedRank
    // gone (modeled here as a direct rerender — the optimistic
    // patcher in useThreadNavigation does the equivalent).
    const unpinnedA: NavigationDirectorySummary = {
      ...pinnedA,
      pinnedRank: undefined,
    };
    rerender(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[unpinnedA, pinnedB]}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={threadKey}
        threads={[threadInB]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onSetDirectoryPin={onSetDirectoryPin}
        onReorderDirectoryPins={async () => undefined}
      />,
    );

    // The user's explicit collapse of B must survive the unrelated
    // unpin of A. Before the fix, the auto-expand effect would
    // re-fire and silently re-open B.
    const bSummaryAfter = getDirectorySummary(/ProjectB/i);
    expect(bSummaryAfter.getAttribute("aria-expanded")).toBe("false");
  });

  it("dismisses any open directory context menu when a thread context menu opens", async () => {
    // Regression: a `contextmenu` event doesn't fire the
    // document-level `click` listener that normally dismisses
    // open menus. Before the fix, right-clicking a directory →
    // right-clicking a thread (without an intervening left-click)
    // left both menus stacked on top of each other.
    //
    // The directory→thread direction was already symmetric
    // (`openDirectoryContextMenu` clears `contextMenu` itself),
    // so this test locks the formerly-broken direction only.
    const onSetThreadPin = vi.fn(async () => undefined);
    const pinnedA: NavigationDirectorySummary = {
      ...projectADirectory,
      pinnedRank: "1024",
      threadKeys: ["codex:thread-1"],
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[pinnedA]}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        // selectedItemKey points at the thread inside A so the
        // auto-expand effect opens A on mount — that's the only
        // way a thread row inside the Directories lens becomes
        // visible to right-click.
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadPin={onSetThreadPin}
        onSetDirectoryPin={async () => undefined}
        onReorderDirectoryPins={async () => undefined}
      />,
    );

    // Right-click directory A → directory menu opens.
    const directorySummary = getDirectorySummary(/ProjectA/i);
    fireEvent.contextMenu(directorySummary);
    await screen.findByRole("menuitem", { name: "Unpin Directory" });

    // Right-click the thread row inside A (no intervening left
    // click) → `openThreadContextMenu` runs. The directory menu
    // must dismiss as a side-effect.
    const threadRow = screen
      .getByRole("button", { name: /Cross-project cleanup/i })
      .closest(".thread-row-shell") as HTMLElement;
    fireEvent.contextMenu(threadRow);

    await screen.findByRole("menuitem", { name: "Pin Thread" });
    expect(
      screen.queryByRole("menuitem", { name: "Unpin Directory" }),
    ).not.toBeInTheDocument();
  });

  it("exposes Move Up / Move Down with shortcut hints on a pinned directory's context menu", async () => {
    // Discoverability: the Cmd+Shift+Arrow keyboard shortcut for
    // reordering pinned directories is invisible without a
    // surfaced affordance. Mirrors the macOS-native pattern of
    // showing the shortcut hint inline on the menu item.
    const onReorderDirectoryPins = vi.fn(async () => undefined);
    const pinnedTop: NavigationDirectorySummary = {
      ...projectADirectory,
      pinnedRank: "1024",
    };
    const pinnedMiddle: NavigationDirectorySummary = {
      ...projectBDirectory,
      pinnedRank: "2048",
    };
    const pinnedBottom: NavigationDirectorySummary = {
      key: "directory:/Users/huntharo/pwrdrvr/ProjectC",
      kind: "directory",
      label: "ProjectC",
      path: "/Users/huntharo/pwrdrvr/ProjectC",
      threadKeys: [],
      needsAttentionCount: 0,
      latestUpdatedAt: 3000,
      pinnedRank: "3072",
    };

    renderSidebar([pinnedTop, pinnedMiddle, pinnedBottom], {
      onSetDirectoryPin: async () => undefined,
      onReorderDirectoryPins,
    });

    // Right-click the middle pinned directory — both Move Up and
    // Move Down should be enabled.
    fireEvent.contextMenu(getDirectorySummary(/ProjectB/i));
    const moveUp = await screen.findByRole("menuitem", { name: /Move Up/i });
    const moveDown = await screen.findByRole("menuitem", {
      name: /Move Down/i,
    });
    expect(moveUp).not.toBeDisabled();
    expect(moveDown).not.toBeDisabled();
    expect(moveUp).toHaveTextContent("⌘⇧↑");
    expect(moveDown).toHaveTextContent("⌘⇧↓");
    expect(moveUp).toHaveAttribute("aria-keyshortcuts", "Meta+Shift+ArrowUp");
    expect(moveDown).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+Shift+ArrowDown",
    );

    // Click Move Down → the middle directory should move past the
    // bottom one, producing [top, bottom, middle].
    await clickElement(moveDown);
    expect(onReorderDirectoryPins).toHaveBeenCalledWith([
      pinnedTop.key,
      pinnedBottom.key,
      pinnedMiddle.key,
    ]);
  });

  it("disables Move Up on the top pinned directory and Move Down on the bottom", async () => {
    const pinnedTop: NavigationDirectorySummary = {
      ...projectADirectory,
      pinnedRank: "1024",
    };
    const pinnedBottom: NavigationDirectorySummary = {
      ...projectBDirectory,
      pinnedRank: "2048",
    };

    renderSidebar([pinnedTop, pinnedBottom], {
      onSetDirectoryPin: async () => undefined,
      onReorderDirectoryPins: async () => undefined,
    });

    // Top: Move Up disabled, Move Down enabled
    fireEvent.contextMenu(getDirectorySummary(/ProjectA/i));
    expect(
      await screen.findByRole("menuitem", { name: /Move Up/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: /Move Down/i }),
    ).not.toBeDisabled();

    // Dismiss + open the bottom row's menu
    fireEvent.click(document.body);
    fireEvent.contextMenu(getDirectorySummary(/ProjectB/i));
    expect(
      await screen.findByRole("menuitem", { name: /Move Up/i }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: /Move Down/i }),
    ).toBeDisabled();
  });

  it("omits Move Up / Move Down entirely from an unpinned directory's context menu", async () => {
    renderSidebar([projectADirectory], {
      onSetDirectoryPin: async () => undefined,
      onReorderDirectoryPins: async () => undefined,
    });

    fireEvent.contextMenu(getDirectorySummary(/ProjectA/i));
    await screen.findByRole("menuitem", { name: "Pin Directory" });
    expect(
      screen.queryByRole("menuitem", { name: /Move Up/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Move Down/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the directory menu open after a Move click so the user can chain reorders", async () => {
    // The keyboard shortcut path lets a user mash Cmd+Shift+↓
    // repeatedly. The menu path should not force a re-right-click
    // between every Move — that's a UX downgrade. Pin/Unpin
    // still dismiss because those are terminal actions.
    const pinnedTop: NavigationDirectorySummary = {
      ...projectADirectory,
      pinnedRank: "1024",
    };
    const pinnedMiddle: NavigationDirectorySummary = {
      ...projectBDirectory,
      pinnedRank: "2048",
    };
    const pinnedBottom: NavigationDirectorySummary = {
      key: "directory:/Users/huntharo/pwrdrvr/ProjectC",
      kind: "directory",
      label: "ProjectC",
      path: "/Users/huntharo/pwrdrvr/ProjectC",
      threadKeys: [],
      needsAttentionCount: 0,
      latestUpdatedAt: 3000,
      pinnedRank: "3072",
    };

    renderSidebar([pinnedTop, pinnedMiddle, pinnedBottom], {
      onSetDirectoryPin: async () => undefined,
      onReorderDirectoryPins: async () => undefined,
    });

    fireEvent.contextMenu(getDirectorySummary(/ProjectB/i));
    const moveDown = await screen.findByRole("menuitem", {
      name: /Move Down/i,
    });
    await clickElement(moveDown);

    // Menu must still be mounted after the Move click — the
    // Pin / Unpin item is the marker that the same menu is
    // still open.
    expect(
      screen.queryByRole("menuitem", { name: /Unpin Directory/i }),
    ).toBeInTheDocument();
  });

  it("dismisses the directory menu after Pin / Unpin (terminal action)", async () => {
    const pinned: NavigationDirectorySummary = {
      ...projectADirectory,
      pinnedRank: "1024",
    };

    renderSidebar([pinned], {
      onSetDirectoryPin: async () => undefined,
      onReorderDirectoryPins: async () => undefined,
    });

    fireEvent.contextMenu(getDirectorySummary(/ProjectA/i));
    const unpinItem = await screen.findByRole("menuitem", {
      name: "Unpin Directory",
    });
    await clickElement(unpinItem);

    // Unlike Move, the Unpin item collapses the menu.
    expect(
      screen.queryByRole("menuitem", { name: /Unpin Directory/i }),
    ).not.toBeInTheDocument();
  });
});

describe("Sidebar thread pinning Move items", () => {
  it("disables Move Down on backend A's bottom pinned thread regardless of backend B's pinned count", async () => {
    // Per-backend pin-rank invariant: reorder IPC is scoped to
    // (backend, [threadId, threadId, ...]). Move Down on backend
    // A's bottom thread must NOT promote into backend B's pinned
    // slice. Lock the boundary so a future refactor that
    // accidentally globalizes the sort can't slip past review.
    const codexOnly = {
      ...sharedThread,
      id: "codex-pinned-only",
      title: "Codex sole pin",
      source: "codex" as const,
      pinnedRank: "1024",
    };
    const grokTop = {
      ...sharedThread,
      id: "grok-top",
      title: "Grok top pin",
      source: "grok" as const,
      pinnedRank: "1024",
    };
    const grokBottom = {
      ...sharedThread,
      id: "grok-bottom",
      title: "Grok bottom pin",
      source: "grok" as const,
      pinnedRank: "2048",
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={[]}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[codexOnly, grokTop, grokBottom]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onReorderThreadPins={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadPin={async () => undefined}
      />,
    );

    // Open menu on codex's sole pin (it's at both top AND bottom
    // of its backend's slice — but grok has TWO pins below).
    const codexRow = screen
      .getByRole("button", { name: /Codex sole pin/i })
      .closest(".thread-row-shell") as HTMLElement;
    fireEvent.click(
      codexRow.querySelector(".thread-row__overflow-button") as HTMLButtonElement,
    );

    const moveUp = await screen.findByRole("menuitem", { name: /Move Up/i });
    const moveDown = await screen.findByRole("menuitem", {
      name: /Move Down/i,
    });
    // Per-backend slice has length 1 → both Up and Down disabled
    // even though the global pin count is 3.
    expect(moveUp).toBeDisabled();
    expect(moveDown).toBeDisabled();
  });

  it("invokes the reorder IPC on Cmd+Shift+ArrowDown on a focused pinned thread row", () => {
    // Locks the unified shortcut. The thread reorder shortcut
    // used to be plain Cmd+Arrow; it now matches the directory
    // reorder shortcut (Cmd+Shift+Arrow). A plain Cmd+Arrow
    // press should NOT trigger a reorder anymore.
    const onReorderThreadPins = vi.fn(async () => undefined);
    const pinnedTop = {
      ...sharedThread,
      id: "thread-top",
      title: "Top pinned",
      pinnedRank: "1024",
    };
    const pinnedBottom = {
      ...sharedThread,
      id: "thread-bottom",
      title: "Bottom pinned",
      pinnedRank: "2048",
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={[]}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[pinnedTop, pinnedBottom]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onReorderThreadPins={onReorderThreadPins}
        onSelectThread={() => undefined}
        onSetThreadPin={async () => undefined}
      />,
    );

    const topButton = screen.getByRole("button", { name: /Top pinned/i });

    // Old shortcut (Cmd alone) → must NOT fire.
    fireEvent.keyDown(topButton, { key: "ArrowDown", metaKey: true });
    expect(onReorderThreadPins).not.toHaveBeenCalled();

    // New shortcut (Cmd + Shift) → fires the reorder, swapping
    // the top thread with the bottom one.
    fireEvent.keyDown(topButton, {
      key: "ArrowDown",
      metaKey: true,
      shiftKey: true,
    });
    expect(onReorderThreadPins).toHaveBeenCalledWith("codex", [
      pinnedBottom.id,
      pinnedTop.id,
    ]);
  });
});
