import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { FixtureSidebar as Sidebar } from "../../../test/navigation-presentation-fixture";
import type { PendingLaunchpadCreation } from "../../../lib/useThreadNavigation";
import { interleaveStartingSubthreads } from "../StartingThreadRow";
import { buildSubthreadLaunchpadKey } from "../../../lib/subthread-launchpads";

afterEach(cleanup);

const PROJECT_PATH = "/Users/fixture-user/pwrdrvr/PwrSnap";
const PROJECT_KEY = `directory:${PROJECT_PATH}`;

function thread(id: string, patch: Partial<NavigationThreadSummary> = {}): NavigationThreadSummary {
  return {
    id,
    title: id,
    titleSource: "explicit",
    source: "codex",
    executionMode: "default",
    createdAt: 1,
    updatedAt: 1,
    inbox: { inInbox: false },
    subthreadsCollapsed: false,
    linkedDirectories: [{ id: `${id}-dir`, label: "PwrSnap", path: PROJECT_PATH, kind: "local" }],
    ...patch,
  };
}

// No `threadKeys`: the fixture owner then files threads by linked directory,
// which is what each test's rows carry.
const directories = [
  { key: PROJECT_KEY, kind: "directory", label: "PwrSnap", path: PROJECT_PATH },
] as NavigationDirectorySummary[];

function creation(patch: Partial<PendingLaunchpadCreation> = {}): PendingLaunchpadCreation {
  return {
    selectionKey: "starting-launchpad:1",
    directoryKey: PROJECT_KEY,
    directoryLabel: "PwrSnap",
    launchpad: {
      backend: "codex",
      directoryKey: PROJECT_KEY,
      directoryKind: "directory",
      directoryLabel: "PwrSnap",
      directoryPath: PROJECT_PATH,
      executionMode: "default",
      prompt: "Add a crop tool",
      workMode: "worktree",
    } as PendingLaunchpadCreation["launchpad"],
    composerScopeKey: `launchpad:starting:1:${PROJECT_KEY}`,
    setupProgressKey: "starting-launchpad:1",
    title: "Add a crop tool",
    input: [],
    ...patch,
  };
}

function renderSidebar(props: {
  browseMode: "attention" | "drafts" | "inbox" | "recents" | "directories";
  threads: NavigationThreadSummary[];
  creations: PendingLaunchpadCreation[];
  selectedItemKey?: string;
  onSelectPendingLaunchpad?: (creation: PendingLaunchpadCreation) => void;
}) {
  return render(
    <Sidebar
      backends={[]}
      browseMode={props.browseMode}
      directories={directories}
      inboxThreads={[]}
      loaded
      loading={false}
      pendingLaunchpadCreations={props.creations}
      selectedItemKey={props.selectedItemKey}
      threads={props.threads}
      onBrowseModeChange={() => undefined}
      onCreateThread={async () => undefined}
      onOpenLaunchpad={async () => undefined}
      onSelectPendingLaunchpad={props.onSelectPendingLaunchpad}
      onSelectThread={() => undefined}
    />,
  );
}

function rowNames(list: HTMLElement): string[] {
  return [...list.querySelectorAll<HTMLElement>(".thread-row__open")]
    .map((button) => button.getAttribute("aria-label") ?? "");
}

