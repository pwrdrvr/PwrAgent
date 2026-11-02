import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_FORGE_AUTOMATION, type BackendSummary, type NavigationThreadSummary } from "@pwragent/shared";
import type { NavigationDirectoryView as NavigationDirectorySummary } from "../../../lib/navigation-loaded-rows";
import { FixtureSidebar as Sidebar } from "../../../test/navigation-presentation-fixture";
import { ProjectIndex, type ProjectIndexEntry } from "../ProjectIndex";
import {
  clampProjectIndexWidth,
  jumpScrollPlan,
  jumpTailIsOffscreen,
  projectTypeaheadIndex,
  resolveProjectIndexDrop,
  spyProjects,
} from "../project-index";

/**
 * The sidebar's project index (PwrAgent Claude Design: "Sidebar Project
 * Index UX Review"), a port of PwrGit's repo index.
 */

describe("project index rules", () => {
  it("names the project at the top of the list current, not the one with the most rows on screen", () => {
    // meridian's section is mostly scrolled away; northwind fills the list.
    const spy = spyProjects(
      [
        { key: "atlas", top: -400, bottom: -20 },
        { key: "meridian", top: -300, bottom: 40 },
        { key: "northwind", top: 40, bottom: 600 },
        { key: "orchard", top: 600, bottom: 700 },
      ],
      560,
    );
    expect(spy).toEqual({ current: "meridian", inView: ["meridian", "northwind"] });
  });

  it("has no current project when nothing is listed", () => {
    expect(spyProjects([], 560)).toEqual({ current: null, inView: [] });
  });

  it("cycles typeahead through names sharing a first letter, and extends a typed prefix", () => {
    const names = ["atlas-api", "atlas-web", "harbor", "meridian"];
    expect(projectTypeaheadIndex(names, 0, "a")).toBe(1);
    expect(projectTypeaheadIndex(names, 1, "a")).toBe(0);
    expect(projectTypeaheadIndex(names, 0, "atlas-w")).toBe(1);
    expect(projectTypeaheadIndex(names, 0, "z")).toBe(-1);
  });

  it("keeps a dragged width inside the column's bounds, in whole pixels", () => {
    expect(clampProjectIndexWidth(40, 76, 160)).toBe(76);
    expect(clampProjectIndexWidth(240, 76, 160)).toBe(160);
    expect(clampProjectIndexWidth(101.4, 76, 160)).toBe(101);
    // A sidebar too narrow for the column still answers its floor.
    expect(clampProjectIndexWidth(90, 76, 20)).toBe(76);
  });

  it("scrolls a jump's project to the top, growing the tail by what the list is short", () => {
    // Room to spare: no tail.
    expect(jumpScrollPlan({
      scrollTop: 100, blockTop: 300, scrollHeight: 2000, clientHeight: 500, tailHeight: 0,
    })).toEqual({ scrollTop: 400, tailHeight: 0 });
    // The last project: the list can scroll to 1500, the project starts at 1700.
    expect(jumpScrollPlan({
      scrollTop: 1200, blockTop: 500, scrollHeight: 2000, clientHeight: 500, tailHeight: 0,
    })).toEqual({ scrollTop: 1700, tailHeight: 200 });
    // A tail already drawn grows by the remainder only.
    expect(jumpScrollPlan({
      scrollTop: 1500, blockTop: 300, scrollHeight: 2100, clientHeight: 500, tailHeight: 100,
    })).toEqual({ scrollTop: 1800, tailHeight: 300 });
  });

  it("drops the tail only once none of it is on screen", () => {
    expect(jumpTailIsOffscreen(600, 560)).toBe(true);
    expect(jumpTailIsOffscreen(560, 560)).toBe(true);
    expect(jumpTailIsOffscreen(400, 560)).toBe(false);
  });
});

const entries: ProjectIndexEntry[] = [
  { key: "dir:atlas-api", label: "atlas-api", containsSelection: false, active: false, review: false },
  { key: "dir:atlas-web", label: "atlas-web", containsSelection: true, active: true, review: false },
  { key: "dir:harbor", label: "harbor", containsSelection: false, active: false, review: true },
];

