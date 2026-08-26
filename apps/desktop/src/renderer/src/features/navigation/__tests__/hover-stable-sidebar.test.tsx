import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
  onSelectThread?: (thread: NavigationThreadSummary) => void;
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
      onOpenLaunchpad={async () => undefined}
      onSelectThread={params.onSelectThread ?? (() => undefined)}
      onSetSubthreadsCollapsed={params.onSetSubthreadsCollapsed}
    />
  );
}

function threadTitles(): string[] {
  const browser = screen.getByRole("region", { name: "Thread browser" });
  return within(browser)
    .getAllByRole("listitem")
    .map((row) => row.querySelector(".thread-row__title")?.textContent ?? "");
}

function hoverFirstThread(): HTMLElement {
  const firstRow = screen.getAllByRole("listitem")[0];
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

  it("defers a Directories pin promotion until hover ends", () => {
    const view = render(renderSidebar({
      browseMode: "directories",
      directories: [directory],
      selectedItemKey: "codex:alpha",
      threads: [alpha, bravo],
    }));
    hoverFirstThread();

    const pinnedBravo = { ...bravo, pinnedRank: "1024" };
    const expandedDirectory = {
      ...directory,
      threadKeys: ["codex:charlie", ...directory.threadKeys],
    };
    view.rerender(renderSidebar({
      browseMode: "directories",
      directories: [expandedDirectory],
      selectedItemKey: "codex:alpha",
      threads: [charlie, alpha, pinnedBravo],
    }));

    expect(threadTitles()).toEqual([
      "Alpha thread",
      "Bravo thread",
      "Charlie thread",
    ]);
    leaveThreadBrowser();
    expect(threadTitles()).toEqual([
      "Bravo thread",
      "Charlie thread",
      "Alpha thread",
    ]);
  });
});
