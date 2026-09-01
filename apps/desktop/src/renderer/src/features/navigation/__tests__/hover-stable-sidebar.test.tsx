import "@testing-library/jest-dom/vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { BrowseMode } from "../../../lib/useThreadNavigation";
import { Sidebar } from "../Sidebar";

function thread(params: {
  createdAt?: number;
  id: string;
  inbox?: NavigationThreadSummary["inbox"];
  pinnedRank?: string;
  status?: NavigationThreadSummary["threadStatus"];
  title: string;
  updatedAt?: number;
}): NavigationThreadSummary {
  return {
    id: params.id,
    title: params.title,
    titleSource: "explicit",
    source: "codex",
    executionMode: "default",
    createdAt: params.createdAt ?? params.updatedAt ?? 1,
    updatedAt: params.updatedAt ?? 1,
    inbox: params.inbox ?? { inInbox: true, reason: "new-thread" },
    linkedDirectories: [],
    pinnedRank: params.pinnedRank,
    threadStatus: params.status,
  };
}

const alpha = thread({
  createdAt: 2,
  id: "alpha",
  title: "Alpha thread",
  updatedAt: 2,
});
const bravo = thread({
  createdAt: 1,
  id: "bravo",
  title: "Bravo thread",
  updatedAt: 1,
});
const charlie = thread({
  createdAt: 3,
  id: "charlie",
  title: "Charlie thread",
  updatedAt: 3,
});

const directory: NavigationDirectorySummary = {
  key: "directory:/repo",
  kind: "directory",
  label: "Repo",
  path: "/repo",
  threadKeys: ["codex:alpha", "codex:bravo"],
  needsAttentionCount: 0,
  latestUpdatedAt: 2,
};

function renderSidebar(params: {
  browseMode: BrowseMode;
  directories?: NavigationDirectorySummary[];
  draftThreadKeys?: Record<string, boolean>;
  inboxThreads?: NavigationThreadSummary[];
  onOpenLaunchpad?: (
    directory: NavigationDirectorySummary,
  ) => Promise<void>;
  onReorderThreadPins?: (orderedThreadKeys: string[]) => Promise<void>;
  onSelectThread?: (thread: NavigationThreadSummary) => void;
  onSetThreadPin?: (
    thread: NavigationThreadSummary,
    pinned: boolean,
  ) => Promise<void>;
  onSetSubthreadsCollapsed?: (
    parent: NavigationThreadSummary,
    collapsed: boolean,
  ) => Promise<void>;
  recentThreads?: NavigationThreadSummary[];
  selectedItemKey?: string;
  threads: NavigationThreadSummary[];
}) {
  return (
    <Sidebar
      backends={[]}
      browseMode={params.browseMode}
      directories={params.directories ?? []}
      draftThreadKeys={params.draftThreadKeys}
      inboxThreads={params.inboxThreads ?? params.threads}
      loading={false}
      recentThreads={params.recentThreads}
      selectedItemKey={params.selectedItemKey}
      threads={params.threads}
      onBrowseModeChange={() => undefined}
      onCreateThread={async () => undefined}
      onOpenLaunchpad={params.onOpenLaunchpad ?? (async () => undefined)}
      onReorderThreadPins={params.onReorderThreadPins}
      onSelectThread={params.onSelectThread ?? (() => undefined)}
      onSetThreadPin={params.onSetThreadPin}
      onSetSubthreadsCollapsed={params.onSetSubthreadsCollapsed}
    />
  );
}

// `listitem` is no longer a synonym for "thread row": the Directories lane's
// "Directory threads" disclosure and "Show more" are wrapped in one each, so
// they are valid children of the list its rows need as their parent. Filter to
// the row shell, or every ordering assertion below picks up a control as an
// untitled row.
function threadRows(scope: HTMLElement): HTMLElement[] {
  return within(scope)
    .getAllByRole("listitem")
    .filter((row) => row.classList.contains("thread-row-shell"));
}

function threadTitles(): string[] {
  const browser = screen.getByRole("region", { name: "Thread browser" });
  return threadRows(browser).map(
    (row) => row.querySelector(".thread-row__title")?.textContent ?? "",
  );
}

function hoverFirstThread(): HTMLElement {
  const firstRow = threadRows(document.body)[0];
  fireEvent.pointerOver(firstRow, { pointerType: "mouse" });
  return firstRow;
}

