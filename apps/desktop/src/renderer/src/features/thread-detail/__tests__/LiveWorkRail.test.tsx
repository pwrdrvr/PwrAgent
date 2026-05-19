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

  it("treats an editedFilesEntry as absent when none of its details carry a fileDiff", () => {
    // Defensive: a malformed entry with summary "Edited 1 file" but
    // empty/non-diff details would otherwise produce a rail title
    // claiming work-was-done while the body had nothing to render
    // below it. The rail title and the section body share the same
    // gating so they can't disagree (#510 follow-up).
    const editedFilesEntryWithoutDiffs: AppServerThreadActivityEntry = {
      type: "activity",
      id: "live-diff-empty",
      summary: "Edited 1 file",
      createdAt: 1_000,
      details: [
        {
          id: "detail-non-diff",
          kind: "write",
          label: "Update mystery.ts",
          path: "/repo/mystery.ts",
        },
      ],
    };
    const { container } = render(
      <LiveWorkRail
        dock="above"
        pinned={false}
        editedFilesEntry={editedFilesEntryWithoutDiffs}
        onDockChange={() => undefined}
      />,
    );
    // No content → rail returns null entirely (just like the "no
    // entries" empty-state case).
    expect(container).toBeEmptyDOMElement();
  });

  it("uses the section summary as the rail title when not pinned", () => {
    render(
      <LiveWorkRail
        dock="above"
        pinned={false}
        editedFilesEntry={buildEditedFilesEntry()}
        onDockChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole("complementary", { name: "Edited 2 files, +5, -2" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Edited 2 files, \+5, -2/ }),
    ).toBeInTheDocument();
  });

  it("suffixes the aria label with (last turn) when pinned but keeps the same summary text in the visible title", () => {
    render(
      <LiveWorkRail
        dock="above"
        pinned={true}
        editedFilesEntry={buildEditedFilesEntry()}
        onDockChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole("complementary", {
        name: "Edited 2 files, +5, -2 (last turn)",
      }),
    ).toBeInTheDocument();
  });

  it("joins multiple section summaries in the rail title with a midline dot", () => {
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
        name: "Plan · Edited 2 files, +5, -2 · Changed 1 file",
      }),
    ).toBeInTheDocument();
  });

  it("expands a file's diff in place when its row is clicked", () => {
    render(
      <LiveWorkRail
        dock="above"
        pinned={false}
        editedFilesEntry={buildEditedFilesEntry()}
        onDockChange={() => undefined}
      />,
    );
    // Section heading is gone — the rail title carries the summary
    // (see "uses the section summary as the rail title" above).
    expect(
      screen.queryByRole("heading", { level: 3, name: /Edited 2 files/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Update AGENTS\.md/i }),
    ).toBeInTheDocument();

    // Diff body not visible until the file row is expanded.
    expect(screen.queryByText(/@@ -1,1 \+1,4 @@/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Update AGENTS\.md/i }));
    expect(screen.getByText(/Diff for AGENTS\.md|@@ -1,1 \+1,4 @@|\+a/)).toBeInTheDocument();
  });

  it("renders the Changed Files section as a static list (no diff expand, no section heading)", () => {
    render(
      <LiveWorkRail
        dock="above"
        pinned={false}
        changedFilesEntry={buildChangedFilesEntry()}
        onDockChange={() => undefined}
      />,
    );
    // Section heading was redundant with the rail title, dropped.
    expect(
      screen.queryByRole("heading", { level: 3, name: /Changed 1 file/i }),
    ).not.toBeInTheDocument();
    // The rail-level title carries the summary.
    expect(
      screen.getByRole("complementary", { name: "Changed 1 file" }),
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
    const collapseButton = screen.getByRole("button", {
      name: /Edited 2 files, \+5, -2/,
    });
    expect(collapseButton).toHaveAttribute("aria-expanded", "true");

    // The file row inside the body is the witness for collapsed-vs-not.
    expect(
      screen.getByRole("button", { name: /Update AGENTS\.md/i }),
    ).toBeVisible();

    fireEvent.click(collapseButton);
    expect(collapseButton).toHaveAttribute("aria-expanded", "false");
    // `hidden` attribute removes the body from the accessibility tree
    // and (via the [hidden] CSS rule) from layout. The file row's
    // button stays mounted (cheap to re-show) but is not visible.
    expect(
      screen.getByRole("button", { name: /Update AGENTS\.md/i, hidden: true }),
    ).not.toBeVisible();

    fireEvent.click(collapseButton);
    expect(collapseButton).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: /Update AGENTS\.md/i }),
    ).toBeVisible();
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

  it("renders all three sections together with the joined rail title and per-section bodies", () => {
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
        name: "Plan · Edited 2 files, +5, -2 · Changed 1 file",
      }),
    ).toBeInTheDocument();
    // Plan delegates to TranscriptPlan which renders its own summary.
    expect(screen.getByText("1 out of 3 tasks completed")).toBeInTheDocument();
    // The other sections drop their h3 — the rail title carries it.
    expect(
      screen.queryByRole("heading", { level: 3, name: /Edited 2 files/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 3, name: /Changed 1 file/i }),
    ).not.toBeInTheDocument();
    // But the file rows + static path lines still render in the body.
    expect(
      screen.getByRole("button", { name: /Update AGENTS\.md/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Modified Composer.tsx")).toBeInTheDocument();
  });
});
