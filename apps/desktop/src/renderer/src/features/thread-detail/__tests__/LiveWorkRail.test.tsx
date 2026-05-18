import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadPlanEntry,
} from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import { LiveWorkRail } from "../LiveWorkRail";

function buildEditedFilesEntry(): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: "live-diff-turn-1",
    summary: "Edited 2 files, +5, -2",
    createdAt: 1_000,
    details: [
      {
        id: "detail-1",
        kind: "write",
        label: "Update AGENTS.md",
        path: "/repo/AGENTS.md",
        fileDiff: {
          kind: "update",
          additions: 3,
          removals: 0,
          diff:
            "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,1 +1,4 @@\n line\n+a\n+b\n+c\n",
        },
      },
      {
        id: "detail-2",
        kind: "write",
        label: "Update README.md",
        path: "/repo/README.md",
        fileDiff: {
          kind: "update",
          additions: 2,
          removals: 2,
          diff: "--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,2 @@\n-x\n-y\n+a\n+b\n",
        },
      },
    ],
  };
}

function buildChangedFilesEntry(): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: "live-file-change-call-1",
    summary: "Changed 1 file",
    createdAt: 1_000,
    details: [
      {
        id: "live-file-change-call-1-1",
        kind: "write",
        label: "Modified Composer.tsx",
        path: "apps/desktop/src/renderer/src/features/composer/Composer.tsx",
      },
    ],
  };
}

function buildPlanEntry(): AppServerThreadPlanEntry {
  return {
    type: "plan",
    id: "live-plan-turn-1",
    createdAt: 1_000,
    markdown: "",
    steps: [
      { step: "Investigate the bug", status: "completed" },
      { step: "Apply the fix", status: "in_progress" },
      { step: "Add a regression test", status: "pending" },
    ],
  };
}

describe("LiveWorkRail", () => {
  it("renders nothing when there's no live or pinned content", () => {
    const { container } = render(
      <LiveWorkRail dock="above" pinned={false} onDockChange={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("titles the rail with the present section names when not pinned", () => {
    render(
      <LiveWorkRail
        dock="above"
        pinned={false}
        editedFilesEntry={buildEditedFilesEntry()}
        onDockChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole("complementary", { name: "Edited Files" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Edited Files/i }),
    ).toBeInTheDocument();
  });

  it("suffixes the aria label with (last turn) when pinned but keeps the section name in the visible title", () => {
    render(
      <LiveWorkRail
        dock="above"
        pinned={true}
        editedFilesEntry={buildEditedFilesEntry()}
        onDockChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole("complementary", { name: "Edited Files (last turn)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Edited Files/i }),
    ).toBeInTheDocument();
  });

  it("joins multiple present section names with commas", () => {
    render(
      <LiveWorkRail
        dock="above"
        pinned={false}
        planEntry={buildPlanEntry()}
        editedFilesEntry={buildEditedFilesEntry()}
        changedFilesEntry={buildChangedFilesEntry()}
        onDockChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole("complementary", {
        name: "Plan, Edited Files, Changed Files",
      }),
    ).toBeInTheDocument();
  });

  it("renders the edited-files summary as a section heading and expands a file diff in place", () => {
    render(
      <LiveWorkRail
        dock="above"
        pinned={false}
        editedFilesEntry={buildEditedFilesEntry()}
        onDockChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 3, name: /Edited 2 files, \+5, -2/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Update AGENTS\.md/i }),
    ).toBeInTheDocument();

    // Diff body not visible until the file row is expanded.
    expect(screen.queryByText(/@@ -1,1 \+1,4 @@/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Update AGENTS\.md/i }));
    expect(screen.getByText(/Diff for AGENTS\.md|@@ -1,1 \+1,4 @@|\+a/)).toBeInTheDocument();
  });

  it("renders the Changed Files section as a static list (no diff expand)", () => {
    render(
      <LiveWorkRail
        dock="above"
        pinned={false}
        changedFilesEntry={buildChangedFilesEntry()}
        onDockChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 3, name: /Changed 1 file/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Modified Composer.tsx")).toBeInTheDocument();
    // No expand button for the row — protocol fileChange notifications
    // don't carry diffs.
    expect(
      screen.queryByRole("button", { name: /Modified Composer\.tsx/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the plan section by delegating to TranscriptPlan", () => {
    render(
      <LiveWorkRail
        dock="above"
        pinned={false}
        planEntry={buildPlanEntry()}
        onDockChange={() => undefined}
      />,
    );
    expect(screen.getByText("1 out of 3 tasks completed")).toBeInTheDocument();
  });

  it("toggles the whole rail collapsed and expanded from the title button", () => {
    render(
      <LiveWorkRail
        dock="above"
        pinned={false}
        editedFilesEntry={buildEditedFilesEntry()}
        onDockChange={() => undefined}
      />,
    );
    const collapseButton = screen.getByRole("button", { name: /Edited Files/i });
    expect(
      screen.getByRole("heading", { level: 3, name: /Edited 2 files/i }),
    ).toBeInTheDocument();

    fireEvent.click(collapseButton);
    expect(
      screen.queryByRole("heading", { level: 3, name: /Edited 2 files/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(collapseButton);
    expect(
      screen.getByRole("heading", { level: 3, name: /Edited 2 files/i }),
    ).toBeInTheDocument();
  });

  it("flips the dock via the dock-toggle button", () => {
    const onDockChange = vi.fn();
    render(
      <LiveWorkRail
        dock="above"
        pinned={false}
        editedFilesEntry={buildEditedFilesEntry()}
        onDockChange={onDockChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dock to sidebar" }));
    expect(onDockChange).toHaveBeenCalledWith("sidebar");
  });

  it("offers the reverse dock label when already in sidebar mode", () => {
    const onDockChange = vi.fn();
    render(
      <LiveWorkRail
        dock="sidebar"
        pinned={false}
        editedFilesEntry={buildEditedFilesEntry()}
        onDockChange={onDockChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dock above composer" }));
    expect(onDockChange).toHaveBeenCalledWith("above");
  });

  it("renders all three sections together with the right headings", () => {
    render(
      <LiveWorkRail
        dock="above"
        pinned={false}
        planEntry={buildPlanEntry()}
        editedFilesEntry={buildEditedFilesEntry()}
        changedFilesEntry={buildChangedFilesEntry()}
        onDockChange={() => undefined}
      />,
    );
    expect(screen.getByText("1 out of 3 tasks completed")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 3, name: /Edited 2 files, \+5, -2/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 3, name: /Changed 1 file/i }),
    ).toBeInTheDocument();
  });
});