function renderIndex(overrides: Partial<Parameters<typeof ProjectIndex>[0]> = {}) {
  const onJump = vi.fn();
  const onWidthChange = vi.fn();
  render(
    <ProjectIndex
      projects={entries}
      scrollRegionRef={createRef()}
      scrollRegionId="lanes"
      spy={false}
      width={null}
      onJump={onJump}
      onWidthChange={onWidthChange}
      {...overrides}
    />,
  );
  return { onJump, onWidthChange };
}

describe("ProjectIndex", () => {
  it("lists every project as a button that jumps to it", () => {
    const { onJump } = renderIndex();
    const nav = screen.getByRole("navigation", { name: "Project index" });
    const buttons = within(nav).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["atlas-api", "atlas-web", "harbor"]);
    for (const button of buttons) {
      expect(button).toHaveAttribute("aria-controls", "lanes");
    }
    fireEvent.click(buttons[2]!);
    expect(onJump).toHaveBeenCalledWith("dir:harbor");
  });

  it("tints only the selection's project, and marks running and unread projects", () => {
    renderIndex();
    expect(screen.getByRole("button", { name: "Jump to atlas-web, turn running" })).toHaveClass("is-selected");
    expect(screen.getByRole("button", { name: "Jump to harbor, unread" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to atlas-api" })).not.toHaveClass("is-selected");
  });

  it("is one Tab stop, walked with the arrows, Home/End, and typeahead", () => {
    renderIndex();
    const [api, web, harbor] = within(
      screen.getByRole("navigation", { name: "Project index" }),
    ).getAllByRole("button");
    // With no scroll position to follow, the stop is the selection's project.
    expect(web).toHaveAttribute("tabindex", "0");
    expect(api).toHaveAttribute("tabindex", "-1");
    act(() => web!.focus());
    fireEvent.keyDown(web!, { key: "ArrowDown" });
    expect(harbor).toHaveFocus();
    fireEvent.keyDown(harbor!, { key: "Home" });
    expect(api).toHaveFocus();
    fireEvent.keyDown(api!, { key: "End" });
    expect(harbor).toHaveFocus();
    fireEvent.keyDown(harbor!, { key: "a" });
    expect(api).toHaveFocus();
    expect(api).toHaveAttribute("tabindex", "0");
  });

  it("draws a dragged width and returns to the natural width on double-click", () => {
    const { onWidthChange } = renderIndex({ width: 120 });
    expect(screen.getByRole("navigation", { name: "Project index" })).toHaveStyle({ width: "120px" });
    const grip = screen.getByRole("separator", { name: "Resize project index" });
    fireEvent.doubleClick(grip);
    expect(onWidthChange).toHaveBeenCalledWith(null);
  });

  it("saves nothing for a double-click at the natural width", () => {
    const { onWidthChange } = renderIndex();
    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize project index" }));
    expect(onWidthChange).not.toHaveBeenCalled();
  });

  it("saves a drag once, on release, and never for a press that did not move", () => {
    const { onWidthChange } = renderIndex();
    const grip = screen.getByRole("separator", { name: "Resize project index" });
    fireEvent.pointerDown(grip, { button: 0, clientX: 100 });
    fireEvent.pointerUp(window);
    expect(onWidthChange).not.toHaveBeenCalled();

    fireEvent.pointerDown(grip, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 130 });
    fireEvent.pointerMove(window, { clientX: 150 });
    expect(onWidthChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(onWidthChange).toHaveBeenCalledTimes(1);
  });

  it("steps the width with the arrow keys and saves once, on release", () => {
    const { onWidthChange } = renderIndex({ width: 120 });
    const grip = screen.getByRole("separator", { name: "Resize project index" });
    // A held key repeats; each repeat moves the column, none saves.
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    fireEvent.keyDown(grip, { key: "ArrowRight", repeat: true });
    fireEvent.keyDown(grip, { key: "ArrowRight", repeat: true });
    expect(onWidthChange).not.toHaveBeenCalled();
    fireEvent.keyUp(grip, { key: "ArrowRight" });
    expect(onWidthChange).toHaveBeenCalledTimes(1);
    // Focus leaving mid-run saves too.
    fireEvent.keyDown(grip, { key: "ArrowLeft" });
    fireEvent.blur(grip);
    expect(onWidthChange).toHaveBeenCalledTimes(2);
  });
});

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
    },
  } as BackendSummary,
];

