import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary, NavigationThreadSummary } from "@pwragent/shared";
import type { NavigationDirectoryView as NavigationDirectorySummary } from "../../../lib/navigation-loaded-rows";
import { FixtureSidebar as Sidebar } from "../../../test/navigation-presentation-fixture";
import { ProjectIndex, type ProjectIndexEntry } from "../ProjectIndex";
import {
  clampProjectIndexWidth,
  projectTypeaheadIndex,
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
    expect(screen.getByRole("button", { name: "atlas-web, turn running" })).toHaveClass("is-selected");
    expect(screen.getByRole("button", { name: "harbor, unread" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "atlas-api" })).not.toHaveClass("is-selected");
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

  it("steps the width with the arrow keys", () => {
    const { onWidthChange } = renderIndex();
    const grip = screen.getByRole("separator", { name: "Resize project index" });
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    fireEvent.keyDown(grip, { key: "ArrowLeft" });
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
    fireEvent.click(within(nav).getByRole("button", { name: /^relay/ }));
    expect(onBrowseModeChange).toHaveBeenCalledWith("directories");
    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it("hides and shows from the toggle beside the lens switch", () => {
    const { onProjectIndexHiddenChange, rerender } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Hide project index" }));
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
    expect(screen.getByRole("button", { name: "Show project index" })).toHaveAttribute("aria-pressed", "false");
  });

  it("steps aside for a single project, keeping the toggle", () => {
    const threads = [thread("t-quill", "quill")];
    renderSidebar({
      directories: [directory("quill", "t-quill")],
      inboxThreads: threads,
      threads,
    });
    expect(screen.queryByRole("navigation", { name: "Project index" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide project index" })).toBeInTheDocument();
  });
});
