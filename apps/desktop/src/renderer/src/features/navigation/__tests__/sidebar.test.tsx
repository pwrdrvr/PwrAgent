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
import type {
  BackendSummary,
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { FederationThreadTarget } from "../../chrome/federation-thread-targets";
import { HOVER_TRANSITION_GRACE_MS } from "../../../lib/useHoverTransitionGrace";
import { Sidebar } from "../Sidebar";

/**
 * The whole row card for a thread, given any element inside it (the
 * open-thread button, a title text node's span, a chip, …).
 *
 * The open-thread button is an EMPTY full-card overlay: the title line,
 * chip flow, and status indicator are its SIBLINGS inside `.thread-row`,
 * because they carry buttons of their own and a button inside a button
 * is invalid (see ThreadRow). Assertions about a row's content have to
 * scope to the card, not to the button.
 */
function threadCard(element: HTMLElement): HTMLElement {
  const card = element.closest(".thread-row");
  if (!(card instanceof HTMLElement)) {
    throw new Error("Expected the element to sit inside .thread-row");
  }
  return card;
}

async function clickElement(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

function withMockScrollIntoView(): {
  scrollIntoView: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });

  return {
    scrollIntoView,
    restore: () => {
      if (originalScrollIntoView) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalScrollIntoView,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    },
  };
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
    kind: "acp:grok",
    label: "Grok",
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
        unavailableReason: "Grok CLI is not installed",
      },
    ],
    unavailableReason: "Grok CLI is not installed",
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

const pullRequestThread: NavigationThreadSummary = {
  ...sharedThread,
  prs: [
    {
      provider: "github.com",
      number: 202,
      org: "ExampleOrg",
      repo: "ExampleApp",
      state: "passing",
      url: "https://github.com/ExampleOrg/ExampleApp/pull/202",
    },
  ],
};

