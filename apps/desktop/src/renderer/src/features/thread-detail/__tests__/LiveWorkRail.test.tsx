import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadPlanEntry,
} from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import { LiveWorkRail } from "../LiveWorkRail";
import { collectEditedFileGroups } from "../edited-file-groups";

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

function buildEditedFileGroups() {
  return collectEditedFileGroups({
    entries: [buildEditedFilesEntry()],
  });
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
    const { container } = render(<LiveWorkRail pinned={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when an entry's details carry no fileDiff (accumulator filters it)", () => {
    // Defensive: a malformed entry with summary "Edited 1 file" but
    // empty/non-diff details would otherwise produce a rail title
    // claiming work-was-done while the body had nothing to render
    // below it. The gating lives in collectEditedFileGroups so the
    // rail title and body can't disagree (#510 follow-up).
    const groups = collectEditedFileGroups({
      entries: [
        {
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
        },
      ],
    });
    expect(groups).toHaveLength(0);
    const { container } = render(
      <LiveWorkRail pinned={false} editedFileGroups={groups} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("uses the section summary as the rail title when not pinned", () => {
    render(
      <LiveWorkRail pinned={false} editedFileGroups={buildEditedFileGroups()} />,
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
      <LiveWorkRail pinned={true} editedFileGroups={buildEditedFileGroups()} />,
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
        pinned={false}
        planEntry={buildPlanEntry()}
        editedFileGroups={buildEditedFileGroups()}
        changedFilesEntry={buildChangedFilesEntry()}
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
      <LiveWorkRail pinned={false} editedFileGroups={buildEditedFileGroups()} />,
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
      <LiveWorkRail pinned={false} changedFilesEntry={buildChangedFilesEntry()} />,
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
    render(<LiveWorkRail pinned={false} planEntry={buildPlanEntry()} />);
    expect(screen.getByText("1 out of 3 tasks completed")).toBeInTheDocument();
  });

  it("toggles the whole rail collapsed and expanded from the title button", () => {
    render(
      <LiveWorkRail pinned={false} editedFileGroups={buildEditedFileGroups()} />,
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

  it("moves edited files to the sidebar Edits panel via the header button", () => {
    const onMove = vi.fn();
    render(
      <LiveWorkRail
        pinned={false}
        editedFileGroups={buildEditedFileGroups()}
        onMoveEditedFilesToSidebar={onMove}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Move edited files to the sidebar Edits panel",
      }),
    );
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("hides the sidebar button when no move handler is provided (edits docked to sidebar)", () => {
    render(
      <LiveWorkRail pinned={false} changedFilesEntry={buildChangedFilesEntry()} />,
    );
    expect(
      screen.queryByRole("button", {
        name: "Move edited files to the sidebar Edits panel",
      }),
    ).not.toBeInTheDocument();
  });

  it("renders all three sections together with the joined rail title and per-section bodies", () => {
    render(
      <LiveWorkRail
        pinned={false}
        planEntry={buildPlanEntry()}
        editedFileGroups={buildEditedFileGroups()}
        changedFilesEntry={buildChangedFilesEntry()}
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