function thread(id: string, label: string): NavigationThreadSummary {
  return {
    id,
    title: `Thread in ${label}`,
    titleSource: "explicit",
    source: "codex",
    executionMode: "default",
    updatedAt: 1_700_000_000_000,
    inbox: { inInbox: true, reason: "new-thread" },
    linkedDirectories: [
      { id: `dir-${label}`, label, path: `/fixture/${label}`, kind: "local" },
    ],
  } as NavigationThreadSummary;
}

function directory(label: string, threadId: string): NavigationDirectorySummary {
  return {
    key: `directory:/fixture/${label}`,
    kind: "directory",
    label,
    path: `/fixture/${label}`,
    threadKeys: [`codex:${threadId}`],
  } as NavigationDirectorySummary;
}

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const threads = [thread("t-quill", "quill"), thread("t-relay", "relay")];
  const onBrowseModeChange = vi.fn();
  const onProjectIndexHiddenChange = vi.fn();
  const view = render(
    <Sidebar
      backends={backends}
      browseMode="inbox"
      directories={[directory("quill", "t-quill"), directory("relay", "t-relay")]}
      inboxThreads={threads}
      loading={false}
      creatingThread={undefined}
      threads={threads}
      onBrowseModeChange={onBrowseModeChange}
      onCreateThread={async () => undefined}
      onOpenLaunchpad={async () => undefined}
      onSelectThread={() => undefined}
      projectIndexHidden={false}
      onProjectIndexHiddenChange={onProjectIndexHiddenChange}
      projectIndexWidth={null}
      onProjectIndexWidthChange={() => undefined}
      {...overrides}
    />,
  );
  return { ...view, onBrowseModeChange, onProjectIndexHiddenChange };
}