const localThread = {
  ...sharedThread,
  id: "thread-local",
  title: "Local checkout cleanup",
  linkedDirectories: [
    {
      id: "dir-local",
      label: "PwrAgent",
      path: "/Users/huntharo/pwrdrvr/PwrAgent",
      kind: "local" as const,
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

const THREAD_PIN_POINTER_ID = 41;

function startThreadPinPointerDrag(
  element: Element,
  point: { x: number; y: number },
): void {
  fireEvent.pointerDown(element, {
    button: 0,
    clientX: point.x,
    clientY: point.y,
    pointerId: THREAD_PIN_POINTER_ID,
  });
}

function moveThreadPinPointer(
  point: { x: number; y: number },
): void {
  fireEvent.pointerMove(window, {
    buttons: 1,
    clientX: point.x,
    clientY: point.y,
    pointerId: THREAD_PIN_POINTER_ID,
  });
}

function releaseThreadPinPointer(
  point: { x: number; y: number },
): void {
  fireEvent.pointerUp(window, {
    button: 0,
    clientX: point.x,
    clientY: point.y,
    pointerId: THREAD_PIN_POINTER_ID,
  });
}

afterEach(() => {
  delete (window as unknown as {
    __pwragentFederationLabel?: unknown;
  }).__pwragentFederationLabel;
  delete (window as unknown as {
    __pwragentFederationTarget?: unknown;
  }).__pwragentFederationTarget;
  vi.restoreAllMocks();
  vi.useRealTimers();
  document
    .querySelectorAll(".thread-row--drag-image")
    .forEach((element) => element.remove());
  cleanup();
});

describe("Sidebar", () => {
  it("keeps a loaded thread snapshot visible when its refresh fails", () => {
    const staleThread: NavigationThreadSummary = {
      ...sharedThread,
      federation: {
        ref: {
          backend: "codex",
          target: { scope: "remote", instanceId: "remote-instance" },
          threadId: sharedThread.id,
        },
        instanceLabel: "Remote fixture",
        peerStatus: "disconnected",
      },
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        directories={directories}
        error="Error invoking remote method: peer is not connected"
        inboxThreads={[staleThread]}
        loaded
        loading={false}
        selectedItemKey="codex:thread-1"
        threads={[staleThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    expect(
      threadCard(screen.getByRole("button", { name: /^Cross-project cleanup/ })),
    ).toHaveClass("is-remote-offline");
    expect(
      screen.queryByText("Error invoking remote method: peer is not connected"),
    ).not.toBeInTheDocument();
  });

  it("labels a remote window without showing the controller's runtime identity", () => {
    (window as unknown as {
      __pwragentFederationLabel?: unknown;
    }).__pwragentFederationLabel = "Tart VM";
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "remote-instance",
    };

    render(
      <Sidebar
        activeProfile="dev"
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        profiles={[]}
        runtimeIdentity={{
          branch: "controller-branch",
          cwd: "/controller/repo",
        }}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    // The remote identity is a profile-style pill (full name, tooltip +
    // copy carry the instance id), not a truncated masthead suffix.
    const remotePill = screen.getByLabelText("Remote instance");
    expect(remotePill).toHaveTextContent("Remote · Tart VM");
    expect(remotePill).not.toHaveTextContent("remote-instance");
    expect(
      screen.getByRole("button", {
        name: "Remote instance: Tart VM. Copy instance id.",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Runtime identity")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("PwrAgent profile")).not.toBeInTheDocument();
    expect(screen.queryByText("controller-branch")).not.toBeInTheDocument();
  });

  it("scrolls a newly selected thread row into view", () => {
    const { scrollIntoView, restore } = withMockScrollIntoView();
    const nextThread: NavigationThreadSummary = {
      ...sharedThread,
      id: "thread-next",
      title: "Next thread from history",
    };

    try {
      const { rerender } = render(
        <Sidebar
          backends={backends}
          browseMode="recents"
          createThreadError={undefined}
          directories={directories}
          inboxThreads={[sharedThread, nextThread]}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey="codex:thread-1"
          threads={[sharedThread, nextThread]}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );
      scrollIntoView.mockClear();

      rerender(
        <Sidebar
          backends={backends}
          browseMode="recents"
          createThreadError={undefined}
          directories={directories}
          inboxThreads={[sharedThread, nextThread]}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey="codex:thread-next"
          threads={[sharedThread, nextThread]}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "nearest",
      });
    } finally {
      restore();
    }
  });

  it("expands a user-collapsed directory and scrolls the selected thread into view", async () => {
    const { scrollIntoView, restore } = withMockScrollIntoView();
    const nextThread: NavigationThreadSummary = {
      ...sharedThread,
      id: "thread-in-projectb",
      title: "History target inside ProjectB",
      linkedDirectories: [
        {
          id: "dir-projectb",
          label: "ProjectB",
          path: "/Users/huntharo/pwrdrvr/ProjectB",
          kind: "local" as const,
        },
      ],
    };
    const projectBDirectory: NavigationDirectorySummary = {
      key: "directory:/Users/huntharo/pwrdrvr/ProjectB",
      kind: "directory",
      label: "ProjectB",
      path: "/Users/huntharo/pwrdrvr/ProjectB",
      threadKeys: ["codex:thread-in-projectb"],
      needsAttentionCount: 0,
      latestUpdatedAt: nextThread.updatedAt,
    };

    try {
      const { rerender } = render(
        <Sidebar
          backends={backends}
          browseMode="directories"
          createThreadError={undefined}
          directories={[directories[0]!, projectBDirectory]}
          inboxThreads={[sharedThread, nextThread]}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey="codex:thread-1"
          threads={[sharedThread, nextThread]}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

      const projectBSummary = screen
        .getAllByRole("button", { name: /ProjectB/i })
        .find((button) => button.hasAttribute("aria-expanded"));
      expect(projectBSummary).toBeDefined();
      expect(projectBSummary).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(projectBSummary!);
      expect(projectBSummary).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(projectBSummary!);
      expect(projectBSummary).toHaveAttribute("aria-expanded", "false");
      scrollIntoView.mockClear();

      rerender(
        <Sidebar
          backends={backends}
          browseMode="directories"
          createThreadError={undefined}
          directories={[directories[0]!, projectBDirectory]}
          inboxThreads={[sharedThread, nextThread]}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey="codex:thread-in-projectb"
          threads={[sharedThread, nextThread]}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

      await waitFor(() => {
        expect(projectBSummary).toHaveAttribute("aria-expanded", "true");
      });
      expect(
        screen.getByRole("button", { name: "History target inside ProjectB" }),
      ).toBeInTheDocument();
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "nearest",
      });
    } finally {
      restore();
    }
  });

  it("reveals a selected child through collapsed directory and parent disclosures", async () => {
    const { scrollIntoView, restore } = withMockScrollIntoView();
    const onSetDirectoryThreadsCollapsed = vi.fn(async () => undefined);
    const onSetSubthreadsCollapsed = vi.fn(async () => undefined);
    const pinnedThread: NavigationThreadSummary = {
      ...updatedSinceSeenThread,
      pinnedRank: "1024",
    };
    const parentThread: NavigationThreadSummary = {
      ...sharedThread,
      id: "thread-parent",
      title: "Collapsed parent thread",
      subthreadsCollapsed: true,
    };
    const childThread: NavigationThreadSummary = {
      ...sharedThread,
      id: "thread-child",
      title: "Hidden selected child",
      parentThreadId: parentThread.id,
    };
    const collapsedDirectory: NavigationDirectorySummary = {
      ...directories[0]!,
      directoryThreadsCollapsed: true,
      threadKeys: [
        "codex:thread-updated",
        "codex:thread-parent",
        "codex:thread-child",
      ],
    };
    const renderSidebar = (params: {
      directoryThreadsCollapsed: boolean;
      subthreadsCollapsed: boolean;
    }) => (
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[
          {
            ...collapsedDirectory,
            directoryThreadsCollapsed: params.directoryThreadsCollapsed,
          },
        ]}
        inboxThreads={[pinnedThread, parentThread, childThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        revealSelectedThreadRequest={1}
        selectedItemKey="codex:thread-child"
        threads={[
          pinnedThread,
          {
            ...parentThread,
            subthreadsCollapsed: params.subthreadsCollapsed,
          },
          childThread,
        ]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onSetDirectoryThreadsCollapsed={onSetDirectoryThreadsCollapsed}
        onSetSubthreadsCollapsed={onSetSubthreadsCollapsed}
      />
    );

    try {
      const { rerender } = render(
        renderSidebar({
          directoryThreadsCollapsed: true,
          subthreadsCollapsed: true,
        }),
      );

      expect(
        screen.getByRole("button", {
          name: "Show directory threads for PwrAgent",
        }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Hidden selected child" }),
      ).not.toBeInTheDocument();
      await waitFor(() => {
        expect(onSetDirectoryThreadsCollapsed).toHaveBeenCalledWith(
          expect.objectContaining({ key: collapsedDirectory.key }),
          false,
        );
        expect(onSetSubthreadsCollapsed).toHaveBeenCalledWith(
          expect.objectContaining({ id: parentThread.id }),
          false,
        );
      });

      scrollIntoView.mockClear();
      rerender(
        renderSidebar({
          directoryThreadsCollapsed: false,
          subthreadsCollapsed: false,
        }),
      );

      expect(
        await screen.findByRole("button", { name: "Hidden selected child" }),
      ).toBeInTheDocument();
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "nearest",
      });
    } finally {
      restore();
    }
  });

  it("reveals a selected thread after its directory membership refreshes", async () => {
    const { scrollIntoView, restore } = withMockScrollIntoView();
    const refreshedThread: NavigationThreadSummary = {
      ...sharedThread,
      id: "thread-after-refresh",
      title: "History target after refresh",
      linkedDirectories: [
        {
          id: "dir-projectb",
          label: "ProjectB",
          path: "/Users/huntharo/pwrdrvr/ProjectB",
          kind: "local" as const,
        },
      ],
    };
    const projectBWithoutThread: NavigationDirectorySummary = {
      key: "directory:/Users/huntharo/pwrdrvr/ProjectB",
      kind: "directory",
      label: "ProjectB",
      path: "/Users/huntharo/pwrdrvr/ProjectB",
      threadKeys: [],
      needsAttentionCount: 0,
      latestUpdatedAt: refreshedThread.updatedAt,
    };
    const projectBWithThread: NavigationDirectorySummary = {
      ...projectBWithoutThread,
      threadKeys: ["codex:thread-after-refresh"],
    };

    try {
      const { rerender } = render(
        <Sidebar
          backends={backends}
          browseMode="directories"
          createThreadError={undefined}
          directories={[directories[0]!, projectBWithoutThread]}
          inboxThreads={[sharedThread, refreshedThread]}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey="codex:thread-1"
          threads={[sharedThread, refreshedThread]}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

      const projectBSummary = screen
        .getAllByRole("button", { name: /ProjectB/i })
        .find((button) => button.hasAttribute("aria-expanded"));
      expect(projectBSummary).toBeDefined();
      fireEvent.click(projectBSummary!);
      expect(projectBSummary).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(projectBSummary!);
      expect(projectBSummary).toHaveAttribute("aria-expanded", "false");
      scrollIntoView.mockClear();

      rerender(
        <Sidebar
          backends={backends}
          browseMode="directories"
          createThreadError={undefined}
          directories={[directories[0]!, projectBWithoutThread]}
          inboxThreads={[sharedThread, refreshedThread]}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey="codex:thread-after-refresh"
          threads={[sharedThread, refreshedThread]}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );
      expect(projectBSummary).toHaveAttribute("aria-expanded", "false");
      expect(
        screen.queryByRole("button", { name: "History target after refresh" }),
      ).not.toBeInTheDocument();

      rerender(
        <Sidebar
          backends={backends}
          browseMode="directories"
          createThreadError={undefined}
          directories={[directories[0]!, projectBWithThread]}
          inboxThreads={[sharedThread, refreshedThread]}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey="codex:thread-after-refresh"
          threads={[sharedThread, refreshedThread]}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

      await waitFor(() => {
        expect(projectBSummary).toHaveAttribute("aria-expanded", "true");
      });
      expect(
        screen.getByRole("button", { name: "History target after refresh" }),
      ).toBeInTheDocument();
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "nearest",
      });
    } finally {
      restore();
    }
  });

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
    // The tabs render an icon and no visible text, so the accessible name is
    // the whole name — a tab that loses its aria-label announces as unlabeled.
    expect(lensTabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Attention, 0 active threads, 1 thread to review",
      // Drafts announces its emptiness even though it shows no badge: the
      // vanishing count is only readable if you can see the row.
      "Drafts, No threads with unsent drafts",
      "Updated",
      "Created",
      "Directories",
    ]);
    expect(lensTabs[4]).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText("PwrAgent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cross-project cleanup").length).toBeGreaterThan(0);
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThan(0);
  });

  it("shows masthead action tooltips and preserves button handlers", async () => {
    const onOpenAutomations = vi.fn();
    const onOpenSettings = vi.fn();
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
        onOpenAutomations={onOpenAutomations}
        onOpenLaunchpad={async () => undefined}
        onOpenSettings={onOpenSettings}
        onSelectThread={() => undefined}
      />
    );

    const searchButton = screen.getByRole("button", { name: "Search threads" });
    fireEvent.mouseEnter(searchButton);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Quick Thread List Search  (Ctrl+K)\nOpen Search All  (Ctrl+Shift+F)\nContext Search  (Ctrl+F) — Thread List in sidebar, Thread Chat elsewhere",
    );
    fireEvent.mouseLeave(searchButton);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const automationsButton = screen.getByRole("button", { name: "Open automations" });
    fireEvent.mouseEnter(automationsButton);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Open automations");
    fireEvent.click(automationsButton);
    expect(onOpenAutomations).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const settingsButton = screen.getByRole("button", { name: "Open settings" });
    fireEvent.focus(settingsButton);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Open settings");
    fireEvent.blur(settingsButton);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.click(settingsButton);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    // With no directory in context the New Thread button has no flyout, so it
    // keeps a plain "New thread" tooltip for parity with its siblings. The
    // tooltip/flyout live on the wrapper, so hover the wrapper, not the button.
    const newThreadButton = screen.getByRole("button", { name: "New thread" });
    fireEvent.mouseEnter(newThreadButton.parentElement as HTMLElement);
    expect((await screen.findByRole("tooltip")).textContent).toBe("New thread");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    vi.useFakeTimers();
    fireEvent.mouseLeave(newThreadButton.parentElement as HTMLElement);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.click(newThreadButton);
    expect(onCreateThread).toHaveBeenCalledTimes(1);
  });

  it("describes each thread lens with a custom tooltip and preserves selection", async () => {
    const onBrowseModeChange = vi.fn();

    render(
      <Sidebar
        backends={backends}
        browseMode="inbox"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={onBrowseModeChange}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const updatedTab = screen.getByRole("tab", { name: "Updated" });
    fireEvent.mouseEnter(updatedTab);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Updated — all threads, most recently updated first"
    );
    fireEvent.mouseLeave(updatedTab);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const createdTab = screen.getByRole("tab", { name: "Created" });
    fireEvent.focus(createdTab);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Created — all threads, newest created first"
    );

    // Selecting a lens still works and the tooltip dismisses on click.
    fireEvent.click(createdTab);
    expect(onBrowseModeChange).toHaveBeenCalledWith("recents");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("reveals the New Thread flyout on hover when a directory is in context", async () => {
    const onAddProjectDirectory = vi.fn(async () => undefined);
    const onCreateThread = vi.fn(async () => undefined);
    const onCreateThreadWithoutDirectory = vi.fn(async () => undefined);

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
        newThreadDirectoryLabel="PwrAgnt"
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onAddProjectDirectory={onAddProjectDirectory}
        onBrowseModeChange={() => undefined}
        onCreateThread={onCreateThread}
        onCreateThreadWithoutDirectory={onCreateThreadWithoutDirectory}
        onOpenAutomations={() => undefined}
        onOpenLaunchpad={async () => undefined}
        onOpenSettings={() => undefined}
        onSelectThread={() => undefined}
      />
    );

    const newThreadButton = screen.getByRole("button", { name: "New thread" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.mouseEnter(newThreadButton.parentElement as HTMLElement);
    await screen.findByRole("menuitem", { name: "New chat in PwrAgnt" });

    fireEvent.click(
      screen.getByRole("menuitem", { name: "New chat without a directory" })
    );
    expect(onCreateThreadWithoutDirectory).toHaveBeenCalledTimes(1);
    expect(onCreateThread).not.toHaveBeenCalled();

    fireEvent.mouseEnter(newThreadButton.parentElement as HTMLElement);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "New chat in PwrAgnt" })
    );
    expect(onCreateThread).toHaveBeenCalledTimes(1);

    fireEvent.mouseEnter(newThreadButton.parentElement as HTMLElement);
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Add a Project Directory…",
      }),
    );
    expect(onAddProjectDirectory).toHaveBeenCalledTimes(1);
  });

  it("groups sub-threads under their parent and persists collapse clicks", () => {
    const childThread = {
      ...sharedThread,
      id: "thread-review",
      title: "Adversarial review",
      parentThreadId: sharedThread.id,
      updatedAt: sharedThread.updatedAt + 1,
    };
    const onSetSubthreadsCollapsed = vi.fn(async () => undefined);

    const { container } = render(
      <Sidebar
        backends={backends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[childThread, sharedThread]}
        loading={false}
        selectedItemKey="codex:thread-1"
        threads={[childThread, sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onSetSubthreadsCollapsed={onSetSubthreadsCollapsed}
      />,
    );

    expect(container.querySelector(".subthread-list")).not.toBeNull();
    expect(screen.getByRole("button", { name: /^Cross-project cleanup/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adversarial review" })).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Collapse sub-threads for Cross-project cleanup",
      }),
    );
    expect(onSetSubthreadsCollapsed).toHaveBeenCalledWith(sharedThread, true);
  });

  it("does not expose sub-thread disclosure controls for an older remote peer", () => {
    const remoteParent: NavigationThreadSummary = {
      ...sharedThread,
      federation: {
        capabilities: ["thread_navigation"],
        instanceLabel: "Older Mac",
        peerStatus: "connected",
        ref: {
          backend: "codex",
          target: { scope: "remote", instanceId: "older-peer" },
          threadId: sharedThread.id,
        },
      },
    };
    const childThread: NavigationThreadSummary = {
      ...sharedThread,
      id: "thread-review",
      title: "Adversarial review",
      parentThreadId: remoteParent.id,
    };
    const onSetSubthreadsCollapsed = vi.fn(async () => undefined);

    render(
      <Sidebar
        backends={backends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[childThread, remoteParent]}
        loading={false}
        selectedItemKey="codex:thread-1"
        threads={[childThread, remoteParent]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onSetSubthreadsCollapsed={onSetSubthreadsCollapsed}
      />,
    );

    expect(
      screen.queryByRole("button", {
        name: "Collapse sub-threads for Cross-project cleanup",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Adversarial review" }),
    ).toBeInTheDocument();
  });

  it("groups a Codex child under its pinned ACP parent in Inbox", () => {
    const parentThread: NavigationThreadSummary = {
      ...sharedThread,
      id: "kimi-parent",
      title: "Federation migration parent",
      source: "acp:kimi",
      pinnedRank: "1024",
    };
    const childThread: NavigationThreadSummary = {
      ...sharedThread,
      id: "codex-child",
      title: "Federation migration child",
      parentThreadId: parentThread.id,
    };

    const { container } = render(
      <Sidebar
        backends={backends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[childThread, parentThread]}
        loading={false}
        selectedItemKey="codex:codex-child"
        threads={[childThread, parentThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    const childButton = screen.getByRole("button", {
      name: "Federation migration child",
    });
    expect(container.querySelector(".subthread-list")).toContainElement(
      threadCard(childButton),
    );
  });

  it("groups a Codex child under its pinned ACP parent in Directories", () => {
    const parentThread: NavigationThreadSummary = {
      ...sharedThread,
      id: "kimi-parent",
      title: "Federation directory parent",
      source: "acp:kimi",
      pinnedRank: "1024",
    };
    const childThread: NavigationThreadSummary = {
      ...sharedThread,
      id: "codex-child",
      title: "Federation directory child",
      parentThreadId: parentThread.id,
    };
    const directory: NavigationDirectorySummary = {
      ...directories[0]!,
      threadKeys: ["acp:kimi:kimi-parent", "codex:codex-child"],
    };

    const { container } = render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        directories={[directory]}
        inboxThreads={[childThread, parentThread]}
        loading={false}
        selectedItemKey="codex:codex-child"
        threads={[childThread, parentThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    const childButton = screen.getByRole("button", {
      name: "Federation directory child",
    });
    expect(container.querySelector(".subthread-list")).toContainElement(
      threadCard(childButton),
    );
  });

  it("keeps native Codex workers in an on-demand sub-agent disclosure", () => {
    const openSubAgentTranscriptWindow = vi.fn(async () => ({ opened: true }));
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: { openSubAgentTranscriptWindow },
    });
    const parentThread: NavigationThreadSummary = {
      ...sharedThread,
      id: "thread-native-parent",
      title: "Coordinate the launch",
      codexNativeSubAgents: [
        {
          threadId: "thread-native-worker",
          title: "Investigate the launch plan",
          depth: 1,
          agentNickname: "launch-scout",
          agentRole: "researcher",
          threadStatus: "idle",
        },
        {
          threadId: "thread-native-worker-child",
          title: "Verify the source links",
          depth: 2,
          agentNickname: "link-checker",
          agentRole: "reviewer",
          threadStatus: "active",
        },
        {
          threadId: "thread-native-worker-not-loaded",
          title: "Review the archived brief",
          depth: 1,
          agentNickname: "archive-scout",
          agentRole: "researcher",
          threadStatus: "notLoaded",
        },
      ],
    };
    const renderSidebar = (thread: NavigationThreadSummary) => (
      <Sidebar
        backends={backends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[thread]}
        loading={false}
        selectedItemKey="codex:thread-native-parent"
        threads={[thread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const { container } = render(renderSidebar(parentThread));

    expect(screen.getByRole("button", { name: "Coordinate the launch" })).toBeInTheDocument();
    expect(screen.queryByText("launch-scout")).not.toBeInTheDocument();

    const nativeSubAgentsToggle = screen.getByRole("button", {
      name: "Expand 3 native Codex sub-agents",
    });
    expect(screen.queryByText("launch-scout")).not.toBeInTheDocument();

    fireEvent.click(nativeSubAgentsToggle);

    expect(container.querySelectorAll(".native-subagents__list")).toHaveLength(1);
    expect(container.querySelectorAll(".native-subagents__agent")).toHaveLength(3);
    expect(container.querySelectorAll(".native-subagents__status")).toHaveLength(1);
    expect(screen.getByLabelText("Working")).toBeInTheDocument();
    expect(screen.queryByLabelText("Idle")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Not loaded")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open transcript for link-checker" }),
    );
    expect(openSubAgentTranscriptWindow).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-native-worker-child",
      title: "link-checker",
    });

    delete (window as Window & { pwragent?: unknown }).pwragent;
  });

  it("keeps native Codex workers out of directory thread rows", () => {
    const parentThread: NavigationThreadSummary = {
      ...sharedThread,
      id: "thread-directory-native-parent",
      title: "Coordinate the directory launch",
      codexNativeSubAgents: [
        {
          threadId: "thread-directory-native-worker",
          title: "Inspect the directory plan",
          depth: 1,
          agentNickname: "directory-scout",
          threadStatus: "idle",
        },
      ],
    };
    const directory: NavigationDirectorySummary = {
      ...directories[0]!,
      threadKeys: ["codex:thread-directory-native-parent"],
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        directories={[directory]}
        inboxThreads={[parentThread]}
        loading={false}
        selectedItemKey="codex:thread-directory-native-parent"
        threads={[parentThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Expand 1 native Codex sub-agents" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("directory-scout")).not.toBeInTheDocument();
  });

  it("opens worktree sub-thread launchpads from the thread context menu", () => {
    const onCreateSubthread = vi.fn(async () => undefined);
    render(
      <Sidebar
        backends={backends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[sharedThread]}
        loading={false}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onCreateSubthread={onCreateSubthread}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /^Cross-project cleanup/ }));
    expect(screen.queryByRole("menuitem", { name: "Sub-thread in Local" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sub-thread in Same Worktree" }));

    expect(onCreateSubthread).toHaveBeenCalledWith(sharedThread, "same-worktree");
  });

  it("offers viewer-owned pin, pin removal, and copy actions for a remote-pinned row", () => {
    const onRemoveRemoteThreadPin = vi.fn(async () => undefined);
    const onSetThreadPin = vi.fn(async () => undefined);
    const remotePinnedThread: NavigationThreadSummary = {
      ...sharedThread,
      id: "thread-remote",
      title: "Remote pinned thread",
      federation: {
        ref: {
          backend: "codex",
          target: { scope: "remote", instanceId: "peer-laptop" },
          threadId: "thread-remote",
        },
        instanceLabel: "Laptop",
        // Removal is a viewer-side delete: it must work while the owning
        // instance is unreachable.
        peerStatus: "disconnected",
        capabilities: [],
      },
    };
    render(
      <Sidebar
        backends={backends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[remotePinnedThread]}
        loading={false}
        selectedItemKey="codex:thread-remote"
        threads={[remotePinnedThread]}
        onArchiveThread={async () => undefined}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onCreateSubthread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onRemoveRemoteThreadPin={onRemoveRemoteThreadPin}
        onRenameThread={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadPin={onSetThreadPin}
      />,
    );

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Remote pinned thread" }),
    );

    // Owner-mutating actions are absent…
    expect(screen.queryByRole("menuitem", { name: "Archive Thread" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Rename Thread" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /Sub-thread/ }),
    ).toBeNull();

    // …the VIEWER-owned pin is offered (rank lives on the pin row, never
    // the owner's list)…
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin Thread" }));
    expect(onSetThreadPin).toHaveBeenCalledWith(remotePinnedThread, true);

    // …and the viewer-side removal dispatches even while disconnected.
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Remote pinned thread" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Remove from My List/ }),
    );
    expect(onRemoveRemoteThreadPin).toHaveBeenCalledWith(remotePinnedThread);
  });

  it("does not offer removal for a child derived from a mounted parent", () => {
    const derivedChild: NavigationThreadSummary = {
      ...sharedThread,
      id: "thread-derived-child",
      title: "Derived remote child",
      parentThreadId: "thread-remote-root",
      federation: {
        ref: {
          backend: "codex",
          target: { scope: "remote", instanceId: "peer-mini" },
          threadId: "thread-derived-child",
        },
        instanceLabel: "Mac Mini",
        peerStatus: "connected",
        capabilities: [],
        derivedFromMountedParent: true,
      },
    };
    render(
      <Sidebar
        backends={backends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[derivedChild]}
        loading={false}
        selectedItemKey="codex:thread-derived-child"
        threads={[derivedChild]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onRemoveRemoteThreadPin={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Derived remote child" }),
    );

    expect(
      screen.queryByRole("menuitem", { name: /Remove from My List/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Unlink from Parent" }),
    ).toBeNull();
  });

  it("offers owner-routed actions for a connected remote child", () => {
    const remoteBackends: BackendSummary[] = [{
      ...backends[0]!,
      capabilities: {
        ...backends[0]!.capabilities,
        forkThread: true,
      },
    }];
    const remoteChild: NavigationThreadSummary = {
      ...sharedThread,
      id: "thread-remote-child",
      title: "Remote child",
      inbox: { inInbox: false },
      parentThreadId: "thread-local-parent",
      parentThreadBackend: "codex",
      parentThreadInstanceId: "local-instance",
      federation: {
        ref: {
          backend: "codex",
          target: { scope: "remote", instanceId: "peer-mini" },
          threadId: "thread-remote-child",
        },
        instanceLabel: "Mac Mini",
        peerStatus: "connected",
        capabilities: [
          "environment_actions",
          "launchpad_metadata",
          "thread_navigation",
          "turn_control",
        ],
      },
    };
    render(
      <Sidebar
        backends={remoteBackends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[remoteChild]}
        loading={false}
        selectedItemKey="codex:thread-remote-child"
        threads={[remoteChild]}
        onArchiveThread={async () => undefined}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onCreateSubthread={async () => undefined}
        onForkThread={async () => undefined}
        onMarkThreadUnread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onRenameThread={async () => undefined}
        onSelectThread={() => undefined}
        onUnlinkThreads={async () => undefined}
      />,
    );

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Remote child" }),
    );

    expect(screen.getByRole("menuitem", {
      name: "Sub-thread in Same Worktree",
    })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", {
      name: "Fork into Same Worktree",
    })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", {
      name: "Unlink from Parent",
    })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", {
      name: "Rename Thread",
    })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", {
      name: "Mark Unread",
    })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", {
      name: "Archive Thread",
    })).toBeInTheDocument();
  });

  it("closes its context menu when another renderer menu opens", () => {
    render(
      <Sidebar
        backends={backends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[sharedThread]}
        loading={false}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /^Cross-project cleanup/ }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.contextMenu(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers Local and New Worktree sub-thread launchpads for local parents", () => {
    const onCreateSubthread = vi.fn(async () => undefined);
    render(
      <Sidebar
        backends={backends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[localThread]}
        loading={false}
        selectedItemKey="codex:thread-local"
        threads={[localThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onCreateSubthread={onCreateSubthread}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Local checkout cleanup" }));
    expect(screen.queryByRole("menuitem", { name: "Sub-thread in Same Worktree" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sub-thread in Local" }));

    expect(onCreateSubthread).toHaveBeenCalledWith(localThread, "local");

    fireEvent.contextMenu(screen.getByRole("button", { name: "Local checkout cleanup" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sub-thread in New Worktree" }));

    expect(onCreateSubthread).toHaveBeenCalledWith(localThread, "new-worktree");
  });

  it("forks a Codex thread from the thread context menu", () => {
    const onForkThread = vi.fn(async () => undefined);
    const forkBackends: BackendSummary[] = [
      {
        ...backends[0]!,
        capabilities: {
          ...backends[0]!.capabilities,
          forkThread: true,
        },
      },
    ];
    render(
      <Sidebar
        backends={forkBackends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[sharedThread]}
        loading={false}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onForkThread={onForkThread}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /^Cross-project cleanup/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork into New Worktree" }));

    expect(onForkThread).toHaveBeenCalledWith(sharedThread, "new-worktree");
  });

  it("offers Local and New Worktree forks for local parent threads", () => {
    const onForkThread = vi.fn(async () => undefined);
    const forkBackends: BackendSummary[] = [
      {
        ...backends[0]!,
        capabilities: {
          ...backends[0]!.capabilities,
          forkThread: true,
        },
      },
    ];
    render(
      <Sidebar
        backends={forkBackends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[localThread]}
        loading={false}
        selectedItemKey="codex:thread-local"
        threads={[localThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onForkThread={onForkThread}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Local checkout cleanup" }));
    expect(screen.queryByRole("menuitem", { name: "Fork into Same Worktree" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork in Local" }));

    expect(onForkThread).toHaveBeenCalledWith(localThread, "local");

    fireEvent.contextMenu(screen.getByRole("button", { name: "Local checkout cleanup" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork into New Worktree" }));

    expect(onForkThread).toHaveBeenCalledWith(localThread, "new-worktree");
  });

  it("hides fork actions when the backend does not advertise fork support", () => {
    const onForkThread = vi.fn(async () => undefined);
    render(
      <Sidebar
        backends={backends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[sharedThread]}
        loading={false}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onForkThread={onForkThread}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /^Cross-project cleanup/ }));

    expect(screen.queryByRole("menuitem", { name: "Fork into Same Worktree" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Fork into New Worktree" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Fork in Local" })).toBeNull();
  });

  it("exposes sub-thread and fork actions on a child card", () => {
    const onCreateSubthread = vi.fn(async () => undefined);
    const onForkThread = vi.fn(async () => undefined);
    const forkBackends: BackendSummary[] = [
      {
        ...backends[0]!,
        capabilities: { ...backends[0]!.capabilities, forkThread: true },
      },
    ];
    const childThread = {
      ...sharedThread,
      id: "thread-child",
      title: "Child cleanup",
      parentThreadId: sharedThread.id,
      updatedAt: sharedThread.updatedAt + 1,
    };
    render(
      <Sidebar
        backends={forkBackends}
        browseMode="inbox"
        directories={directories}
        inboxThreads={[childThread, sharedThread]}
        loading={false}
        selectedItemKey="codex:thread-1"
        threads={[childThread, sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onCreateSubthread={onCreateSubthread}
        onForkThread={onForkThread}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    // A child card now offers the same spawn actions; the parent hook
    // re-parents the result to the group root, so the menu can stay open.
    fireEvent.contextMenu(screen.getByRole("button", { name: "Child cleanup" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Sub-thread in Same Worktree" }),
    );
    expect(onCreateSubthread).toHaveBeenCalledWith(childThread, "same-worktree");

    fireEvent.contextMenu(screen.getByRole("button", { name: "Child cleanup" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Fork into Same Worktree" }),
    );
    expect(onForkThread).toHaveBeenCalledWith(childThread, "same-worktree");
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
    const threadRow = threadCard(
      within(browseSection as HTMLElement).getByRole("button", {
        name: /Cross-project cleanup/i,
      }),
    );

    expect(within(threadRow).getByLabelText("Copy path for worktree PwrAgent")).toHaveTextContent(
      "PwrAgent"
    );
    expect(within(threadRow).queryByText("worktree")).not.toBeInTheDocument();
  });

  it("keeps kind chips for single-directory rows", () => {
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
    const directorySummary = within(browseSection as HTMLElement)
      .getAllByRole("button", { name: /PwrAgent/i })
      .find((button) => button.hasAttribute("aria-expanded"));
    expect(directorySummary).toBeDefined();
    fireEvent.click(directorySummary!);
    const worktreeThreadRow = threadCard(
      within(browseSection as HTMLElement).getByRole("button", {
        name: /Cross-project cleanup/i,
      }),
    );
    const localThreadRow = threadCard(
      within(browseSection as HTMLElement).getByRole("button", {
        name: /Local cleanup/i,
      }),
    );

    // Kind chips are icon-only since the 2026-08 density pass — the
    // worktree/local word lives in the copyable chip's aria-label, not
    // as visible chip text.
    expect(
      within(worktreeThreadRow).getByLabelText("Copy path for worktree PwrAgent"),
    ).toBeInTheDocument();
    expect(within(worktreeThreadRow).queryByText("worktree")).not.toBeInTheDocument();
    expect(within(worktreeThreadRow).queryByText("PwrAgent")).not.toBeInTheDocument();
    expect(
      within(localThreadRow).getByLabelText("Copy local path for PwrAgent"),
    ).toBeInTheDocument();
    expect(within(localThreadRow).queryByText("local")).not.toBeInTheDocument();
  });

  it("names every linked project in multi-directory rows", () => {
    const multiDirectoryThread = {
      ...sharedThread,
      id: "thread-multiple-directories",
      title: "Prepare PwrGit branding assets",
      linkedDirectories: [
        {
          id: "dir-pwrgit",
          label: "PwrGit",
          path: "/Users/huntharo/github/PwrGit",
          worktreePath: "/Users/huntharo/.codex/worktrees/pwrgit/PwrGit",
          kind: "worktree" as const,
        },
        {
          id: "dir-pwragnt",
          label: "PwrAgnt",
          path: "/Users/huntharo/github/PwrAgnt",
          kind: "local" as const,
        },
        {
          id: "dir-pwrsnap",
          label: "PwrSnap",
          path: "/Users/huntharo/github/PwrSnap",
          kind: "local" as const,
        },
      ],
    };
    const pwrGitDirectory: NavigationDirectorySummary = {
      key: "directory:/Users/huntharo/github/PwrGit",
      kind: "directory",
      label: "PwrGit",
      path: "/Users/huntharo/github/PwrGit",
      threadKeys: ["codex:thread-multiple-directories"],
      needsAttentionCount: 0,
      latestUpdatedAt: multiDirectoryThread.updatedAt,
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[pwrGitDirectory]}
        inboxThreads={[multiDirectoryThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[multiDirectoryThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    const browseSection = screen.getByRole("region", { name: "Thread browser" });
    const pwrGitDirectorySummary = within(browseSection as HTMLElement)
      .getAllByRole("button", { name: /^PwrGit(?:,|$)/ })
      .find((button) => button.hasAttribute("aria-expanded"));
    expect(pwrGitDirectorySummary).toBeDefined();
    fireEvent.click(pwrGitDirectorySummary!);
    const threadRow = threadCard(
      within(browseSection as HTMLElement).getByRole("button", {
        name: "Prepare PwrGit branding assets",
      }),
    );

    expect(
      within(threadRow).getByLabelText("Copy path for worktree PwrGit"),
    ).toHaveTextContent("PwrGit");
    expect(
      within(threadRow).getByLabelText("Copy path for PwrAgnt"),
    ).toHaveTextContent("PwrAgnt");
    expect(
      within(threadRow).getByLabelText("Copy path for PwrSnap"),
    ).toHaveTextContent("PwrSnap");
    expect(within(threadRow).queryByText("worktree")).not.toBeInTheDocument();
    expect(within(threadRow).queryByText("local")).not.toBeInTheDocument();
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

  it("shows mounted projects that are not configured on this instance", async () => {
    const unconfiguredDirectory: NavigationDirectorySummary = {
      key: "unconfigured-directory:grok-build",
      kind: "directory",
      label: "grok-build",
      localAvailability: "unconfigured",
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 0,
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[unconfiguredDirectory]}
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
      />,
    );

    const summary = screen.getByRole("button", {
      name: /^grok-build, not configured on this instance/,
    });
    expect(summary).toHaveClass("directory-row__summary--unconfigured");
    expect(screen.queryByRole("button", {
      name: "Open new thread launchpad for grok-build",
    })).not.toBeInTheDocument();

    fireEvent.mouseEnter(summary);
    expect(await screen.findByText(
      "This project directory isn't configured on this instance. Use Add Directory to connect it.",
    )).toBeInTheDocument();
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

    const thinkingIndicator = threadCard(threadButton).querySelector('[data-thread-status="thinking"]');
    expect(thinkingIndicator).not.toBeNull();
    expect(thinkingIndicator).toHaveAttribute("aria-label", "Thinking");
    expect(thinkingIndicator).toHaveAttribute("title", "Thinking");
    expect(threadCard(threadButton).querySelector('[data-thread-status="unread"]')).toBeNull();
  });

  it("shows thinking from backend runtime status after renderer HMR", () => {
    const activeThread = {
      ...sharedThread,
      threadStatus: "active" as const,
    };
    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[activeThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        threads={[activeThread]}
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

    expect(
      threadCard(threadButton).querySelector('[data-thread-status="thinking"]')
    ).not.toBeNull();
  });

  it("separates active and reviewable threads in directory counts", async () => {
    const backendActiveThread = {
      ...sharedThread,
      id: "thread-backend-active",
      title: "Backend-reported active thread",
      threadStatus: "active" as const,
    };
    const locallyThinkingThread = {
      ...sharedThread,
      id: "thread-locally-thinking",
      title: "Locally initiated active thread",
    };
    const idleThread = {
      ...sharedThread,
      id: "thread-idle",
      title: "Idle thread",
      threadStatus: "idle" as const,
      inbox: {
        inInbox: true,
        reason: "updated-since-seen" as const,
        lastSeenUpdatedAt: sharedThread.updatedAt - 1,
      },
    };
    const directory: NavigationDirectorySummary = {
      ...directories[0]!,
      // The summary's persisted Inbox aggregate includes all three threads,
      // but the renderer must not count the two active ones again as review.
      needsAttentionCount: 3,
      threadKeys: [
        "codex:thread-backend-active",
        "codex:thread-locally-thinking",
        "codex:thread-idle",
      ],
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[directory]}
        inboxThreads={[backendActiveThread, locallyThinkingThread, idleThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey={undefined}
        thinkingThreadKeys={{ "codex:thread-locally-thinking": true }}
        threads={[backendActiveThread, locallyThinkingThread, idleThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    // The activity signal lives on the Attention tab now, not on Directories.
    expect(screen.getByRole("tab", { name: "Directories" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", {
        name: "Attention, 2 active threads, 1 thread to review",
      }),
    ).toBeInTheDocument();

    const summary = screen
      .getAllByRole("button", { name: /PwrAgent/i })
      .find((button) => button.hasAttribute("aria-expanded"));
    expect(summary).toBeDefined();
    // Indicator + bare count only: the words live in the hover tooltip, and
    // the button's aria-label still spells both out for assistive tech.
    const activeCount = summary!.querySelector("[data-active-thread-count]");
    expect(activeCount).toHaveAttribute("data-active-thread-count", "2");
    expect(activeCount).toHaveTextContent(/^2$/);
    const reviewCount = summary!.querySelector("[data-review-thread-count]");
    expect(reviewCount).toHaveAttribute("data-review-thread-count", "1");
    expect(reviewCount).toHaveTextContent(/^1$/);

    fireEvent.mouseEnter(activeCount!);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "2 active threads",
    );
    fireEvent.mouseLeave(activeCount!);

    fireEvent.mouseEnter(reviewCount!);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "1 thread to review",
    );
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
    const threadRow = threadCard(
      within(browseSection as HTMLElement).getByRole("button", {
        name: /Cross-project cleanup/i,
      }),
    );

    const approvalChip = within(threadRow).getByTitle("Waiting for approval");
    expect(approvalChip).toHaveTextContent("Waiting for approval");
    expect(approvalChip).not.toHaveTextContent("!");
    expect(approvalChip).toHaveAttribute("title", "Waiting for approval");
  });

  it("shows an input-needed chip for threads waiting on user input", () => {
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
        inputRequestThreadKeys={{ "codex:thread-1": true }}
        selectedItemKey={undefined}
        threads={[sharedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const browseSection = screen.getByRole("region", { name: "Thread browser" });
    const threadRow = threadCard(
      within(browseSection as HTMLElement).getByRole("button", {
        name: /Cross-project cleanup/i,
      }),
    );

    const inputChip = within(threadRow).getByTitle("Input needed");
    expect(inputChip).toHaveTextContent("Input needed");
    expect(inputChip).not.toHaveTextContent("Approve");
    expect(inputChip).toHaveAttribute("title", "Input needed");
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

    expect(threadCard(threadButton).querySelector('[data-thread-status="thinking"]')).toBeNull();
    expect(threadCard(threadButton).querySelector('[data-thread-status="unread"]')).toBeNull();
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

    expect(threadCard(threadButton).querySelector('[data-thread-status="thinking"]')).toBeNull();
    const unreadIndicator = threadCard(threadButton).querySelector('[data-thread-status="unread"]');
    expect(unreadIndicator).not.toBeNull();
    expect(unreadIndicator).toHaveAttribute("aria-label", "Unread update");
    expect(unreadIndicator).toHaveAttribute("title", "Unread update");
    expect(
      threadCard(threadButton).querySelector('[data-thread-status="unread"] .thread-row__status-cookie')
    ).not.toBeNull();
    expect(unreadIndicator).not.toHaveTextContent("!");
  });

  describe("Attention lens", () => {
    const activeThread = {
      ...sharedThread,
      id: "thread-active",
      title: "Active thread",
      threadStatus: "active" as const,
      inbox: { inInbox: false },
    };
    const unreadThread = {
      ...updatedSinceSeenThread,
      id: "thread-unread",
      title: "Unread thread",
    };
    const idleThread = {
      ...sharedThread,
      id: "thread-idle",
      title: "Idle thread",
      inbox: { inInbox: false },
    };
    const allThreads = [activeThread, unreadThread, idleThread];

    const renderAttention = (
      browseMode: "attention" | "inbox" = "attention",
      onBrowseModeChange = vi.fn(),
    ) =>
      render(
        <Sidebar
          backends={backends}
          browseMode={browseMode}
          createThreadError={undefined}
          directories={directories}
          inboxThreads={allThreads}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey={undefined}
          threads={allThreads}
          onBrowseModeChange={onBrowseModeChange}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

    it("lists only threads in progress or waiting to be reviewed", () => {
      renderAttention();

      const browseSection = screen.getByRole("region", {
        name: "Thread browser",
      });
      const rows = within(browseSection as HTMLElement).getAllByRole("button", {
        name: /Active thread|Unread thread|Idle thread/i,
      });
      expect(rows.map((row) => threadCard(row).textContent)).toEqual([
        expect.stringContaining("Active thread"),
        expect.stringContaining("Unread thread"),
      ]);
    });

    it("holds row order while live turns keep re-sorting the snapshot", () => {
      // The snapshot arrives in most-recently-updated order, and a running
      // turn rewrites `updatedAt` on every streamed item, so the incoming
      // order flips constantly while two turns are live. The lens ranks by
      // turn instead — see attention-order.ts — so the rows must not move.
      const secondActiveThread = {
        ...activeThread,
        id: "thread-active-2",
        title: "Second active thread",
      };
      const props = {
        backends,
        browseMode: "attention" as const,
        createThreadError: undefined,
        directories,
        launchpadError: undefined,
        loading: false,
        creatingThread: undefined,
        selectedItemKey: undefined,
        onBrowseModeChange: () => undefined,
        onCreateThread: async () => undefined,
        onOpenLaunchpad: async () => undefined,
        onSelectThread: () => undefined,
      };
      const attentionRowTitles = () => {
        const browseSection = screen.getByRole("region", {
          name: "Thread browser",
        });
        return within(browseSection as HTMLElement)
          .getAllByRole("button", {
            name: /Active thread|Second active thread/i,
          })
          .map((row) => (threadCard(row).textContent?.includes("Second") ? "second" : "first"));
      };

      const ordered = [activeThread, secondActiveThread];
      const { rerender } = render(
        <Sidebar {...props} inboxThreads={ordered} threads={ordered} />,
      );
      expect(attentionRowTitles()).toEqual(["first", "second"]);

      const reordered = [secondActiveThread, activeThread];
      rerender(<Sidebar {...props} inboxThreads={reordered} threads={reordered} />);
      expect(attentionRowTitles()).toEqual(["first", "second"]);
    });

    it("reports both counts on the tab and switches to the lens", () => {
      const onBrowseModeChange = vi.fn();
      renderAttention("inbox", onBrowseModeChange);

      const tab = screen.getByRole("tab", {
        name: "Attention, 1 active thread, 1 thread to review",
      });
      expect(tab).toHaveAttribute("aria-selected", "false");
      expect(
        tab.querySelector("[data-attention-active-count]"),
      ).toHaveAttribute("data-attention-active-count", "1");
      expect(
        tab.querySelector("[data-attention-review-count]"),
      ).toHaveAttribute("data-attention-review-count", "1");

      fireEvent.click(tab);
      expect(onBrowseModeChange).toHaveBeenCalledWith("attention");
    });

    it("greys both signals — and keeps their zeros — when nothing needs attention", () => {
      render(
        <Sidebar
          backends={backends}
          browseMode="inbox"
          createThreadError={undefined}
          directories={directories}
          inboxThreads={[idleThread]}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey={undefined}
          threads={[idleThread]}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

      const tab = screen.getByRole("tab", {
        name: "Attention, 0 active threads, 0 threads to review",
      });
      // The zeros stay on the tab: an idle lens has to be distinguishable
      // from a lens that lost its counts without being opened.
      const active = tab.querySelector("[data-attention-active-count]");
      const review = tab.querySelector("[data-attention-review-count]");
      expect(active).toHaveTextContent(/^0$/);
      expect(review).toHaveTextContent(/^0$/);
      expect(active).toHaveAttribute("data-zero", "true");
      expect(review).toHaveAttribute("data-zero", "true");
    });

    it("re-pins the scanner to the shared animation epoch when the count leaves zero", () => {
      // Every thinking scanner in the app is pinned to one document-timeline
      // origin on mount (ThinkingScanner.tsx, PR #1187) so no two sweeping
      // bars are ever visibly out of phase. The zero state must therefore be
      // a DIFFERENT element, not a `ThinkingScanner` with its animation
      // switched off in CSS: `data-zero` sits on the parent span, so React
      // would keep the same scanner across the flip, its ref would never
      // re-run, and the animation CSS restarts would run unpinned forever.
      const animations = [{ startTime: 4242 }];
      let animationIndex = 0;
      const getAnimations = vi.fn(() => {
        const animation = animations[animationIndex++];
        return animation ? [animation] : [];
      });
      const originalDescriptor = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "getAnimations",
      );
      Object.defineProperty(HTMLElement.prototype, "getAnimations", {
        configurable: true,
        value: getAnimations,
      });

      try {
        const idle = { ...idleThread };
        const busy = { ...idleThread, threadStatus: "active" as const };
        const sidebarProps = (threads: typeof allThreads) => ({
          backends,
          browseMode: "inbox" as const,
          createThreadError: undefined,
          directories,
          inboxThreads: threads,
          launchpadError: undefined,
          loading: false,
          creatingThread: undefined,
          selectedItemKey: undefined,
          threads,
          onBrowseModeChange: () => undefined,
          onCreateThread: async () => undefined,
          onOpenLaunchpad: async () => undefined,
          onSelectThread: () => undefined,
        });

        const view = render(<Sidebar {...sidebarProps([idle])} />);

        const zeroTab = screen.getByRole("tab", { name: /^Attention,/ });
        expect(
          zeroTab.querySelector(".lens-switch__dormant-scanner"),
        ).not.toBeNull();
        expect(zeroTab.querySelector(".thinking-scanner")).toBeNull();
        expect(getAnimations).not.toHaveBeenCalled();

        // 0 -> 1: the scanner must MOUNT here, which is what runs the sync ref.
        view.rerender(<Sidebar {...sidebarProps([busy])} />);

        const liveTab = screen.getByRole("tab", { name: /^Attention,/ });
        expect(liveTab.querySelector(".thinking-scanner")).not.toBeNull();
        expect(
          liveTab.querySelector(".lens-switch__dormant-scanner"),
        ).toBeNull();
        expect(getAnimations).toHaveBeenCalled();
        expect(animations[0]!.startTime).toBe(0);
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(
            HTMLElement.prototype,
            "getAnimations",
            originalDescriptor,
          );
        } else {
          Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
        }
      }
    });

    describe("remote turn readout", () => {
      const remoteActiveThread = {
        ...activeThread,
        id: "thread-remote-active",
        title: "Remote active thread",
        federation: {
          instanceLabel: "studio",
          ref: {
            backend: "codex" as const,
            target: { scope: "remote" as const, instanceId: "peer-1" },
            threadId: "thread-remote-active",
          },
        },
      };
      const remoteSidebarProps = (threads: typeof allThreads) => ({
        backends,
        browseMode: "inbox" as const,
        createThreadError: undefined,
        directories,
        inboxThreads: threads,
        launchpadError: undefined,
        loading: false,
        creatingThread: undefined,
        selectedItemKey: undefined,
        threads,
        onBrowseModeChange: () => undefined,
        onCreateThread: async () => undefined,
        onOpenLaunchpad: async () => undefined,
        onSelectThread: () => undefined,
      });

      it("stays off the tab entirely when no peer work has run", () => {
        // The whole point of the second readout is that an operator who never
        // federates sees the tab they always had. A permanent "0" would put a
        // federation concept on every instance's sidebar.
        render(<Sidebar {...remoteSidebarProps([activeThread, unreadThread])} />);

        const tab = screen.getByRole("tab", {
          name: "Attention, 1 active thread, 1 thread to review",
        });
        expect(
          tab.querySelector("[data-attention-remote-active-count]"),
        ).toBeNull();
      });

      it("splits local from peer turns, and says which blocks quitting", () => {
        render(
          <Sidebar
            {...remoteSidebarProps([activeThread, remoteActiveThread, unreadThread])}
          />,
        );

        const tab = screen.getByRole("tab", {
          name:
            "Attention, 1 active thread on this machine, "
            + "1 active thread on other instances, 1 thread to review",
        });
        expect(
          tab.querySelector("[data-attention-active-count]"),
        ).toHaveAttribute("data-attention-active-count", "1");
        expect(
          tab.querySelector("[data-attention-remote-active-count]"),
        ).toHaveAttribute("data-attention-remote-active-count", "1");
        // Live work, so it sweeps — both readouts mount a real scanner. The
        // remote one is neutral by token, not by being switched off.
        expect(tab.querySelectorAll(".thinking-scanner")).toHaveLength(2);
      });

      it("holds a zeroed peer readout for the linger window, then drops it", () => {
        vi.useFakeTimers();
        try {
          const view = render(
            <Sidebar {...remoteSidebarProps([activeThread, remoteActiveThread])} />,
          );

          const settled = [
            activeThread,
            { ...remoteActiveThread, threadStatus: "idle" as const },
          ];
          view.rerender(<Sidebar {...remoteSidebarProps(settled)} />);

          // A row that vanishes the instant the peer finishes takes the answer
          // away exactly when it becomes interesting.
          const lingering = screen.getByRole("tab", { name: /^Attention,/ });
          const remote = lingering.querySelector(
            "[data-attention-remote-active-count]",
          );
          expect(remote).toHaveAttribute(
            "data-attention-remote-active-count",
            "0",
          );
          expect(remote).toHaveAttribute("data-zero", "true");

          act(() => {
            vi.advanceTimersByTime(30_000);
          });

          expect(
            screen
              .getByRole("tab", { name: /^Attention,/ })
              .querySelector("[data-attention-remote-active-count]"),
          ).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      it("keeps the readout up when a peer starts again mid-linger", () => {
        vi.useFakeTimers();
        try {
          const idleRemote = {
            ...remoteActiveThread,
            threadStatus: "idle" as const,
          };
          const view = render(
            <Sidebar {...remoteSidebarProps([activeThread, remoteActiveThread])} />,
          );
          view.rerender(
            <Sidebar {...remoteSidebarProps([activeThread, idleRemote])} />,
          );
          act(() => {
            vi.advanceTimersByTime(20_000);
          });
          view.rerender(
            <Sidebar {...remoteSidebarProps([activeThread, remoteActiveThread])} />,
          );

          // The linger timer has to be cancelled, not merely outrun: firing it
          // would blank a readout showing live peer work.
          act(() => {
            vi.advanceTimersByTime(30_000);
          });

          expect(
            screen
              .getByRole("tab", { name: /^Attention,/ })
              .querySelector("[data-attention-remote-active-count]"),
          ).toHaveAttribute("data-attention-remote-active-count", "1");
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it("counts a live turn once, as active rather than to-review", () => {
      // A thread can be both running and unread. The tab must not report it
      // twice — same split the directory headers use.
      const activeAndUnread = {
        ...unreadThread,
        id: "thread-active-unread",
        threadStatus: "active" as const,
      };

      render(
        <Sidebar
          backends={backends}
          browseMode="attention"
          createThreadError={undefined}
          directories={directories}
          inboxThreads={[activeAndUnread]}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey={undefined}
          threads={[activeAndUnread]}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

      expect(
        screen.getByRole("tab", {
          name: "Attention, 1 active thread, 0 threads to review",
        }),
      ).toBeInTheDocument();
    });

    it("shows a settled empty state when the queue is clear", () => {
      render(
        <Sidebar
          backends={backends}
          browseMode="attention"
          createThreadError={undefined}
          directories={directories}
          inboxThreads={[idleThread]}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey={undefined}
          threads={[idleThread]}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

      expect(
        screen.getByText("Nothing running, nothing to review."),
      ).toBeInTheDocument();
    });

    it("explains the lens in a hover card, including the live counts", async () => {
      renderAttention();

      const tab = screen.getByRole("tab", { name: /^Attention,/ });
      fireEvent.mouseEnter(tab);
      const card = await screen.findByRole("tooltip");
      // A card rather than `.viewport-tooltip`: this tab reports counts, and
      // running text made the reader parse em-dashes to find them.
      expect(card).toHaveClass("attention-card");
      expect(card).toHaveTextContent(
        /AttentionThreads in progress or waiting to be reviewedIn progress1To review1/,
      );
      // Unfederated: no machine named, because there is nothing to tell apart.
      expect(card.textContent).not.toContain("Quitting");
      // The consequence lines exist nowhere else, so the card has to be
      // reachable to a screen reader rather than sighted-only.
      expect(tab).toHaveAttribute("aria-describedby", card.id);
    });

    it("pushes fresh counts into a card the pointer is still resting on", async () => {
      // Turns start and end while the pointer sits on the tab, and this card
      // is where "can I quit now?" gets answered. Frozen at hover-time values
      // it would disagree with the readout directly under it, and would keep
      // claiming there is no peer work after a peer starts a turn.
      const remoteActive = {
        ...activeThread,
        id: "thread-remote-live",
        federation: {
          instanceLabel: "studio",
          ref: {
            backend: "codex" as const,
            target: { scope: "remote" as const, instanceId: "peer-1" },
            threadId: "thread-remote-live",
          },
        },
      };
      const props = (threads: typeof allThreads) => ({
        backends,
        browseMode: "inbox" as const,
        createThreadError: undefined,
        directories,
        inboxThreads: threads,
        launchpadError: undefined,
        loading: false,
        creatingThread: undefined,
        selectedItemKey: undefined,
        threads,
        onBrowseModeChange: () => undefined,
        onCreateThread: async () => undefined,
        onOpenLaunchpad: async () => undefined,
        onSelectThread: () => undefined,
      });

      const view = render(<Sidebar {...props([activeThread, unreadThread])} />);
      fireEvent.mouseEnter(screen.getByRole("tab", { name: /^Attention,/ }));
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        /In progress1/,
      );

      // A peer starts a turn without the pointer ever leaving the tab.
      view.rerender(
        <Sidebar {...props([activeThread, remoteActive, unreadThread])} />,
      );

      const card = await screen.findByRole("tooltip");
      expect(card).toHaveTextContent(/In progress elsewhere/);
      expect(card).toHaveTextContent(/Quitting leaves these running/);
    });

    it("names the machines and what quitting does once a peer is running work", async () => {
      const remoteActive = {
        ...activeThread,
        id: "thread-remote-card",
        federation: {
          instanceLabel: "studio",
          ref: {
            backend: "codex" as const,
            target: { scope: "remote" as const, instanceId: "peer-1" },
            threadId: "thread-remote-card",
          },
        },
      };
      render(
        <Sidebar
          backends={backends}
          browseMode="inbox"
          createThreadError={undefined}
          directories={directories}
          inboxThreads={[activeThread, remoteActive, unreadThread]}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey={undefined}
          threads={[activeThread, remoteActive, unreadThread]}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

      fireEvent.mouseEnter(screen.getByRole("tab", { name: /^Attention,/ }));
      const card = await screen.findByRole("tooltip");
      expect(card).toHaveTextContent(/In progress here.*Quitting interrupts these/);
      expect(card).toHaveTextContent(
        /In progress elsewhere.*Quitting leaves these running/,
      );
    });
  });

  describe("Drafts lens", () => {
    const draftThread = {
      ...sharedThread,
      id: "thread-with-draft",
      title: "Thread with a draft",
      inbox: { inInbox: false },
    };
    const plainThread = {
      ...sharedThread,
      id: "thread-without-draft",
      title: "Thread without a draft",
      inbox: { inInbox: false },
    };
    const allThreads = [draftThread, plainThread];
    // Keyed exactly as `buildThreadIdentityKey` builds it — the same string
    // ThreadRow looks its chip up under.
    const draftThreadKeys = {
      [`${draftThread.source}:${draftThread.id}`]: true,
    };

    const renderDrafts = (
      browseMode: "drafts" | "inbox" = "drafts",
      onBrowseModeChange = vi.fn(),
    ) =>
      render(
        <Sidebar
          backends={backends}
          browseMode={browseMode}
          createThreadError={undefined}
          directories={directories}
          draftThreadKeys={draftThreadKeys}
          inboxThreads={allThreads}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey={undefined}
          threads={allThreads}
          onBrowseModeChange={onBrowseModeChange}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

    it("lists only threads holding unsent composer text", () => {
      renderDrafts();

      const browseSection = screen.getByRole("region", {
        name: "Thread browser",
      });
      const rows = within(browseSection as HTMLElement).getAllByRole("button", {
        name: /Thread with a draft|Thread without a draft/i,
      });
      expect(rows.map((row) => threadCard(row).textContent)).toEqual([
        expect.stringContaining("Thread with a draft"),
      ]);
    });

    it("marks the drafted row with a Draft chip in every lens", () => {
      renderDrafts("inbox");

      const browseSection = screen.getByRole("region", {
        name: "Thread browser",
      });
      // The chip is a sibling of the row's open button, so assert against
      // the whole row shell rather than the button.
      const rowFor = (title: string): HTMLElement => {
        const button = within(browseSection as HTMLElement).getByRole(
          "button",
          { name: new RegExp(title, "i") },
        );
        const shell = button.closest(".thread-row-shell");
        expect(shell).not.toBeNull();
        return shell as HTMLElement;
      };

      expect(
        rowFor("Thread with a draft").querySelector(
          '[data-thread-draft="unsent"]',
        ),
      ).toBeInTheDocument();
      expect(
        rowFor("Thread without a draft").querySelector(
          '[data-thread-draft="unsent"]',
        ),
      ).toBeNull();
    });

    it("switches to the lens from its tab", () => {
      const onBrowseModeChange = vi.fn();
      renderDrafts("inbox", onBrowseModeChange);

      const tab = screen.getByRole("tab", { name: /^Drafts,/ });
      expect(tab).toHaveAttribute("aria-selected", "false");
      fireEvent.click(tab);
      expect(onBrowseModeChange).toHaveBeenCalledWith("drafts");
    });

    it("explains the lens in its tooltip, including the count", async () => {
      renderDrafts();

      fireEvent.mouseEnter(screen.getByRole("tab", { name: /^Drafts,/ }));
      expect((await screen.findByRole("tooltip")).textContent).toBe(
        "Drafts — threads with a reply you started and never sent"
          + "\n1 thread with an unsent draft",
      );
    });

    it("counts the drafted threads on its tab", () => {
      const secondDraftThread = {
        ...sharedThread,
        id: "second-thread-with-draft",
        title: "Second thread with a draft",
        inbox: { inInbox: false },
      };

      render(
        <Sidebar
          backends={backends}
          browseMode="inbox"
          createThreadError={undefined}
          directories={directories}
          draftThreadKeys={{
            ...draftThreadKeys,
            [`${secondDraftThread.source}:${secondDraftThread.id}`]: true,
          }}
          inboxThreads={[...allThreads, secondDraftThread]}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey={undefined}
          threads={[...allThreads, secondDraftThread]}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

      const tab = screen.getByRole("tab", {
        name: "Drafts, 2 threads with unsent drafts",
      });
      expect(tab.querySelector(".lens-switch__count")).toHaveTextContent("2");
    });

    // The label must never contain "reply": `getByLabel` is a substring match
    // in Playwright, and 31 specs across 23 files drive the composer with
    // `getByLabel("Reply")` — a tab that matches makes every one of them a
    // strict-mode violation as soon as a thread has a draft. Desktop E2E is
    // the only suite that catches it (Testing Library matches names exactly),
    // so guard the wording here, where it costs nothing. See "E2E Locator
    // Hygiene Around Global Chrome" in apps/desktop/AGENTS.md.
    //
    // Asserted at ONE draft, not two: "replies" contains no "reply", so the
    // plural can never trip the substring match. The singular is the whole
    // hazard — "1 unsent reply" is the exact label that broke E2E — and a
    // guard sitting on the plural would have watched it ship.
    it('keeps "reply" out of the tab label at the singular count', () => {
      renderDrafts();

      // Matched loosely on purpose: pinning the exact string here would make a
      // reworded label fail on the lookup, and the reader would never see
      // which rule the new wording broke.
      const tab = screen.getByRole("tab", { name: /^Drafts,/ });
      expect(tab.getAttribute("aria-label")).not.toMatch(/reply/i);
    });

    it("drops the count entirely when nothing is half-written", () => {
      render(
        <Sidebar
          backends={backends}
          browseMode="inbox"
          createThreadError={undefined}
          directories={directories}
          inboxThreads={allThreads}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey={undefined}
          threads={allThreads}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

      // No badge at all — not a greyed "0". An absent count is how this lens
      // says "no drafts"; a zero would be one more number to read past.
      const tab = screen.getByRole("tab", {
        name: "Drafts, No threads with unsent drafts",
      });
      expect(tab.querySelector(".lens-switch__count")).toBeNull();
    });

    it("shows an empty state when nothing is half-written", () => {
      render(
        <Sidebar
          backends={backends}
          browseMode="drafts"
          createThreadError={undefined}
          directories={directories}
          inboxThreads={allThreads}
          launchpadError={undefined}
          loading={false}
          creatingThread={undefined}
          selectedItemKey={undefined}
          threads={allThreads}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
        />,
      );

      // "replies", not "drafts": launchpad composer text is equally unsent
      // but has no thread row, so the lens must not claim it covers it.
      expect(screen.getByText("No unsent replies.")).toBeInTheDocument();
    });
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
    expect(rows.map((row) => threadCard(row).textContent)).toEqual([
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

  it("supports Cmd, Shift, and Cmd+Shift thread selections for batch actions", () => {
    const copyText = vi.fn(async () => undefined);
    const onArchiveThread = vi.fn(async () => undefined);
    const onReorderThreadPins = vi.fn(async () => undefined);
    const onSelectThread = vi.fn();
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: { copyText },
    });

    const firstThread = {
      ...sharedThread,
      id: "thread-first",
      title: "First batch thread",
      linkedDirectories: [
        {
          ...sharedThread.linkedDirectories[0]!,
          path: "/tmp/project-first",
          worktreePath: "/tmp/worktree-first",
        },
      ],
    };
    const secondThread = {
      ...sharedThread,
      id: "thread-second",
      title: "Second batch thread",
      linkedDirectories: [
        {
          ...sharedThread.linkedDirectories[0]!,
          path: "/tmp/project-second",
          worktreePath: "/tmp/worktree-second",
        },
      ],
    };
    const thirdThread = {
      ...sharedThread,
      id: "thread-third",
      title: "Third batch thread",
      linkedDirectories: [],
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        directories={directories}
        inboxThreads={[firstThread, secondThread, thirdThread]}
        loading={false}
        threads={[firstThread, secondThread, thirdThread]}
        onArchiveThread={onArchiveThread}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onReorderThreadPins={onReorderThreadPins}
        onSelectThread={onSelectThread}
      />,
    );

    const firstButton = screen.getByRole("button", {
      name: "First batch thread",
    });
    const secondButton = screen.getByRole("button", {
      name: "Second batch thread",
    });
    const thirdButton = screen.getByRole("button", {
      name: "Third batch thread",
    });

    fireEvent.click(firstButton);
    fireEvent.click(thirdButton, { metaKey: true });
    expect(firstButton).toHaveAttribute("aria-pressed", "true");
    expect(secondButton).toHaveAttribute("aria-pressed", "false");
    expect(thirdButton).toHaveAttribute("aria-pressed", "true");

    // Shift replaces the set with the range from the Cmd-click anchor; adding
    // Cmd keeps that range alongside the existing selection.
    fireEvent.click(secondButton, { shiftKey: true });
    expect(firstButton).toHaveAttribute("aria-pressed", "false");
    expect(secondButton).toHaveAttribute("aria-pressed", "true");
    expect(thirdButton).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(firstButton, { metaKey: true, shiftKey: true });
    expect(firstButton).toHaveAttribute("aria-pressed", "true");
    expect(secondButton).toHaveAttribute("aria-pressed", "true");
    expect(thirdButton).toHaveAttribute("aria-pressed", "true");
    expect(onSelectThread).toHaveBeenCalledTimes(1);
    expect(onSelectThread).toHaveBeenCalledWith(firstThread);

    fireEvent.contextMenu(secondButton, { clientX: 48, clientY: 64 });
    const menu = screen.getByRole("menu", {
      name: "Actions for 3 threads selected",
    });
    expect(within(menu).getByRole("menuitem", { name: "Pin 3 Threads" })).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: "Archive 3 Threads" }),
    ).toBeInTheDocument();

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Copy Thread Paths" }),
    );
    expect(copyText).toHaveBeenCalledWith(
      ["/tmp/worktree-first", "/tmp/worktree-second"].join("\n"),
    );

    fireEvent.contextMenu(secondButton, { clientX: 48, clientY: 64 });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Archive 3 Threads" }),
    );
    expect(onArchiveThread).toHaveBeenCalledWith(firstThread);
    expect(onArchiveThread).toHaveBeenCalledWith(secondThread);
    expect(onArchiveThread).toHaveBeenCalledWith(thirdThread);
  });

  it("limits each batch action to its compatible thread subset", () => {
    const onSetThreadParent = vi.fn(async () => undefined);
    const onSetThreadPin = vi.fn(async () => undefined);
    const onReorderThreadPins = vi.fn(async () => undefined);
    const pinnedThread = {
      ...sharedThread,
      id: "thread-pinned",
      title: "Pinned batch thread",
      pinnedRank: "1024",
    };
    const parentThread = {
      ...sharedThread,
      id: "thread-parent",
      title: "Batch parent thread",
      subthreadsCollapsed: false,
    };
    const childThread = {
      ...sharedThread,
      id: "thread-child",
      title: "Child batch thread",
      parentThreadId: parentThread.id,
    };
    const unpinnedThread = {
      ...sharedThread,
      id: "thread-unpinned",
      title: "Unpinned batch thread",
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        directories={directories}
        inboxThreads={[pinnedThread, parentThread, childThread, unpinnedThread]}
        loading={false}
        threads={[pinnedThread, parentThread, childThread, unpinnedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onReorderThreadPins={onReorderThreadPins}
        onSelectThread={() => undefined}
        onSetThreadParent={onSetThreadParent}
        onSetThreadPin={onSetThreadPin}
      />,
    );

    const pinnedButton = screen.getByRole("button", {
      name: /^Pinned batch thread/,
    });
    const childButton = screen.getByRole("button", {
      name: "Child batch thread",
    });
    const unpinnedButton = screen.getByRole("button", {
      name: "Unpinned batch thread",
    });
    fireEvent.click(childButton);
    fireEvent.click(pinnedButton, { metaKey: true });
    fireEvent.click(unpinnedButton, { metaKey: true });

    fireEvent.contextMenu(pinnedButton, { clientX: 48, clientY: 64 });
    expect(
      screen.getByRole("menuitem", { name: "Unpin 1 Thread" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Pin 1 Thread" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Unlink 1 Thread from Parent" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Unlink 1 Thread from Parent" }),
    );
    expect(onSetThreadParent).toHaveBeenCalledWith(childThread, undefined);

    fireEvent.contextMenu(pinnedButton, { clientX: 48, clientY: 64 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin 1 Thread" }));
    expect(onSetThreadPin).toHaveBeenCalledWith(pinnedThread, false);
  });

  it("uses the expanded directory order for Shift ranges", () => {
    const secondThread = {
      ...sharedThread,
      id: "thread-directory-second",
      title: "Directory second thread",
    };
    const directory = {
      ...directories[0]!,
      threadKeys: ["codex:thread-1", "codex:thread-directory-second"],
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        directories={[directory]}
        inboxThreads={[sharedThread, secondThread]}
        loading={false}
        threads={[sharedThread, secondThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    const directorySummary = screen
      .getAllByRole("button", { name: /PwrAgent/i })
      .find((button) => button.getAttribute("aria-expanded") === "false");
    expect(directorySummary).toBeDefined();
    fireEvent.click(directorySummary!);

    const firstButton = screen.getByRole("button", {
      name: "Cross-project cleanup",
    });
    const secondButton = screen.getByRole("button", {
      name: "Directory second thread",
    });
    fireEvent.click(firstButton);
    fireEvent.click(secondButton, { shiftKey: true });

    expect(firstButton).toHaveAttribute("aria-pressed", "true");
    expect(secondButton).toHaveAttribute("aria-pressed", "true");
  });

  it("marks unread threads read across a Shift-selected range of collapsed directories", () => {
    const onMarkThreadsSeen = vi.fn(async () => undefined);
    const onSetDirectoryPin = vi.fn(async () => undefined);
    const firstThread = {
      ...sharedThread,
      id: "thread-directory-first",
      title: "Directory first unread thread",
    };
    const sharedUnreadThread = {
      ...sharedThread,
      id: "thread-directory-shared",
      title: "Shared unread thread",
    };
    const lastThread = {
      ...sharedThread,
      id: "thread-directory-last",
      title: "Directory last unread thread",
    };
    const alreadyReadThread = {
      ...sharedThread,
      id: "thread-directory-read",
      title: "Already read thread",
      inbox: {
        inInbox: false,
      },
    };
    const firstDirectory: NavigationDirectorySummary = {
      key: "directory:/tmp/directory-first",
      kind: "directory",
      label: "Directory first",
      path: "/tmp/directory-first",
      threadKeys: [
        `codex:${firstThread.id}`,
        `codex:${sharedUnreadThread.id}`,
      ],
      needsAttentionCount: 2,
      latestUpdatedAt: firstThread.updatedAt,
    };
    const middleDirectory: NavigationDirectorySummary = {
      key: "directory:/tmp/directory-middle",
      kind: "directory",
      label: "Directory middle",
      path: "/tmp/directory-middle",
      threadKeys: [
        `codex:${sharedUnreadThread.id}`,
        `codex:${lastThread.id}`,
      ],
      needsAttentionCount: 2,
      latestUpdatedAt: sharedUnreadThread.updatedAt,
    };
    const lastDirectory: NavigationDirectorySummary = {
      key: "directory:/tmp/directory-last",
      kind: "directory",
      label: "Directory last",
      path: "/tmp/directory-last",
      threadKeys: [`codex:${alreadyReadThread.id}`],
      needsAttentionCount: 0,
      latestUpdatedAt: alreadyReadThread.updatedAt,
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        directories={[firstDirectory, middleDirectory, lastDirectory]}
        inboxThreads={[
          firstThread,
          sharedUnreadThread,
          lastThread,
          alreadyReadThread,
        ]}
        loading={false}
        threads={[
          firstThread,
          sharedUnreadThread,
          lastThread,
          alreadyReadThread,
        ]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onMarkThreadsSeen={onMarkThreadsSeen}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onSetDirectoryPin={onSetDirectoryPin}
      />,
    );

    const getDirectorySummary = (name: string): HTMLElement => {
      const summary = screen
        .getAllByRole("button", { name })
        .find((button) => button.hasAttribute("aria-expanded"));
      if (!summary) {
        throw new Error(`Could not find ${name} directory summary`);
      }
      return summary;
    };
    const firstSummary = getDirectorySummary(
      "Directory first, 2 threads to review",
    );
    const middleSummary = getDirectorySummary(
      "Directory middle, 2 threads to review",
    );
    const lastSummary = getDirectorySummary("Directory last");

    // Modified clicks leave the collapsed directory list stable while building
    // a range. The shared thread appears in two selected directories but must
    // be passed to the bulk action only once.
    fireEvent.click(firstSummary, { metaKey: true });
    fireEvent.click(lastSummary, { shiftKey: true });

    expect(firstSummary).toHaveAttribute("aria-expanded", "false");
    expect(middleSummary).toHaveAttribute("aria-expanded", "false");
    expect(lastSummary).toHaveAttribute("aria-expanded", "false");
    expect(firstSummary).toHaveAttribute("aria-pressed", "true");
    expect(middleSummary).toHaveAttribute("aria-pressed", "true");
    expect(lastSummary).toHaveAttribute("aria-pressed", "true");

    fireEvent.contextMenu(middleSummary, { clientX: 48, clientY: 64 });
    const menu = screen.getByRole("menu", {
      name: "Actions for 3 directories selected",
    });
    expect(
      within(menu).queryByRole("menuitem", { name: "Pin Directory" }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Mark Read" }));

    expect(onMarkThreadsSeen).toHaveBeenCalledWith([
      firstThread,
      sharedUnreadThread,
      lastThread,
    ]);
    expect(onSetDirectoryPin).not.toHaveBeenCalled();
  });

  it("separates pinning, creation, management, and copy thread actions", () => {
    const forkBackends = backends.map((backend) =>
      backend.kind === "codex"
        ? {
            ...backend,
            capabilities: {
              ...backend.capabilities,
              forkThread: true,
            },
          }
        : backend,
    );
    const pinnedThread = {
      ...sharedThread,
      pinnedRank: "1024",
    };

    render(
      <Sidebar
        backends={forkBackends}
        // Move Up / Move Down only surface where a pinned section is
        // rendered, which is the Directories lens.
        browseMode="directories"
        directories={directories}
        inboxThreads={[pinnedThread]}
        loading={false}
        selectedItemKey="codex:thread-1"
        threads={[pinnedThread]}
        onArchiveThread={async () => undefined}
        onBrowseModeChange={() => undefined}
        onCreateSubthread={async () => undefined}
        onCreateThread={async () => undefined}
        onForkThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onReorderThreadPins={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadPin={async () => undefined}
      />,
    );

    fireEvent.contextMenu(
      screen.getByRole("button", { name: /^Cross-project cleanup/ }),
      { clientX: 48, clientY: 64 },
    );

    const menu = screen.getByRole("menu");
    const sections = [...menu.children].filter((child) =>
      child.classList.contains("thread-context-menu__section"),
    );
    expect(sections).toHaveLength(4);
    expect(sections[0]).toHaveTextContent("Unpin Thread");
    expect(sections[1]).toHaveTextContent("Sub-thread in Same Worktree");
    expect(sections[1]).toHaveTextContent("Fork into New Worktree");
    expect(sections[2]).toHaveTextContent("Move Up");
    expect(sections[2]).toHaveTextContent("Archive Thread");
    expect(sections[3]).toHaveTextContent("Copy Thread Link");
    expect(
      menu.querySelectorAll(".thread-context-menu__separator"),
    ).toHaveLength(3);
  });

  it("splits parent archive actions between ungrouping children and archiving the group", () => {
    const onArchiveThread = vi.fn(async () => undefined);
    const childThread = {
      ...sharedThread,
      id: "thread-child",
      title: "Child thread",
      parentThreadId: sharedThread.id,
      updatedAt: sharedThread.updatedAt + 1,
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[sharedThread, childThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread, childThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onArchiveThread={onArchiveThread}
      />
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Open thread actions" })[0]!
    );

    expect(
      screen.getByRole("menuitem", {
        name: "Archive Thread Only. Ungroup 1 sub-thread",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", {
        name: "Archive Thread and Sub-Threads. Archive 2 threads",
      }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Archive Thread Only. Ungroup 1 sub-thread",
      }),
    );

    expect(onArchiveThread).toHaveBeenCalledWith(sharedThread, {
      includeSubthreads: false,
    });
  });

  it("archives the whole group from the parent row menu", () => {
    const onArchiveThread = vi.fn(async () => undefined);
    const childThread = {
      ...sharedThread,
      id: "thread-child",
      title: "Child thread",
      parentThreadId: sharedThread.id,
      updatedAt: sharedThread.updatedAt + 1,
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[sharedThread, childThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[sharedThread, childThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onArchiveThread={onArchiveThread}
      />
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Open thread actions" })[0]!
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Archive Thread and Sub-Threads. Archive 2 threads",
      }),
    );

    expect(onArchiveThread).toHaveBeenCalledWith(sharedThread, {
      includeSubthreads: true,
    });
  });

  it("pins from the row menu and leaves pinned threads in sort order", () => {
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
    // Created is a pure sort order: the pinned thread keeps the position the
    // caller's ordering gave it instead of floating to a pinned section.
    expect(rows.map((row) => threadCard(row).textContent)).toEqual([
      expect.stringContaining("Cross-project cleanup"),
      expect.stringContaining("Updated thread"),
    ]);
    expect(
      within(
        rows[1]!.closest(".thread-row-shell") as HTMLElement,
      ).getByRole("button", { name: "Unpin thread" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("separator", { name: "Unpinned threads" }),
    ).not.toBeInTheDocument();

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
        browseMode="directories"
        createThreadError={undefined}
        directories={[
          {
            ...directories[0]!,
            threadKeys: ["codex:thread-top", "codex:thread-bottom"],
          },
        ]}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-top"
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
    expect(onReorderThreadPins).toHaveBeenCalledWith([
      `codex:${pinnedBottom.id}`,
      `codex:${pinnedTop.id}`,
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
      .getByRole("button", {
        name: "Hide directory threads for PwrAgent",
      })
      .closest(".directory-row__threads") as HTMLElement;
    expect(
      screen.queryByRole("separator", {
        name: "Pinned threads for PwrAgent",
      }),
    ).not.toBeInTheDocument();

    const rows = within(directoryThreads).getAllByRole("button", {
      name: /Cross-project cleanup|Updated thread/i,
    });
    expect(threadCard(rows[0]!)).toHaveTextContent("Updated thread");
    // Pinned state rides the title line as `.thread-row__heading-pin`
    // since the 2026-08 density pass (the old role="img" pin chip left
    // the chip flow). This render omits `onSetThreadPin`, so it gets the
    // handler-less aria-hidden static variant; with a handler wired (as
    // the live app always does) the same slot is a real "Unpin thread"
    // button — see the transcript-gaps pin tests in
    // thread-row-chips.test.tsx for that form.
    expect(
      threadCard(rows[0]!).querySelector(".thread-row__heading-pin"),
    ).not.toBeNull();
    expect(threadCard(rows[1]!)).toHaveTextContent("Cross-project cleanup");
    expect(
      threadCard(rows[1]!).querySelector(".thread-row__heading-pin"),
    ).toBeNull();
  });

  it("minimizes only unpinned directory threads and restores the sticky state", async () => {
    const onSetDirectoryThreadsCollapsed = vi.fn(async () => undefined);
    const pinnedThread = {
      ...updatedSinceSeenThread,
      pinnedRank: "1024",
    };
    const directoryWithPinnedThread = {
      ...directories[0],
      threadKeys: ["codex:thread-1", "codex:thread-updated"],
    };
    const renderSidebar = (directoryThreadsCollapsed: boolean) => (
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[
          {
            ...directoryWithPinnedThread,
            directoryThreadsCollapsed,
          },
        ]}
        inboxThreads={[sharedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-updated"
        threads={[sharedThread, pinnedThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onSetDirectoryThreadsCollapsed={onSetDirectoryThreadsCollapsed}
      />
    );

    const { rerender } = render(renderSidebar(false));

    const hideDirectoryThreads = screen.getByRole("button", {
      name: "Hide directory threads for PwrAgent",
    });
    const expandedDividerLabel = hideDirectoryThreads.querySelector(
      ".directory-row__thread-divider-label",
    );
    expect(expandedDividerLabel?.firstElementChild).toHaveClass(
      "directory-row__thread-divider-chevron",
      "is-open",
    );
    expect(expandedDividerLabel?.children[1]).toHaveTextContent(
      "Directory threads",
    );

    await clickElement(hideDirectoryThreads);
    expect(onSetDirectoryThreadsCollapsed).toHaveBeenCalledWith(
      expect.objectContaining({ key: directories[0].key }),
      true,
    );

    rerender(renderSidebar(true));

    expect(screen.getByText("Updated thread")).toBeInTheDocument();
    expect(screen.queryByText("Cross-project cleanup")).not.toBeInTheDocument();
    const showDirectoryThreads = screen.getByRole("button", {
      name: "Show directory threads for PwrAgent",
    });
    expect(showDirectoryThreads).toHaveAttribute("aria-expanded", "false");
    expect(within(showDirectoryThreads).getByText("1")).toBeInTheDocument();
    const collapsedDividerLabel = showDirectoryThreads.querySelector(
      ".directory-row__thread-divider-label",
    );
    expect(collapsedDividerLabel?.firstElementChild).toHaveClass(
      "directory-row__thread-divider-chevron",
    );
    expect(collapsedDividerLabel?.firstElementChild).not.toHaveClass("is-open");
    expect(collapsedDividerLabel?.children[1]).toHaveTextContent(
      "Directory threads",
    );
  });

  it("caps unpinned directory threads and toggles the overflow behind Show more / Show less", async () => {
    const cappedThreads = Array.from({ length: 12 }, (_, index) => ({
      ...sharedThread,
      id: `thread-cap-${index + 1}`,
      title: `Capped thread ${index + 1}`,
    }));
    const directoryWithManyThreads = {
      ...directories[0],
      threadKeys: cappedThreads.map((thread) => `codex:${thread.id}`),
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[directoryWithManyThreads]}
        inboxThreads={cappedThreads}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-cap-1"
        threads={cappedThreads}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    // 12 unpinned threads → only the first 10 render until expanded.
    expect(
      screen.getAllByRole("button", { name: /Capped thread \d+/ }),
    ).toHaveLength(10);
    expect(screen.queryByText("Capped thread 11")).not.toBeInTheDocument();

    await clickElement(screen.getByRole("button", { name: "Show 2 more" }));

    expect(
      screen.getAllByRole("button", { name: /Capped thread \d+/ }),
    ).toHaveLength(12);
    expect(screen.getByText("Capped thread 12")).toBeInTheDocument();

    // The collapse control stays at the pivot — right where "Show more"
    // was — so it sits BEFORE the freshly revealed overflow rows and the
    // user never scrolls to the bottom of the directory to collapse it.
    const showLess = screen.getByRole("button", { name: "Show less" });
    const overflowRow = screen.getByRole("button", {
      name: /Capped thread 12/,
    });
    expect(
      showLess.compareDocumentPosition(overflowRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await clickElement(screen.getByRole("button", { name: "Show less" }));

    expect(
      screen.getAllByRole("button", { name: /Capped thread \d+/ }),
    ).toHaveLength(10);
  });

  it("auto-expands a directory's overflow when the selected thread is hidden in it", () => {
    const cappedThreads = Array.from({ length: 12 }, (_, index) => ({
      ...sharedThread,
      id: `thread-cap-${index + 1}`,
      title: `Capped thread ${index + 1}`,
    }));
    const directoryWithManyThreads = {
      ...directories[0],
      threadKeys: cappedThreads.map((thread) => `codex:${thread.id}`),
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[directoryWithManyThreads]}
        inboxThreads={cappedThreads}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        // thread-cap-12 sits in the overflow (beyond the cap of 10).
        selectedItemKey="codex:thread-cap-12"
        threads={cappedThreads}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    // The selected overflow thread renders without any click, and the
    // toggle reflects the auto-expanded state.
    expect(
      screen.getAllByRole("button", { name: /Capped thread \d+/ }),
    ).toHaveLength(12);
    expect(screen.getByText("Capped thread 12")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show less" }),
    ).toBeInTheDocument();
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
      screen.queryByRole("button", {
        name: "Hide directory threads for PwrAgent",
      }),
    ).not.toBeInTheDocument();
  });

  it("pins a same-directory thread after a pointer drag leaves its source", async () => {
    const onReorderThreadPins = vi.fn(async () => undefined);
    const onSetDirectoryThreadsCollapsed = vi.fn(async () => undefined);
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
        onSetDirectoryThreadsCollapsed={onSetDirectoryThreadsCollapsed}
      />
    );

    const directoryThreads = screen.getByRole("button", {
      name: "Hide directory threads for PwrAgent",
    });
    const unpinnedRow = screen
      .getByRole("button", { name: /Cross-project cleanup/i })
      .closest(".thread-row-shell");
    startThreadPinPointerDrag(unpinnedRow!, { x: 50, y: 150 });
    const pinnedRow = screen
      .getByRole("button", { name: /Updated thread/i })
      .closest(".thread-row-shell");
    moveThreadPinPointer({ x: 50, y: 90 });
    expect(pinnedRow).not.toHaveClass("is-drop-target-before");
    expect(pinnedRow).not.toHaveClass("is-drop-target-after");
    const appendTarget = screen.getByRole("separator", {
      name: "Pin thread after pinned threads for PwrAgent",
    });
    await waitFor(() => {
      expect(appendTarget).toHaveClass("is-drop-target-before");
    });
    releaseThreadPinPointer({ x: 50, y: 90 });
    fireEvent.click(directoryThreads);

    expect(onReorderThreadPins).toHaveBeenCalledWith([
      "codex:thread-updated",
      "codex:thread-1",
    ]);
    expect(onSetDirectoryThreadsCollapsed).not.toHaveBeenCalled();
  });

  it("keeps wheel input on the normal renderer path during a pointer drag", async () => {
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
        onReorderThreadPins={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    const row = screen
      .getByRole("button", { name: /Cross-project cleanup/i })
      .closest(".thread-row-shell") as HTMLElement;
    expect(row).not.toHaveAttribute("draggable", "true");
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 100,
      left: 0,
      right: 300,
      toJSON: () => ({}),
      top: 100,
      width: 300,
      x: 0,
      y: 100,
    });
    const list = row.closest(".directory-list") as HTMLElement;
    const onWheel = vi.fn();
    list.addEventListener("wheel", onWheel);

    startThreadPinPointerDrag(row, { x: 50, y: 150 });
    moveThreadPinPointer({ x: 50, y: 90 });
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute(
        "data-native-drag-active",
      );
      expect(document.body.querySelector(".thread-row--drag-image"))
        .not.toBeNull();
    });

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    list.dispatchEvent(wheelEvent);
    expect(onWheel).toHaveBeenCalledTimes(1);
    expect(wheelEvent.defaultPrevented).toBe(false);

    releaseThreadPinPointer({ x: 50, y: 90 });
    expect(document.documentElement).not.toHaveAttribute(
      "data-native-drag-active",
    );
  });

  it("cancels over the source and appends after leaving an empty pin section", async () => {
    const onReorderThreadPins = vi.fn(async () => undefined);

    const { container } = render(
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
        onReorderThreadPins={onReorderThreadPins}
        onSelectThread={() => undefined}
      />,
    );

    expect(
      screen.queryByRole("separator", {
        name: "Pin thread after pinned threads for PwrAgent",
      }),
    ).not.toBeInTheDocument();
    const mountedAppendTarget = container.querySelector(
      ".directory-row__pin-drop-slot",
    );
    expect(mountedAppendTarget).toHaveAttribute("aria-hidden", "true");

    const row = screen
      .getByRole("button", { name: /Cross-project cleanup/i })
      .closest(".thread-row-shell");
    vi.spyOn(row!, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 100,
      left: 0,
      right: 300,
      toJSON: () => ({}),
      top: 100,
      width: 300,
      x: 0,
      y: 100,
    });
    startThreadPinPointerDrag(row!, { x: 50, y: 150 });
    moveThreadPinPointer({ x: 60, y: 160 });

    let appendTarget = screen.getByRole("separator", {
      name: "Pin thread after pinned threads for PwrAgent",
    });
    expect(appendTarget).toBe(mountedAppendTarget);
    expect(appendTarget).toHaveClass("is-drag-enabled");
    await waitFor(() => {
      expect(appendTarget).not.toHaveClass("is-drop-target-before");
    });
    releaseThreadPinPointer({ x: 50, y: 150 });
    expect(onReorderThreadPins).not.toHaveBeenCalled();

    startThreadPinPointerDrag(row!, { x: 50, y: 150 });
    moveThreadPinPointer({ x: 50, y: 90 });
    appendTarget = screen.getByRole("separator", {
      name: "Pin thread after pinned threads for PwrAgent",
    });
    await waitFor(() => {
      expect(appendTarget).toHaveClass("is-drop-target-before");
    });

    releaseThreadPinPointer({ x: 50, y: 90 });
    expect(onReorderThreadPins).toHaveBeenCalledWith(["codex:thread-1"]);
  });

  it("uses the source row's live bounds after directory-list scrolling", async () => {
    const onReorderThreadPins = vi.fn(async () => undefined);

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
        onReorderThreadPins={onReorderThreadPins}
        onSelectThread={() => undefined}
      />,
    );

    const row = screen
      .getByRole("button", { name: /Cross-project cleanup/i })
      .closest(".thread-row-shell");
    const sourceBounds = vi.spyOn(row!, "getBoundingClientRect");
    sourceBounds.mockReturnValue({
      bottom: 200,
      height: 100,
      left: 0,
      right: 300,
      toJSON: () => ({}),
      top: 100,
      width: 300,
      x: 0,
      y: 100,
    });
    startThreadPinPointerDrag(row!, { x: 50, y: 150 });
    moveThreadPinPointer({ x: 50, y: 90 });
    const appendTarget = screen.getByRole("separator", {
      name: "Pin thread after pinned threads for PwrAgent",
    });
    await waitFor(() => {
      expect(appendTarget).toHaveClass("is-drop-target-before");
    });

    sourceBounds.mockReturnValue({
      bottom: 120,
      height: 100,
      left: 0,
      right: 300,
      toJSON: () => ({}),
      top: 20,
      width: 300,
      x: 0,
      y: 20,
    });
    fireEvent.scroll(row!.closest(".directory-list")!);
    await waitFor(() => {
      expect(appendTarget).not.toHaveClass("is-drop-target-before");
    });

    moveThreadPinPointer({ x: 50, y: 150 });
    await waitFor(() => {
      expect(appendTarget).toHaveClass("is-drop-target-before");
    });
    releaseThreadPinPointer({ x: 50, y: 150 });
    expect(onReorderThreadPins).toHaveBeenCalledWith(["codex:thread-1"]);
  });

  it("keeps an escaped directory pin drag canceled through release", async () => {
    const onReorderThreadPins = vi.fn(async () => undefined);

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
        onReorderThreadPins={onReorderThreadPins}
        onSelectThread={() => undefined}
      />,
    );

    const row = screen
      .getByRole("button", { name: /Cross-project cleanup/i })
      .closest(".thread-row-shell");
    vi.spyOn(row!, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 100,
      left: 0,
      right: 300,
      toJSON: () => ({}),
      top: 100,
      width: 300,
      x: 0,
      y: 100,
    });
    startThreadPinPointerDrag(row!, { x: 50, y: 150 });
    moveThreadPinPointer({ x: 50, y: 90 });
    const appendTarget = screen.getByRole("separator", {
      name: "Pin thread after pinned threads for PwrAgent",
    });
    await waitFor(() => {
      expect(appendTarget).toHaveClass("is-drop-target-before");
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("separator", {
        name: "Pin thread after pinned threads for PwrAgent",
      }),
    ).not.toBeInTheDocument();
    releaseThreadPinPointer({ x: 50, y: 90 });
    expect(onReorderThreadPins).not.toHaveBeenCalled();
  });

  it("shows directory drop targets for pinned row edges and the append slot", async () => {
    // Pin reorder-by-drag lives only where a pinned section is rendered, which
    // after the Updated/Created lenses became pure sort orders means the
    // Directories lens alone.
    const firstPinnedThread = {
      ...sharedThread,
      pinnedRank: "1024",
    };
    const secondPinnedThread = {
      ...updatedSinceSeenThread,
      pinnedRank: "2048",
    };
    const unpinnedThread = {
      ...sharedThread,
      id: "thread-unpinned",
      title: "Unpinned thread",
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[
          {
            ...directories[0]!,
            threadKeys: [
              "codex:thread-1",
              "codex:thread-updated",
              "codex:thread-unpinned",
            ],
          },
        ]}
        inboxThreads={[firstPinnedThread, secondPinnedThread, unpinnedThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[firstPinnedThread, secondPinnedThread, unpinnedThread]}
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
    startThreadPinPointerDrag(draggedRow!, { x: 50, y: 150 });

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

    moveThreadPinPointer({ x: 50, y: 25 });
    await waitFor(() => {
      expect(pinnedRow).toHaveClass("is-drop-target-before");
    });

    moveThreadPinPointer({ x: 50, y: 75 });
    await waitFor(() => {
      expect(pinnedRow).not.toHaveClass("is-drop-target-before");
      expect(pinnedRow).toHaveClass("is-drop-target-after");
    });

    const appendTarget = screen.getByRole("separator", {
      name: "Pin thread after pinned threads for PwrAgent",
    });
    vi.spyOn(appendTarget, "getBoundingClientRect").mockReturnValue({
      bottom: 132,
      height: 32,
      left: 0,
      right: 300,
      toJSON: () => ({}),
      top: 100,
      width: 300,
      x: 0,
      y: 100,
    });
    moveThreadPinPointer({ x: 50, y: 115 });
    await waitFor(() => {
      expect(pinnedRow).not.toHaveClass("is-drop-target-before");
      expect(pinnedRow).not.toHaveClass("is-drop-target-after");
      expect(appendTarget).toHaveClass("is-drop-target-before");
    });
    releaseThreadPinPointer({ x: 50, y: 115 });
  });

  it("renders no pinned section or drag affordance in the Created lens", () => {
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

    expect(
      screen.queryByRole("separator", { name: /Unpinned threads/ }),
    ).not.toBeInTheDocument();
    for (const title of [/Cross-project cleanup/i, /Updated thread/i]) {
      const shell = screen
        .getByRole("button", { name: title })
        .closest(".thread-row-shell");
      expect(shell).not.toHaveAttribute("draggable", "true");
    }
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
        onSetDirectoryThreadsCollapsed={async () => undefined}
      />
    );

    const projectBSummary = screen
      .getAllByRole("button", { name: /ProjectB/i })
      .find((button) => button.getAttribute("aria-expanded") === "false");
    expect(projectBSummary).toBeDefined();

    fireEvent.click(projectBSummary!);
    fireEvent.drop(
      screen.getByRole("button", {
        name: "Hide directory threads for ProjectB",
      }),
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
      "Copy Thread Link",
      "Copy Thread ID",
      "Copy Worktree Path",
      "Copy Branch Name",
    ]);
  });

  it("marks a read thread unread from the thread context menu", async () => {
    const readThread: NavigationThreadSummary = {
      ...sharedThread,
      inbox: {
        inInbox: false,
        lastSeenUpdatedAt: sharedThread.updatedAt,
      },
    };
    const onMarkThreadUnread = vi.fn(async () => undefined);

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[readThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[readThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onMarkThreadUnread={onMarkThreadUnread}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open thread actions" }));
    await clickElement(screen.getByRole("menuitem", { name: "Mark Unread" }));

    expect(onMarkThreadUnread).toHaveBeenCalledWith(readThread);
    expect(screen.queryByRole("menuitem", { name: "Mark Unread" }))
      .not.toBeInTheDocument();
  });

  it("marks an unread Attention thread read from the thread context menu", async () => {
    const onMarkThreadsSeen = vi.fn(async () => undefined);

    render(
      <Sidebar
        backends={backends}
        browseMode="attention"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[updatedSinceSeenThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-updated"
        threads={[updatedSinceSeenThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onMarkThreadsSeen={onMarkThreadsSeen}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open thread actions" }));
    await clickElement(screen.getByRole("menuitem", { name: "Mark Read" }));

    expect(onMarkThreadsSeen).toHaveBeenCalledWith([updatedSinceSeenThread]);
    expect(screen.queryByRole("menuitem", { name: "Mark Read" }))
      .not.toBeInTheDocument();
  });

  it("omits Mark Unread for an already-unread thread", () => {
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
        selectedItemKey="codex:thread-updated"
        threads={[updatedSinceSeenThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onMarkThreadUnread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open thread actions" }));

    expect(screen.queryByRole("menuitem", { name: "Mark Unread" }))
      .not.toBeInTheDocument();
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

    const threadRowCard = threadCard(screen.getByText("Cross-project cleanup"));
    fireEvent.contextMenu(threadRowCard, { clientX: 12, clientY: 34 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Thread" }));

    const dialog = screen.getByRole("dialog", { name: "Rename Thread" });
    const input = within(dialog).getByLabelText("Name");
    fireEvent.change(input, { target: { value: "  Renamed cleanup  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename Thread" }));

    expect(onRenameThread).toHaveBeenCalledWith(sharedThread, "Renamed cleanup");
  });

  it("offers rename for ACP threads when the backend supports local renaming", () => {
    const onRenameThread = vi.fn(async () => undefined);
    const acpThread = {
      ...sharedThread,
      id: "session-1",
      source: "acp:gemini" as const,
      title: "ACP session",
      linkedDirectories: [],
    };
    const acpBackend: BackendSummary = {
      ...backends[0]!,
      kind: "acp:gemini",
      source: "acp",
      label: "Gemini CLI",
      executionModes: [],
      capabilities: {
        ...backends[0]!.capabilities,
        renameThread: true,
      },
    };

    render(
      <Sidebar
        backends={[...backends, acpBackend]}
        browseMode="recents"
        createThreadError={undefined}
        directories={[]}
        inboxThreads={[acpThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="acp:gemini:session-1"
        threads={[acpThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onArchiveThread={async () => undefined}
        onRenameThread={onRenameThread}
      />
    );

    const threadRowCard = threadCard(screen.getByText("ACP session"));
    fireEvent.contextMenu(threadRowCard, { clientX: 12, clientY: 34 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Thread" }));

    const dialog = screen.getByRole("dialog", { name: "Rename Thread" });
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Gemini cleanup" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename Thread" }));

    expect(onRenameThread).toHaveBeenCalledWith(acpThread, "Gemini cleanup");
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

    const threadRowCard = threadCard(screen.getByText("Cross-project cleanup"));
    fireEvent.contextMenu(threadRowCard, { clientX: 12, clientY: 34 });
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

    const threadRowCard = threadCard(screen.getByText("Cross-project cleanup"));
    fireEvent.contextMenu(threadRowCard, { clientX: 12, clientY: 34 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive Thread" }));

    expect(screen.queryByRole("dialog", { name: "Archive Thread" })).not.toBeInTheDocument();
    expect(onArchiveThread).toHaveBeenCalledWith(sharedThread);
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
    fireEvent.focus(branchChip);
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
    fireEvent.blur(branchChip);
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

  it("shows base branch and behind-base metadata in the branch tooltip", async () => {
    const threadWithBase = {
      ...sharedThread,
      gitWorkingState: {
        dirtyFiles: 0,
        dirtyAdditions: 0,
        dirtyDeletions: 0,
        untrackedFiles: 0,
        unpushedCommits: 0,
        baseBranch: "releases/4.3",
        baseCommit: "1111111111111111111111111111111111111111",
        baseTipCommit: "2222222222222222222222222222222222222222",
        baseBehindCommitCount: 2,
        baseAheadCommitCount: 5,
        isBehindBase: true,
      },
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="recents"
        createThreadError={undefined}
        directories={directories}
        inboxThreads={[threadWithBase]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[threadWithBase]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />
    );

    const branchChip = screen.getByRole("button", {
      name: "Copy branch codex/thread-centric-ui",
    });
    fireEvent.focus(branchChip);

    await waitFor(() => {
      expect(screen.getByRole("tooltip").textContent).toBe(
        [
          "codex/thread-centric-ui",
          "Base: releases/4.3",
          "Base commit: 111111111111",
          "Base tip: 222222222222",
          "Behind base: 2 commits",
          "Ahead of base: 5 commits",
          "Click to copy to clipboard",
        ].join("\n"),
      );
    });
  });

  it("copies a pull request URL from the PR chip context menu", async () => {
    const copyText = vi.fn(async () => undefined);
    const onSelectThread = vi.fn();
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
        inboxThreads={[pullRequestThread]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-1"
        threads={[pullRequestThread]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={onSelectThread}
      />
    );

    const prChip = screen.getByRole("button", {
      name: "Open ExampleOrg/ExampleApp#202 (ready for review · checks passing) in browser",
    });
    fireEvent.contextMenu(prChip, { clientX: 48, clientY: 64 });
    await clickElement(
      screen.getByRole("menuitem", { name: "Copy Pull Request URL" }),
    );

    expect(copyText).toHaveBeenCalledWith(
      "https://github.com/ExampleOrg/ExampleApp/pull/202",
    );
    expect(onSelectThread).not.toHaveBeenCalled();
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
      onRemoveDirectory?: (directory: NavigationDirectorySummary) => void;
      onOpenLaunchpad?: (
        directory: NavigationDirectorySummary,
      ) => Promise<void>;
      onCreateThreadOnFederationTarget?: (
        instanceId: string,
      ) => Promise<void>;
      newThreadFederationTargets?: readonly FederationThreadTarget[];
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
        newThreadFederationTargets={overrides.newThreadFederationTargets}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onCreateThreadOnFederationTarget={
          overrides.onCreateThreadOnFederationTarget
        }
        onOpenLaunchpad={overrides.onOpenLaunchpad ?? (async () => undefined)}
        onSelectThread={() => undefined}
        onSetDirectoryPin={overrides.onSetDirectoryPin}
        onReorderDirectoryPins={overrides.onReorderDirectoryPins}
        onRemoveDirectory={overrides.onRemoveDirectory}
      />,
    );
  }

  /**
   * A sub-thread launchpad as the renderer's launchpad merge synthesizes it:
   * a `kind: "directory"` summary keyed `subthread:...` with no threads. It must
   * never surface in the Directories lens.
   */
  const subthreadLaunchpadDirectory: NavigationDirectorySummary = {
    key: "subthread:codex:thread-parent:same-worktree",
    kind: "directory",
    label: "media-service",
    path: "/Users/huntharo/pwrdrvr/media-service",
    threadKeys: [],
    needsAttentionCount: 0,
    latestUpdatedAt: 4000,
  };

  /** Base launchpad draft for the orange "has-draft" marker tests. */
  const projectBLaunchpad = {
    directoryKey: projectBDirectory.key,
    directoryKind: "directory" as const,
    directoryLabel: "ProjectB",
    directoryPath: projectBDirectory.path,
    workMode: "local" as const,
    backend: "codex" as const,
    executionMode: "default" as const,
    prompt: "",
    createdAt: 1,
    updatedAt: 2,
  };

  function getLaunchpadButton(label: string): HTMLElement {
    return screen.getByRole("button", {
      name: `Open new thread launchpad for ${label}`,
    });
  }

  it("marks a directory as having a draft when a message is composed", () => {
    renderSidebar(
      [
        {
          ...projectBDirectory,
          launchpad: { ...projectBLaunchpad, prompt: "Half-written message" },
        },
      ],
      { onSetDirectoryPin: async () => undefined },
    );

    expect(getLaunchpadButton("ProjectB")).toHaveClass("has-draft");
  });

  it("does not mark a directory as having a draft when only its settings were touched", () => {
    renderSidebar(
      [
        {
          ...projectBDirectory,
          launchpad: {
            ...projectBLaunchpad,
            executionMode: "full-access" as const,
            prompt: "",
            settingsTouchedAt: 2_000,
          },
        },
      ],
      { onSetDirectoryPin: async () => undefined },
    );

    // Picking a model / reasoning level / access mode for a project is a sticky
    // preference we keep, not an unsent draft. The orange marker means "you
    // composed something here" — it must stay off.
    expect(getLaunchpadButton("ProjectB")).not.toHaveClass("has-draft");
  });

  it("does not render a sub-thread launchpad as a directory row", () => {
    renderSidebar([projectADirectory, subthreadLaunchpadDirectory], {
      onSetDirectoryPin: async () => undefined,
      onRemoveDirectory: () => undefined,
    });

    expect(getDirectorySummary(/ProjectA/i)).toBeInTheDocument();
    // The open sub-thread composer's transient row must not appear as a project
    // directory — it would duplicate its parent's real directory and, having no
    // threads, would be offered "Remove Directory".
    expect(
      screen.queryByRole("button", { name: /media-service/i }),
    ).not.toBeInTheDocument();
  });

  it("falls back to the empty state when only sub-thread launchpads exist", () => {
    renderSidebar([subthreadLaunchpadDirectory], {
      onSetDirectoryPin: async () => undefined,
      onRemoveDirectory: () => undefined,
    });

    expect(screen.getByText("No directory-linked threads.")).toBeInTheDocument();
  });

  it("offers Remove Directory on an empty directory row", async () => {
    const onRemoveDirectory = vi.fn();

    renderSidebar([projectBDirectory], {
      onSetDirectoryPin: async () => undefined,
      onRemoveDirectory,
    });

    fireEvent.contextMenu(getDirectorySummary(/ProjectB/i));

    const removeItem = await screen.findByRole("menuitem", {
      name: "Remove Directory",
    });
    await clickElement(removeItem);

    expect(onRemoveDirectory).toHaveBeenCalledWith(projectBDirectory);
    expect(
      screen.queryByRole("menuitem", { name: "Remove Directory" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer Remove Directory on a directory that still has threads", async () => {
    const populated: NavigationDirectorySummary = {
      ...projectBDirectory,
      threadKeys: ["codex:thread-1"],
    };

    renderSidebar([populated], {
      onSetDirectoryPin: async () => undefined,
      onRemoveDirectory: vi.fn(),
    });

    fireEvent.contextMenu(getDirectorySummary(/ProjectB/i));

    // The pin item proves the menu opened; Remove must be absent because
    // removing the row would strand the threads that live in it.
    expect(
      await screen.findByRole("menuitem", { name: "Pin Directory" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Remove Directory" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer Remove Directory on a workspace row", async () => {
    renderSidebar([workspaceDirectory], {
      onSetDirectoryPin: async () => undefined,
      onRemoveDirectory: vi.fn(),
    });

    fireEvent.contextMenu(getDirectorySummary(/Workspace/i));

    expect(
      await screen.findByRole("menuitem", { name: "Pin Directory" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Remove Directory" }),
    ).not.toBeInTheDocument();
  });

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

  it("keeps the directory launchpad button a single click and puts machines behind the chevron", async () => {
    const onOpenLaunchpad = vi.fn(async () => undefined);
    const onCreateThreadOnFederationTarget = vi.fn(async () => undefined);

    renderSidebar([projectADirectory], {
      onOpenLaunchpad,
      onCreateThreadOnFederationTarget,
      newThreadFederationTargets: [
        {
          availability: "available",
          instanceId: "studio-work",
          label: "Studio Mac / work",
        },
      ],
    });

    // The icon itself keeps its existing one-click meaning.
    await clickElement(
      screen.getByRole("button", {
        name: "Open new thread launchpad for ProjectA",
      }),
    );
    expect(onOpenLaunchpad).toHaveBeenCalledTimes(1);
    expect(onCreateThreadOnFederationTarget).not.toHaveBeenCalled();

    const chevron = screen.getByRole("button", {
      name: "Start a new thread on another machine (from ProjectA)",
    });
    // The group hover treatment is gated on this modifier, so that it never
    // applies to a lone launchpad button.
    expect(chevron.parentElement).toHaveClass(
      "directory-row__launchpad-cluster--split",
    );
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    await clickElement(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    await clickElement(
      await screen.findByRole("menuitem", { name: "Studio Mac / work" }),
    );
    expect(chevron).toHaveAttribute("aria-expanded", "false");

    expect(onCreateThreadOnFederationTarget).toHaveBeenCalledWith("studio-work");
    // Opening a remote launchpad is not also a local launchpad open.
    expect(onOpenLaunchpad).toHaveBeenCalledTimes(1);
  });

  it("hides the whole launchpad cluster on a directory this instance cannot host", () => {
    // The unconfigured guard wraps icon AND chevron. Offering "new chat on
    // <machine>" from a row with no local launchpad would reintroduce the
    // affordance that guard exists to remove, and it is not directory-scoped
    // anyway — it opens the peer's own launchpad.
    renderSidebar(
      [{ ...projectADirectory, localAvailability: "unconfigured" }],
      {
        newThreadFederationTargets: [
          {
            availability: "available",
            instanceId: "studio-work",
            label: "Studio Mac / work",
          },
        ],
        onCreateThreadOnFederationTarget: async () => undefined,
      },
    );

    expect(
      screen.queryByRole("button", {
        name: "Open new thread launchpad for ProjectA",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Start a new thread on another machine (from ProjectA)",
      }),
    ).not.toBeInTheDocument();
  });

  it("omits the chevron entirely when the federation offers no machines", () => {
    renderSidebar([projectADirectory], { newThreadFederationTargets: [] });

    const launchpad = screen.getByRole("button", {
      name: "Open new thread launchpad for ProjectA",
    });
    expect(launchpad).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Start a new thread on another machine (from ProjectA)",
      }),
    ).not.toBeInTheDocument();
    // Without a second half there is no group to express, and the group tint
    // would only composite under the button's own hover pill and darken it.
    expect(launchpad.parentElement).not.toHaveClass(
      "directory-row__launchpad-cluster--split",
    );
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
  // Move Up / Move Down only surface in the Directories lens — the only lens
  // that still renders a pinned section, and therefore the only one where a
  // reorder visibly moves the row. Updated and Created are pure sort orders.
  const pinnedThreadsDirectory = (
    threadKeys: string[],
  ): NavigationDirectorySummary => ({
    ...directories[0]!,
    needsAttentionCount: 0,
    threadKeys,
  });

  it("moves a colliding remote pin above a newer local pin", async () => {
    // A local auto-pin used to reuse a viewer-owned remote rank. Recency then
    // put the newer local row first, but Move Up must still submit one global
    // order that places the remote row above it.
    const onReorderThreadPins = vi.fn(async () => undefined);
    const codexTop = {
      ...sharedThread,
      id: "codex-top",
      title: "Codex top pin",
      source: "codex" as const,
      pinnedRank: "1024",
      updatedAt: 2_000,
    };
    const grokMiddle = {
      ...sharedThread,
      id: "grok-middle",
      title: "Grok middle pin",
      source: "acp:grok" as const,
      pinnedRank: "1024",
      updatedAt: 1_000,
      federation: {
        ref: {
          backend: "acp:grok" as const,
          target: { scope: "remote" as const, instanceId: "peer-laptop" },
          threadId: "grok-middle",
        },
        instanceLabel: "Laptop",
        peerStatus: "connected" as const,
        capabilities: [],
      },
    };
    const grokBottom = {
      ...sharedThread,
      id: "grok-bottom",
      title: "Grok bottom pin",
      source: "acp:grok" as const,
      pinnedRank: "3072",
    };

    render(
      <Sidebar
        backends={backends}
        browseMode="directories"
        createThreadError={undefined}
        directories={[
          pinnedThreadsDirectory([
            "codex:codex-top",
            "acp:grok:grok-middle",
            "acp:grok:grok-bottom",
          ]),
        ]}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:codex-top"
        threads={[codexTop, grokMiddle, grokBottom]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onReorderThreadPins={onReorderThreadPins}
        onSelectThread={() => undefined}
        onSetThreadPin={async () => undefined}
      />,
    );

    const remoteRow = screen
      .getByRole("button", { name: /Grok middle pin/i })
      .closest(".thread-row-shell") as HTMLElement;
    fireEvent.click(
      remoteRow.querySelector(".thread-row__overflow-button") as HTMLButtonElement,
    );

    const moveUp = await screen.findByRole("menuitem", { name: /Move Up/i });
    const moveDown = await screen.findByRole("menuitem", {
      name: /Move Down/i,
    });
    expect(moveUp).toBeEnabled();
    expect(moveDown).toBeEnabled();

    fireEvent.click(moveUp);
    expect(onReorderThreadPins).toHaveBeenCalledWith([
      "acp:grok:grok-middle",
      "codex:codex-top",
      "acp:grok:grok-bottom",
    ]);
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
        browseMode="directories"
        createThreadError={undefined}
        directories={[
          pinnedThreadsDirectory(["codex:thread-top", "codex:thread-bottom"]),
        ]}
        inboxThreads={[]}
        launchpadError={undefined}
        loading={false}
        creatingThread={undefined}
        selectedItemKey="codex:thread-top"
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
    expect(onReorderThreadPins).toHaveBeenCalledWith([
      `codex:${pinnedBottom.id}`,
      `codex:${pinnedTop.id}`,
    ]);
  });
});