function leaveThreadBrowser(): void {
  const scrollRegion = document.querySelector(".sidebar__scroll-region");
  if (!(scrollRegion instanceof HTMLElement)) {
    throw new Error("Expected the sidebar scroll region");
  }
  fireEvent.pointerLeave(scrollRegion, { pointerType: "mouse" });
}

function threadRow(title: string): HTMLElement {
  const row = screen.getByRole("button", { name: new RegExp(`^${title}`) })
    .closest<HTMLElement>("[data-hover-stable-row]");
  if (!row) {
    throw new Error(`Expected a hover-stable row for ${title}`);
  }
  return row;
}

describe("Sidebar hover-stable thread ordering", () => {
  it("keeps an Inbox click aimed at a local row when a remote collision appears", () => {
    const onSelectThread = vi.fn<(thread: NavigationThreadSummary) => void>();
    const initial = [alpha, bravo];
    const view = render(renderSidebar({
      browseMode: "inbox",
      onSelectThread,
      threads: initial,
    }));
    const firstRow = hoverFirstThread();

    const offlineAlpha: NavigationThreadSummary = {
      ...alpha,
      federation: {
        ref: {
          backend: "codex",
          target: { scope: "remote", instanceId: "remote-instance" },
          threadId: alpha.id,
        },
        instanceLabel: "Remote fixture",
        peerStatus: "disconnected",
      },
    };
    const refreshedBravo = { ...bravo, title: "Bravo thread refreshed" };
    const resorted = [refreshedBravo, offlineAlpha];
    view.rerender(renderSidebar({
      browseMode: "inbox",
      onSelectThread,
      threads: resorted,
    }));

    expect(threadTitles()).toEqual([
      "Alpha thread",
      "Bravo thread refreshed",
      "Alpha thread",
    ]);
    expect(firstRow.querySelector(".thread-row")).not.toHaveClass(
      "is-remote-offline",
    );
    fireEvent.click(within(firstRow).getByRole("button", { name: /^Alpha thread/ }));
    expect(onSelectThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: "alpha" }),
    );

    leaveThreadBrowser();
    expect(threadTitles()).toEqual([
      "Bravo thread refreshed",
      "Alpha thread",
    ]);
  });

  it("defers a legitimate Attention turn-boundary promotion until hover ends", () => {
    const activeAlpha = { ...alpha, threadStatus: "active" as const };
    const unreadBravo = {
      ...bravo,
      inbox: {
        inInbox: true,
        reason: "updated-since-seen" as const,
        lastSeenUpdatedAt: 0,
      },
    };
    const view = render(renderSidebar({
      browseMode: "attention",
      threads: [activeAlpha, unreadBravo],
    }));
    hoverFirstThread();

    const startedBravo = {
      ...unreadBravo,
      threadStatus: "active" as const,
      updatedAt: 3,
    };
    view.rerender(renderSidebar({
      browseMode: "attention",
      threads: [startedBravo, activeAlpha],
    }));

    expect(threadTitles()).toEqual(["Alpha thread", "Bravo thread"]);
    leaveThreadBrowser();
    expect(threadTitles()).toEqual(["Bravo thread", "Alpha thread"]);
  });

  it("appends newly visible threads until hover ends", () => {
    const view = render(renderSidebar({
      browseMode: "inbox",
      threads: [alpha, bravo],
    }));
    hoverFirstThread();

    view.rerender(renderSidebar({
      browseMode: "inbox",
      threads: [charlie, alpha, bravo],
    }));

    expect(threadTitles()).toEqual([
      "Alpha thread",
      "Bravo thread",
      "Charlie thread",
    ]);
    leaveThreadBrowser();
    expect(threadTitles()).toEqual([
      "Charlie thread",
      "Alpha thread",
      "Bravo thread",
    ]);
  });

  it("updates an inline Inbox pin without releasing deferred ordering", () => {
    const onSetThreadPin = vi.fn(async () => undefined);
    const view = render(renderSidebar({
      browseMode: "inbox",
      threads: [alpha, bravo],
      onSetThreadPin,
    }));
    const alphaRow = threadRow("Alpha thread");
    fireEvent.pointerOver(alphaRow, { pointerType: "mouse" });
    view.rerender(renderSidebar({
      browseMode: "inbox",
      threads: [bravo, alpha],
      onSetThreadPin,
    }));

    fireEvent.click(
      within(alphaRow).getByRole("button", { name: "Pin thread" }),
    );
    expect(onSetThreadPin).toHaveBeenCalledWith(alpha, true);

    view.rerender(renderSidebar({
      browseMode: "inbox",
      threads: [bravo, { ...alpha, pinnedRank: "1024" }],
      onSetThreadPin,
    }));

    expect(threadTitles()).toEqual(["Alpha thread", "Bravo thread"]);
    expect(
      within(threadRow("Alpha thread")).getByRole("button", {
        name: "Unpin thread",
      }),
    ).toBeInTheDocument();
    leaveThreadBrowser();
    expect(threadTitles()).toEqual(["Bravo thread", "Alpha thread"]);
  });

  it("updates a context-menu Inbox unpin without releasing deferred ordering", () => {
    const onSetThreadPin = vi.fn(async () => undefined);
    const pinnedAlpha = { ...alpha, pinnedRank: "1024" };
    const view = render(renderSidebar({
      browseMode: "inbox",
      threads: [pinnedAlpha, bravo],
      onSetThreadPin,
    }));
    const alphaRow = threadRow("Alpha thread");
    fireEvent.pointerOver(alphaRow, { pointerType: "mouse" });
    view.rerender(renderSidebar({
      browseMode: "inbox",
      threads: [bravo, pinnedAlpha],
      onSetThreadPin,
    }));

    fireEvent.contextMenu(
      within(alphaRow).getByRole("button", { name: /^Alpha thread/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin Thread" }));
    expect(onSetThreadPin).toHaveBeenCalledWith(pinnedAlpha, false);

    view.rerender(renderSidebar({
      browseMode: "inbox",
      threads: [bravo, alpha],
      onSetThreadPin,
    }));

    expect(threadTitles()).toEqual(["Alpha thread", "Bravo thread"]);
    expect(
      within(threadRow("Alpha thread")).getByRole("button", {
        name: "Pin thread",
      }),
    ).toBeInTheDocument();
  });

  it("removes an archived Attention row without resorting the survivors", () => {
    const activeAlpha = { ...alpha, threadStatus: "active" as const };
    const unreadBravo = {
      ...bravo,
      inbox: {
        inInbox: true,
        reason: "updated-since-seen" as const,
        lastSeenUpdatedAt: 0,
      },
    };
    const unreadCharlie = {
      ...charlie,
      inbox: {
        inInbox: true,
        reason: "updated-since-seen" as const,
        lastSeenUpdatedAt: 0,
      },
    };
    const view = render(renderSidebar({
      browseMode: "attention",
      threads: [activeAlpha, unreadBravo, unreadCharlie],
    }));
    hoverFirstThread();

    view.rerender(renderSidebar({
      browseMode: "attention",
      threads: [unreadCharlie, unreadBravo],
    }));

    expect(threadTitles()).toEqual(["Bravo thread", "Charlie thread"]);
    leaveThreadBrowser();
    expect(threadTitles()).toEqual(["Bravo thread", "Charlie thread"]);
  });

  it("freezes fields that add or remove subthread rows while hovered", () => {
    const parent = thread({
      id: "parent",
      title: "Parent thread",
      updatedAt: 3,
    });
    const child: NavigationThreadSummary = {
      ...thread({ id: "child", title: "Child thread", updatedAt: 2 }),
      parentThreadId: parent.id,
    };
    const tail = thread({ id: "tail", title: "Tail thread", updatedAt: 1 });
    const onSetSubthreadsCollapsed = vi.fn(async () => undefined);
    const view = render(renderSidebar({
      browseMode: "inbox",
      onSetSubthreadsCollapsed,
      threads: [parent, child, tail],
    }));
    const tailRow = screen.getByRole("button", { name: /^Tail thread/ })
      .closest("[data-hover-stable-row]");
    if (!(tailRow instanceof HTMLElement)) {
      throw new Error("Expected the tail thread row");
    }
    fireEvent.pointerOver(tailRow, { pointerType: "mouse" });

    const latestParent: NavigationThreadSummary = {
      ...parent,
      codexNativeSubAgents: [
        {
          threadId: "native-worker",
          title: "Native worker",
          depth: 1,
          agentNickname: "worker",
          agentRole: "reviewer",
          threadStatus: "active",
        },
      ],
      subthreadsCollapsed: true,
    };
    view.rerender(renderSidebar({
      browseMode: "inbox",
      onSetSubthreadsCollapsed,
      threads: [latestParent, child, tail],
    }));

    expect(screen.getByRole("button", { name: "Child thread" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Collapse sub-threads for Parent thread",
    })).toBeInTheDocument();
    expect(screen.queryByText("Sub-agents")).not.toBeInTheDocument();

    leaveThreadBrowser();
    expect(screen.queryByRole("button", { name: "Child thread" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Expand sub-threads for Parent thread",
    })).toBeInTheDocument();
  });

  it("releases the frozen snapshot for an explicit subthread toggle", () => {
    const parent = thread({
      id: "parent",
      title: "Parent thread",
      updatedAt: 3,
    });
    const child: NavigationThreadSummary = {
      ...thread({ id: "child", title: "Child thread", updatedAt: 2 }),
      parentThreadId: parent.id,
    };
    const tail = thread({ id: "tail", title: "Tail thread", updatedAt: 1 });
    const onSetSubthreadsCollapsed = vi.fn(async () => undefined);
    const view = render(renderSidebar({
      browseMode: "inbox",
      onSetSubthreadsCollapsed,
      threads: [parent, child, tail],
    }));
    const collapseButton = screen.getByRole("button", {
      name: "Collapse sub-threads for Parent thread",
    });
    fireEvent.pointerOver(collapseButton, { pointerType: "mouse" });
    fireEvent.click(collapseButton);
    expect(onSetSubthreadsCollapsed).toHaveBeenCalledWith(parent, true);

    view.rerender(renderSidebar({
      browseMode: "inbox",
      onSetSubthreadsCollapsed,
      threads: [{ ...parent, subthreadsCollapsed: true }, child, tail],
    }));

    expect(screen.queryByRole("button", { name: "Child thread" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Expand sub-threads for Parent thread",
    })).toBeInTheDocument();
  });

  it.each([
    { browseMode: "drafts" as const, label: "Drafts" },
    { browseMode: "recents" as const, label: "Recents" },
  ])("defers a $label resort until hover ends", ({ browseMode }) => {
    const draftThreadKeys = {
      "codex:alpha": true,
      "codex:bravo": true,
    };
    const view = render(renderSidebar({
      browseMode,
      draftThreadKeys,
      recentThreads: [alpha, bravo],
      threads: [alpha, bravo],
    }));
    hoverFirstThread();

    view.rerender(renderSidebar({
      browseMode,
      draftThreadKeys,
      recentThreads: [bravo, alpha],
      threads: [bravo, alpha],
    }));

    expect(threadTitles()).toEqual(["Alpha thread", "Bravo thread"]);
    leaveThreadBrowser();
    expect(threadTitles()).toEqual(["Bravo thread", "Alpha thread"]);
  });

  it("applies a user-requested pin immediately while hovered", () => {
    const onSetThreadPin = vi.fn(async () => undefined);
    const view = render(renderSidebar({
      browseMode: "directories",
      directories: [directory],
      selectedItemKey: "codex:alpha",
      threads: [alpha, bravo],
      onSetThreadPin,
    }));
    const bravoRow = threadRow("Bravo thread");
    fireEvent.pointerOver(bravoRow, { pointerType: "mouse" });
    fireEvent.click(
      within(bravoRow).getByRole("button", { name: "Pin thread" }),
    );
    expect(onSetThreadPin).toHaveBeenCalledWith(bravo, true);

    const pinnedBravo = { ...bravo, pinnedRank: "1024" };
    view.rerender(renderSidebar({
      browseMode: "directories",
      directories: [directory],
      selectedItemKey: "codex:alpha",
      threads: [alpha, pinnedBravo],
      onSetThreadPin,
    }));

    expect(threadTitles()).toEqual(["Bravo thread", "Alpha thread"]);
  });

  it("removes a user-unpinned row from collapsed Directory threads immediately", () => {
    const onSetThreadPin = vi.fn(async () => undefined);
    const pinnedAlpha = { ...alpha, pinnedRank: "1024" };
    const pinnedBravo = { ...bravo, pinnedRank: "2048" };
    const collapsedDirectory = {
      ...directory,
      directoryThreadsCollapsed: true,
    };
    const view = render(renderSidebar({
      browseMode: "directories",
      directories: [collapsedDirectory],
      selectedItemKey: "codex:alpha",
      threads: [pinnedAlpha, pinnedBravo],
      onSetThreadPin,
    }));
    const alphaRow = threadRow("Alpha thread");
    fireEvent.pointerOver(alphaRow, { pointerType: "mouse" });
    fireEvent.click(
      within(alphaRow).getByRole("button", { name: "Unpin thread" }),
    );
    expect(onSetThreadPin).toHaveBeenCalledWith(pinnedAlpha, false);

    view.rerender(renderSidebar({
      browseMode: "directories",
      directories: [collapsedDirectory],
      selectedItemKey: "codex:alpha",
      threads: [{ ...alpha, pinnedRank: undefined }, pinnedBravo],
      onSetThreadPin,
    }));

    expect(threadTitles()).toEqual(["Bravo thread"]);
  });

  it("applies a pointer drag pin reorder immediately while hovered", async () => {
    const onReorderThreadPins = vi.fn(async () => undefined);
    const pinnedAlpha = { ...alpha, pinnedRank: "1024" };
    const pinnedBravo = { ...bravo, pinnedRank: "2048" };
    const view = render(renderSidebar({
      browseMode: "directories",
      directories: [directory],
      selectedItemKey: "codex:alpha",
      threads: [pinnedAlpha, pinnedBravo],
      onReorderThreadPins,
    }));
    const alphaRow = threadRow("Alpha thread");
    const bravoRow = threadRow("Bravo thread");
    fireEvent.pointerOver(alphaRow, { pointerType: "mouse" });
    vi.spyOn(alphaRow, "getBoundingClientRect").mockReturnValue({
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
    vi.spyOn(bravoRow, "getBoundingClientRect").mockReturnValue({
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
    const elementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => bravoRow,
    });
    try {
      fireEvent.pointerDown(alphaRow, {
        button: 0,
        clientX: 50,
        clientY: 150,
        pointerId: 41,
      });
      fireEvent.pointerMove(window, {
        buttons: 1,
        clientX: 50,
        clientY: 75,
        pointerId: 41,
      });
      await waitFor(() => {
        expect(bravoRow).toHaveClass("is-drop-target-after");
      });
      fireEvent.pointerUp(window, {
        button: 0,
        clientX: 50,
        clientY: 75,
        pointerId: 41,
      });
    } finally {
      if (elementFromPoint) {
        Object.defineProperty(document, "elementFromPoint", {
          configurable: true,
          value: elementFromPoint,
        });
      } else {
        Reflect.deleteProperty(document, "elementFromPoint");
      }
    }
    expect(onReorderThreadPins).toHaveBeenCalledWith([
      "codex:bravo",
      "codex:alpha",
    ]);

    view.rerender(renderSidebar({
      browseMode: "directories",
      directories: [directory],
      selectedItemKey: "codex:alpha",
      threads: [
        { ...pinnedAlpha, pinnedRank: "2048" },
        { ...pinnedBravo, pinnedRank: "1024" },
      ],
      onReorderThreadPins,
    }));

    expect(threadTitles()).toEqual(["Bravo thread", "Alpha thread"]);
  });

  it("shows a newly created pinned thread while Directory threads are collapsed", () => {
    const onOpenLaunchpad = vi.fn(async () => undefined);
    const pinnedAlpha = { ...alpha, pinnedRank: "1024" };
    const collapsedDirectory = {
      ...directory,
      directoryThreadsCollapsed: true,
    };
    const view = render(renderSidebar({
      browseMode: "directories",
      directories: [collapsedDirectory],
      selectedItemKey: "codex:alpha",
      threads: [pinnedAlpha, bravo],
      onOpenLaunchpad,
    }));
    const launchpadButton = screen.getByRole("button", {
      name: "Open new thread launchpad for Repo",
    });
    fireEvent.pointerOver(launchpadButton, { pointerType: "mouse" });
    fireEvent.click(launchpadButton);
    expect(onOpenLaunchpad).toHaveBeenCalledWith(collapsedDirectory, undefined);

    const expandedDirectory = {
      ...collapsedDirectory,
      threadKeys: ["codex:charlie", ...collapsedDirectory.threadKeys],
    };
    view.rerender(renderSidebar({
      browseMode: "directories",
      directories: [expandedDirectory],
      selectedItemKey: "codex:alpha",
      threads: [{ ...charlie, pinnedRank: "512" }, pinnedAlpha, bravo],
      onOpenLaunchpad,
    }));

    expect(threadTitles()).toEqual(["Charlie thread", "Alpha thread"]);
  });
});