describe("Sidebar project index", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays out of a sidebar whose owner offers no preference", () => {
    renderSidebar({
      onProjectIndexHiddenChange: undefined,
      onProjectIndexWidthChange: undefined,
    });
    expect(screen.queryByRole("navigation", { name: "Project index" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /project index/ })).not.toBeInTheDocument();
  });

  it("opens Directories from a flat lens without changing the selection", () => {
    const onSelectThread = vi.fn();
    const { onBrowseModeChange } = renderSidebar({ onSelectThread });
    const nav = screen.getByRole("navigation", { name: "Project index" });
    fireEvent.click(within(nav).getByRole("button", { name: /^Jump to relay/ }));
    expect(onBrowseModeChange).toHaveBeenCalledWith("directories");
    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it("lands a jump to the last project at the top, growing a tail that scrolls away", async () => {
    renderSidebar({ browseMode: "directories" });
    const list = document.querySelector<HTMLElement>(".directory-list")!;
    const tail = list.querySelector<HTMLElement>(".directory-list__jump-tail")!;
    const relay = list.querySelector<HTMLElement>('section.directory-row[data-directory-key="directory:/fixture/relay"]')!;
    // jsdom has no layout: a 500px list that can scroll to 1500, with relay
    // starting 1700px down, where the list cannot reach.
    let scrollTop = 0;
    Object.defineProperty(list, "scrollTop", { get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
    Object.defineProperty(list, "scrollHeight", { get: () => 2000 + (parseFloat(tail.style.height) || 0) });
    Object.defineProperty(list, "clientHeight", { get: () => 500 });
    Object.defineProperty(tail, "offsetHeight", { get: () => parseFloat(tail.style.height) || 0 });
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) });
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(() => rect(0, 500));
    vi.spyOn(relay, "getBoundingClientRect").mockImplementation(() => rect(1700 - scrollTop, 300));
    vi.spyOn(tail, "getBoundingClientRect").mockImplementation(() => rect(2000 - scrollTop, parseFloat(tail.style.height) || 0));

    fireEvent.click(within(screen.getByRole("navigation", { name: "Project index" })).getByRole("button", { name: /^Jump to relay/ }));
    await act(async () => {
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });
    expect(scrollTop).toBe(1700);
    expect(tail.style.height).toBe("200px");

    // Scrolling back up until the tail is off screen drops it.
    scrollTop = 1600;
    fireEvent.scroll(list);
    expect(tail.style.height).toBe("200px");
    scrollTop = 1400;
    fireEvent.scroll(list);
    expect(tail.style.height).toBe("");
  });

  it("hides and shows from the toggle beside the lens switch", () => {
    const { onProjectIndexHiddenChange, rerender } = renderSidebar();
    const toggle = screen.getByRole("button", { name: "Project index" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(onProjectIndexHiddenChange).toHaveBeenCalledWith(true);

    const threads = [thread("t-quill", "quill"), thread("t-relay", "relay")];
    rerender(
      <Sidebar
        backends={backends}
        browseMode="inbox"
        directories={[directory("quill", "t-quill"), directory("relay", "t-relay")]}
        inboxThreads={threads}
        loading={false}
        creatingThread={undefined}
        threads={threads}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        projectIndexHidden
        onProjectIndexHiddenChange={onProjectIndexHiddenChange}
        projectIndexWidth={null}
        onProjectIndexWidthChange={() => undefined}
      />,
    );
    expect(screen.queryByRole("navigation", { name: "Project index" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project index" })).toHaveAttribute("aria-pressed", "false");
  });

  it("says why the index is missing when the sidebar is too narrow for it", () => {
    renderSidebar();
    // The container query hides the column below a 356px sidebar; jsdom has
    // no container queries, so hide it the way that rule does.
    const pane = screen.getByRole("navigation", { name: "Project index" }).parentElement!;
    pane.style.display = "none";
    fireEvent.focus(screen.getByRole("button", { name: "Project index" }));
    expect(screen.getByText("Hide project index · Widen the sidebar to show it")).toBeInTheDocument();
  });

  it("steps aside for a single project, keeping the toggle", () => {
    const threads = [thread("t-quill", "quill")];
    renderSidebar({
      directories: [directory("quill", "t-quill")],
      inboxThreads: threads,
      threads,
    });
    expect(screen.queryByRole("navigation", { name: "Project index" })).not.toBeInTheDocument();
    fireEvent.focus(screen.getByRole("button", { name: "Project index" }));
    expect(screen.getByText("Hide project index · Shown with two or more projects")).toBeInTheDocument();
  });
});

describe("Project index Forge Automation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks a project whose forge activity is paused, in its name too", () => {
    renderIndex({
      projects: entries.map((entry) => entry.key === "dir:harbor"
        ? { ...entry, forgeActivityPaused: true } : entry),
    });
    const harbor = screen.getByRole("button", { name: "Jump to harbor, unread, forge activity paused" });
    const glyph = harbor.querySelector(".project-index__paused");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(glyph).toHaveAttribute("data-tooltip", "Forge activity paused");
    expect(screen.getByRole("button", { name: "Jump to atlas-api" }).querySelector(".project-index__paused")).toBeNull();
  });

  it("asks for the project's menu on a right-click, at the pointer", () => {
    const onOpenContextMenu = vi.fn();
    renderIndex({ onOpenContextMenu });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Jump to harbor, unread" }), {
      clientX: 40,
      clientY: 120,
    });
    expect(onOpenContextMenu).toHaveBeenCalledWith("dir:harbor", expect.objectContaining({ x: 40, y: 120 }));
  });

  it("opens the project header's menu, Forge Automation included, from the index", async () => {
    const onSetProjectForgeAutomation = vi.fn(async () => undefined);
    renderSidebar({ onSetProjectForgeAutomation });
    const nav = screen.getByRole("navigation", { name: "Project index" });
    fireEvent.contextMenu(within(nav).getByRole("button", { name: /^Jump to relay/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Pause Forge Activity" }))
      .toHaveAttribute("aria-checked", "false");
    expect(within(menu).getByRole("menuitem", { name: "Forge Automation…" })).toBeInTheDocument();
  });

  it("draws the pause glyph for a paused project", () => {
    const paused = {
      ...directory("relay", "t-relay"),
      forgeAutomation: { ...DEFAULT_PROJECT_FORGE_AUTOMATION, paused: true, pausedAt: 1_000 },
    };
    renderSidebar({ directories: [directory("quill", "t-quill"), paused] });
    const nav = screen.getByRole("navigation", { name: "Project index" });
    expect(within(nav).getByRole("button", { name: /^Jump to relay.*, forge activity paused$/ })).toBeInTheDocument();
  });
});

describe("project index reorder rules", () => {
  // Three pins, the 9px hairline, then the rest in name order.
  const items = [
    { key: "meridian", top: 0, bottom: 20, pinned: true },
    { key: "quill", top: 20, bottom: 40, pinned: true },
    { key: "lighthouse", top: 40, bottom: 60, pinned: true },
    { key: "harbor", top: 69, bottom: 89, pinned: false },
    { key: "tern", top: 89, bottom: 109, pinned: false },
  ];
  const seam = { top: 60, bottom: 69 };
  const pin = { key: "lighthouse", pinned: true };
  const loose = { key: "harbor", pinned: false };

  it("puts the line on the nearer edge of the pin under the pointer", () => {
    expect(resolveProjectIndexDrop({ y: 24, source: pin, items, seam })).toEqual({
      kind: "line",
      anchorKey: "quill",
      position: "before",
      drop: { kind: "move", anchorKey: "quill", placement: "before" },
    });
  });

  it("offers no move on a held pin's own edges", () => {
    expect(resolveProjectIndexDrop({ y: 35, source: pin, items, seam })).toBeUndefined();
    expect(resolveProjectIndexDrop({ y: 58, source: pin, items, seam })).toBeUndefined();
  });

  it("unpins a held pin anywhere at or below the hairline", () => {
    for (const y of [62, 100]) {
      expect(resolveProjectIndexDrop({ y, source: pin, items, seam })).toEqual({
        kind: "seam", drop: { kind: "unpin" }, label: "Unpin",
      });
    }
  });

  it("pins an unpinned name dropped among the pins, or over the hairline at the end", () => {
    expect(resolveProjectIndexDrop({ y: 5, source: loose, items, seam })).toEqual({
      kind: "line",
      anchorKey: "meridian",
      position: "before",
      drop: { kind: "move", anchorKey: "meridian", placement: "before" },
      label: "Pin",
    });
    expect(resolveProjectIndexDrop({ y: 64, source: loose, items, seam })).toEqual({
      kind: "line",
      anchorKey: "lighthouse",
      position: "after",
      drop: { kind: "move", anchorKey: "lighthouse", placement: "after" },
      label: "Pin",
    });
  });

  it("has nothing for an unpinned name held among the unpinned, which keep name order", () => {
    expect(resolveProjectIndexDrop({ y: 95, source: { key: "tern", pinned: false }, items, seam })).toBeUndefined();
  });

  it("pins only inside the ghost slot's own box while nothing is pinned", () => {
    const unpinned = items.map((item) => ({ ...item, pinned: false }));
    const pinSlot = { top: 0, bottom: 26 };
    expect(resolveProjectIndexDrop({ y: 12, source: loose, items: unpinned, pinSlot })).toEqual({
      kind: "slot", drop: { kind: "pin" }, label: "Pin",
    });
    expect(resolveProjectIndexDrop({ y: 40, source: loose, items: unpinned, pinSlot })).toBeUndefined();
    expect(resolveProjectIndexDrop({ y: 40, source: loose, items: unpinned })).toBeUndefined();
  });
});

describe("ProjectIndex drag", () => {
  const POINTER = 7;
  const reorderEntries: ProjectIndexEntry[] = [
    { key: "dir:meridian", label: "meridian", containsSelection: false, active: false, review: false, pinned: true, movable: true },
    { key: "dir:quill", label: "quill", containsSelection: false, active: false, review: false, pinned: true, movable: true },
    { key: "dir:harbor", label: "harbor", containsSelection: false, active: false, review: false, movable: true },
    { key: "dir:tern", label: "tern", containsSelection: false, active: false, review: false, movable: true },
  ];

  function rect(element: Element, top: number, height: number): void {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}),
    });
  }

  /** jsdom has no layout: 20px names, the 9px hairline after the pins. */
  function layout(): void {
    rect(screen.getByRole("navigation", { name: "Project index" }), 0, 400);
    let top = 0;
    for (const row of document.querySelectorAll(".project-index__list > li")) {
      const height = row.classList.contains("project-index__seam") ? 9 : 20;
      rect(row, top, height);
      top += height;
    }
  }

  function renderDraggable(projects: ProjectIndexEntry[] = reorderEntries) {
    const onDropProject = vi.fn();
    const onMoveProject = vi.fn();
    const onJump = vi.fn();
    const ui = (list: ProjectIndexEntry[]): ReactElement => (
      <ProjectIndex
        projects={list}
        scrollRegionRef={createRef()}
        scrollRegionId="lanes"
        spy={false}
        width={null}
        onJump={onJump}
        onWidthChange={() => undefined}
        onDropProject={onDropProject}
        onMoveProject={onMoveProject}
      />
    );
    render(ui(projects));
    layout();
    return { onDropProject, onMoveProject, onJump };
  }

  function name(label: string): HTMLElement {
    return screen.getByRole("button", { name: `Jump to ${label}` });
  }
  const press = (element: Element, y: number) =>
    fireEvent.pointerDown(element, { button: 0, clientX: 20, clientY: y, pointerId: POINTER });
  const move = (y: number) =>
    fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: y, pointerId: POINTER });
  const release = (y: number) =>
    fireEvent.pointerUp(window, { button: 0, clientX: 20, clientY: y, pointerId: POINTER });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws a hairline after the last pin", () => {
    renderDraggable();
    const seam = document.querySelector(".project-index__seam");
    expect(seam).toHaveAttribute("aria-hidden", "true");
    expect(seam?.previousElementSibling).toContainElement(name("quill"));
    expect(seam?.nextElementSibling).toContainElement(name("harbor"));
  });

  it("draws no hairline when nothing is pinned", () => {
    renderDraggable(reorderEntries.map((entry) => ({ ...entry, pinned: false })));
    expect(document.querySelector(".project-index__seam")).toBeNull();
  });

  it("moves a held pin to the line, then outlines it once", async () => {
    const { onDropProject, onJump } = renderDraggable();
    press(name("quill"), 30);
    move(20);
    expect(document.querySelector(".project-index__drag-image")).toHaveTextContent("quill");
    expect(name("quill").closest("li")).toHaveClass("is-pointer-dragging");
    move(5);
    await waitFor(() => expect(name("meridian").closest("li")).toHaveClass("is-drop-target-before"));
    await act(async () => {
      release(5);
    });
    expect(onDropProject).toHaveBeenCalledWith("dir:quill", {
      kind: "move", anchorKey: "dir:meridian", placement: "before",
    });
    expect(document.querySelector(".project-index__drag-image")).toBeNull();
    expect(name("quill")).toHaveClass("is-revealed");
    // The release's click is swallowed, so a drop never jumps the list.
    fireEvent.click(name("quill"));
    expect(onJump).not.toHaveBeenCalled();
  });

  it("unpins a held pin over the hairline, and says so on the card", async () => {
    const { onDropProject } = renderDraggable();
    const seam = document.querySelector(".project-index__seam")!;
    press(name("quill"), 30);
    move(45);
    await waitFor(() => expect(seam).toHaveClass("is-drop-target"));
    expect(document.querySelector(".thread-row__drop-label")).toHaveTextContent("Unpin");
    await act(async () => {
      release(45);
    });
    expect(onDropProject).toHaveBeenCalledWith("dir:quill", { kind: "unpin" });
  });

  it("opens a ghost Pin slot while nothing is pinned, and pins only inside it", async () => {
    const { onDropProject } = renderDraggable(reorderEntries.map((entry) => ({ ...entry, pinned: false })));
    expect(document.querySelector(".project-index__pin-slot")).toBeNull();
    press(name("tern"), 70);
    move(60);
    const slot = document.querySelector(".project-index__pin-slot")!;
    expect(slot).toHaveTextContent("Pin");
    rect(slot, 0, 26);
    move(50);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(slot).not.toHaveClass("is-drop-target");
    move(10);
    await waitFor(() => expect(slot).toHaveClass("is-drop-target"));
    expect(document.querySelector(".thread-row__drop-label")).toHaveTextContent("Pin");
    await act(async () => {
      release(10);
    });
    expect(onDropProject).toHaveBeenCalledWith("dir:tern", { kind: "pin" });
    expect(document.querySelector(".project-index__pin-slot")).toBeNull();
  });

  it("puts the card back on Escape, with no drop", () => {
    const { onDropProject } = renderDraggable();
    press(name("quill"), 30);
    move(5);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".project-index__drag-image")).toBeNull();
    release(5);
    expect(onDropProject).not.toHaveBeenCalled();
  });

  it("still jumps on a press that does not move", () => {
    const { onJump, onDropProject } = renderDraggable();
    press(name("harbor"), 50);
    release(50);
    fireEvent.click(name("harbor"));
    expect(onJump).toHaveBeenCalledWith("dir:harbor");
    expect(onDropProject).not.toHaveBeenCalled();
  });

  it("moves a focused pin with ⌘⇧↑/↓ and leaves the rest to the arrows", () => {
    const { onMoveProject } = renderDraggable();
    fireEvent.keyDown(name("quill"), { key: "ArrowUp", metaKey: true, shiftKey: true });
    expect(onMoveProject).toHaveBeenCalledWith("dir:quill", "up");
    fireEvent.keyDown(name("harbor"), { key: "ArrowUp", metaKey: true, shiftKey: true });
    expect(onMoveProject).toHaveBeenCalledTimes(1);
  });

  it("offers no drag without an owner that can reorder", () => {
    render(
      <ProjectIndex
        projects={reorderEntries}
        scrollRegionRef={createRef()}
        scrollRegionId="lanes"
        spy={false}
        width={null}
        onJump={() => undefined}
        onWidthChange={() => undefined}
      />,
    );
    press(name("quill"), 30);
    move(5);
    expect(document.querySelector(".project-index__drag-image")).toBeNull();
    release(5);
  });
});