describe("a thread that is still starting", () => {
  it("takes the top unpinned slot in its project, as a thread row", () => {
    const onSelectPendingLaunchpad = vi.fn();
    const starting = creation();
    renderSidebar({
      browseMode: "directories",
      threads: [thread("Older thread")],
      creations: [starting],
      selectedItemKey: starting.selectionKey,
      onSelectPendingLaunchpad,
    });

    const project = screen.getByRole("list", { name: "Threads in PwrSnap" });
    expect(rowNames(project)).toEqual(["Add a crop tool, starting in PwrSnap", "Older thread"]);
    const row = within(project).getByRole("button", { name: "Add a crop tool, starting in PwrSnap" });
    expect(row).toHaveAttribute("aria-pressed", "true");
    const card = row.closest(".thread-row")!;
    expect(card).toHaveClass("thread-row--compact", "is-selected");
    // The working scanner, so it sweeps in step with every working row.
    expect(within(card as HTMLElement).getByRole("img", { name: "Starting" }).querySelector(".thinking-scanner"))
      .not.toBeNull();
    // Filed under its project, the row does not repeat the project's name.
    expect(card.querySelector(".thread-row__chips")).not.toHaveTextContent("PwrSnap");
    // No drag until the thread exists: pin order is keyed by its id.
    expect(row.closest(".thread-row-shell")).not.toHaveAttribute("draggable");

    fireEvent.click(row);
    expect(onSelectPendingLaunchpad).toHaveBeenCalledWith(starting);
  });

  it("opens its project when it is the selection", () => {
    const starting = creation();
    renderSidebar({
      browseMode: "directories",
      threads: [],
      creations: [starting],
      selectedItemKey: starting.selectionKey,
    });

    expect(screen.getByRole("list", { name: "Threads in PwrSnap" }))
      .toContainElement(screen.getByRole("button", { name: "Add a crop tool, starting in PwrSnap" }));
    expect(screen.queryByText("No threads in this directory yet.")).not.toBeInTheDocument();
  });

  it("lands last among the pins when its project's rows are collapsed under them", () => {
    const pinnedDirectories = [{ ...directories[0]!, directoryThreadsCollapsed: true }] as NavigationDirectorySummary[];
    const starting = creation();
    render(
      <Sidebar
        backends={[]}
        browseMode="directories"
        directories={pinnedDirectories}
        inboxThreads={[]}
        loaded
        loading={false}
        pendingLaunchpadCreations={[starting]}
        selectedItemKey={starting.selectionKey}
        threads={[thread("Pinned thread", { pinnedRank: "a0" }), thread("Older thread")]}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
      />,
    );

    const project = screen.getByRole("list", { name: "Threads in PwrSnap" });
    // Main pins the new thread there, so it stays out from under the divider.
    expect(rowNames(project)).toEqual(["Pinned thread, pinned", "Add a crop tool, starting in PwrSnap"]);
    const divider = screen.getByRole("button", { name: "Show directory threads for PwrSnap" });
    expect(
      within(project).getByRole("button", { name: "Add a crop tool, starting in PwrSnap" })
        .compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("opens the parent's project for a starting sub-thread", () => {
    const starting = creation({
      directoryKey: buildSubthreadLaunchpadKey({ id: "Parent", source: "codex" }, "new-worktree"),
      parentThreadKey: "codex:Parent",
      sourceThreadKey: "codex:Parent",
    });
    renderSidebar({
      browseMode: "directories",
      threads: [thread("Parent")],
      creations: [starting],
      selectedItemKey: starting.selectionKey,
    });

    expect(rowNames(screen.getByRole("list", { name: "Sub-threads of Parent" })))
      .toEqual(["Add a crop tool, starting in PwrSnap"]);
  });

  it("lands directly below the card that opened its sub-thread launchpad", () => {
    const parent = thread("Parent");
    const first = thread("First child", { parentThreadId: "Parent", createdAt: 3 });
    const second = thread("Second child", { parentThreadId: "Parent", createdAt: 2 });
    renderSidebar({
      browseMode: "directories",
      threads: [parent, first, second],
      creations: [
        creation({ parentThreadKey: "codex:Parent", sourceThreadKey: "codex:First child" }),
        creation({
          selectionKey: "starting-launchpad:2",
          title: "From the parent",
          parentThreadKey: "codex:Parent",
          sourceThreadKey: "codex:Parent",
        }),
      ],
      selectedItemKey: "codex:Parent",
    });

    expect(rowNames(screen.getByRole("list", { name: "Sub-threads of Parent" }))).toEqual([
      "From the parent, starting in PwrSnap",
      "First child",
      "Add a crop tool, starting in PwrSnap",
      "Second child",
    ]);
  });

  it("opens a collapsed tray, as the created thread will", () => {
    renderSidebar({
      browseMode: "inbox",
      threads: [thread("Parent", { subthreadsCollapsed: true })],
      creations: [creation({ parentThreadKey: "codex:Parent", sourceThreadKey: "codex:Parent" })],
    });

    expect(rowNames(screen.getByRole("list", { name: "Sub-threads of Parent" })))
      .toEqual(["Add a crop tool, starting in PwrSnap"]);
  });

  it("leads the list in a sorted lens and names its project there", () => {
    renderSidebar({ browseMode: "inbox", threads: [thread("Older thread")], creations: [creation()] });

    const row = screen.getByRole("button", { name: "Add a crop tool, starting in PwrSnap" });
    expect(rowNames(row.closest<HTMLElement>(".sidebar-list")!))
      .toEqual(["Add a crop tool, starting in PwrSnap", "Older thread"]);
    expect(row.closest(".thread-row")!.querySelector(".thread-row__chips")).toHaveTextContent("PwrSnap");
  });

  it("stands in for an empty lens instead of the empty-state line", () => {
    renderSidebar({ browseMode: "attention", threads: [], creations: [creation()] });

    expect(screen.getByRole("button", { name: "Add a crop tool, starting in PwrSnap" })).toBeInTheDocument();
    expect(screen.queryByText("Nothing running, nothing to review.")).not.toBeInTheDocument();
  });

  it("is not in Drafts, where a new thread never lands", () => {
    renderSidebar({ browseMode: "drafts", threads: [], creations: [creation()] });

    expect(screen.queryByRole("button", { name: /starting in/ })).not.toBeInTheDocument();
  });

  it("steps aside once its thread renders in the slot", () => {
    renderSidebar({
      browseMode: "directories",
      threads: [thread("Add a crop tool", { createdAt: 5 }), thread("Older thread")],
      creations: [creation({ threadKey: "codex:Add a crop tool" })],
      selectedItemKey: "codex:Add a crop tool",
    });

    expect(rowNames(screen.getByRole("list", { name: "Threads in PwrSnap" })))
      .toEqual(["Add a crop tool", "Older thread"]);
  });
});

describe("interleaveStartingSubthreads", () => {
  const depths: Record<string, number> = { "codex:A": 1, "codex:A1": 2, "codex:B": 1 };
  const subtree = [thread("A"), thread("A1", { parentThreadId: "A" }), thread("B")];
  const place = (patch: Partial<PendingLaunchpadCreation>) =>
    interleaveStartingSubthreads({
      trayKey: "codex:P",
      subtree,
      depthOf: (key) => depths[key] ?? 1,
      creations: [creation(patch)],
    }).map((entry) => entry.kind === "thread" ? entry.thread.id : `starting@${entry.depth}`);

  it("puts a child of the tray owner first", () => {
    expect(place({ parentThreadKey: "codex:P", sourceThreadKey: "codex:P" }))
      .toEqual(["starting@1", "A", "A1", "B"]);
  });

  it("puts a sibling after its source's whole subtree", () => {
    expect(place({ parentThreadKey: "codex:P", sourceThreadKey: "codex:A" }))
      .toEqual(["A", "A1", "starting@1", "B"]);
  });

  it("nests a grandchild directly under its parent", () => {
    expect(place({ parentThreadKey: "codex:A", sourceThreadKey: "codex:A" }))
      .toEqual(["A", "starting@2", "A1", "B"]);
  });

  it("leaves a tray alone when the parent is elsewhere", () => {
    expect(place({ parentThreadKey: "codex:Q", sourceThreadKey: "codex:Q" })).toEqual(["A", "A1", "B"]);
  });
});