describe("Sidebar project index reorder", () => {
  it("applies an index drop to the pinned-directory order, as a folder drop does", async () => {
    const onReorderDirectoryPins = vi.fn(async () => undefined);
    const onSetDirectoryPin = vi.fn(async () => undefined);
    renderSidebar({
      directories: [
        { ...directory("quill", "t-quill"), pinnedRank: "1024" },
        { ...directory("relay", "t-relay"), pinnedRank: "2048" },
      ],
      onReorderDirectoryPins,
      onSetDirectoryPin,
    });
    const nav = screen.getByRole("navigation", { name: "Project index" });
    const relay = within(nav).getByRole("button", { name: /^Jump to relay/ });
    const quill = within(nav).getByRole("button", { name: /^Jump to quill/ });
    vi.spyOn(nav, "getBoundingClientRect").mockReturnValue({
      top: 0, bottom: 400, height: 400, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    for (const [button, top] of [[quill, 0], [relay, 20]] as const) {
      vi.spyOn(button.closest("li")!, "getBoundingClientRect").mockReturnValue({
        top, bottom: top + 20, height: 20, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}),
      });
    }
    fireEvent.pointerDown(relay, { button: 0, clientX: 20, clientY: 30, pointerId: 3 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 20, pointerId: 3 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 4, pointerId: 3 });
    await waitFor(() => expect(quill.closest("li")).toHaveClass("is-drop-target-before"));
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0, clientX: 20, clientY: 4, pointerId: 3 });
    });
    expect(onReorderDirectoryPins).toHaveBeenCalledWith(
      ["directory:/fixture/relay", "directory:/fixture/quill"],
      { key: "directory:/fixture/relay", anchorKey: "directory:/fixture/quill", placement: "before" },
    );
    expect(onSetDirectoryPin).not.toHaveBeenCalled();
  });
});
