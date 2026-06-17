import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  EditedFileGroupList,
  EditedFileViewToggle,
  type EditedFileGroupView,
} from "../EditedFileGroupList";
import type { EditedFileGroup } from "../edited-file-groups";

afterEach(cleanup);

function group(n: number): EditedFileGroup {
  return {
    key: `turn-${n}`,
    turn: { id: `turn-${n}` },
    details: [
      {
        id: `detail-${n}`,
        kind: "write",
        label: `file-${n}.ts`,
        path: `src/file-${n}.ts`,
        fileDiff: { kind: "update", diff: "", additions: 1, removals: 0 },
      },
    ],
    summary: `Edited turn ${n}`,
    additions: 1,
    removals: 0,
    live: false,
  };
}

// Newest-first, as collectEditedFileGroups returns them.
function groups(count: number): EditedFileGroup[] {
  return Array.from({ length: count }, (_, index) => group(count - index));
}

describe("EditedFileGroupList Show more / Show less", () => {
  it("shows the first 3 turn-groups and collapses the rest behind a toggle", () => {
    render(<EditedFileGroupList groups={groups(5)} />);

    // Newest three visible, oldest two hidden.
    expect(screen.getByText("Edited turn 5")).toBeInTheDocument();
    expect(screen.getByText("Edited turn 4")).toBeInTheDocument();
    expect(screen.getByText("Edited turn 3")).toBeInTheDocument();
    expect(screen.queryByText("Edited turn 2")).not.toBeInTheDocument();
    expect(screen.queryByText("Edited turn 1")).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "Show 2 more" });

    fireEvent.click(toggle);
    expect(screen.getByText("Edited turn 2")).toBeInTheDocument();
    expect(screen.getByText("Edited turn 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByText("Edited turn 2")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show 2 more" })).toBeInTheDocument();
  });

  it("does not render the toggle when there are 3 or fewer groups", () => {
    render(<EditedFileGroupList groups={groups(3)} />);

    expect(screen.getByText("Edited turn 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });

  it("shows aggregate added and removed totals above the All files list", () => {
    const first = group(1);
    const second = group(2);
    const flatGroups: EditedFileGroup[] = [
      {
        ...second,
        details: [
          {
            ...second.details[0],
            fileDiff: {
              kind: "update",
              diff: "",
              additions: 2,
              removals: 1,
            },
          },
        ],
        additions: 2,
        removals: 1,
      },
      {
        ...first,
        details: [
          {
            ...first.details[0],
            fileDiff: {
              kind: "update",
              diff: "",
              additions: 3,
              removals: 3,
            },
          },
        ],
        additions: 3,
        removals: 3,
      },
    ];

    render(<EditedFileGroupList groups={flatGroups} view="files" />);

    expect(screen.getByText("Edited 2 files")).toBeInTheDocument();
    expect(screen.getByLabelText("+5 -4")).toBeInTheDocument();
  });

  it("renders the git commit badge per group from the resolved states", () => {
    render(
      <EditedFileGroupList
        groups={groups(2)}
        commitStatesByKey={{
          "turn-2": { committed: false },
          "turn-1": {
            committed: true,
            commitSha: "a".repeat(40),
            shortSha: "aaaaaaa",
            pushed: true,
          },
        }}
      />,
    );

    expect(screen.getByText("Uncommitted")).toBeInTheDocument();
    expect(screen.getByText("aaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("Pushed")).toBeInTheDocument();
    // Pushed implies committed, so "Pushed" replaces "Committed" — never both.
    expect(screen.queryByText("Committed")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Copy commit ${"a".repeat(40)}` }),
    ).toBeInTheDocument();
  });

  it("shows a plain Committed badge for an unpushed commit", () => {
    render(
      <EditedFileGroupList
        groups={groups(2)}
        commitStatesByKey={{
          "turn-1": {
            committed: true,
            commitSha: "f".repeat(40),
            shortSha: "fffffff",
            pushed: false,
          },
        }}
      />,
    );

    expect(screen.getByText("Committed")).toBeInTheDocument();
    // No "Pushed" for a local-only commit, and no separate "Local" pill.
    expect(screen.queryByText("Pushed")).not.toBeInTheDocument();
    expect(screen.queryByText("Local")).not.toBeInTheDocument();
    // turn-2 has no resolved state yet → no badge (avoids a wrong flash).
    expect(screen.queryByText("Uncommitted")).not.toBeInTheDocument();
  });

  it("does not show the turn-overflow toggle in the All files view", () => {
    // View is now controlled by the parent; the flattened "files" view has no
    // per-turn grouping, so no Show more / Show less affordance.
    render(<EditedFileGroupList groups={groups(5)} view="files" />);

    expect(screen.queryByRole("button", { name: /Show \d+ more/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show less" })).not.toBeInTheDocument();
  });

  it("flags gitignored files with a per-file chip and a group count", () => {
    // turn-2 is the newest group (index 0), so it's expanded by default and
    // its file row renders.
    render(
      <EditedFileGroupList
        groups={groups(2)}
        commitStatesByKey={{
          "turn-2": {
            committed: true,
            commitSha: "a".repeat(40),
            shortSha: "aaaaaaa",
            pushed: true,
            ignoredPaths: ["src/file-2.ts"],
          },
        }}
      />,
    );

    // Group-level hint on the badge ("· 1 ignored" — the dot is CSS).
    expect(screen.getByText("1 ignored")).toBeInTheDocument();
    // Per-file chip on the ignored row.
    expect(screen.getByText("Ignored")).toBeInTheDocument();
  });

  it("makes the group timestamp scroll the transcript to its turn", () => {
    const onScrollToTurn = vi.fn();
    const timed: EditedFileGroup = {
      key: "turn-9",
      turn: { id: "turn-9", completedAt: 1_718_000_000_000 },
      details: group(9).details,
      summary: "Edited 1 file",
      additions: 1,
      removals: 0,
      live: false,
    };
    // group(8) carries no timestamp, so only the timed group renders a button.
    render(
      <EditedFileGroupList
        groups={[timed, group(8)]}
        onScrollToTurn={onScrollToTurn}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Scroll the transcript to this turn/,
      }),
    );
    // Turn id for the precise match, plus the turn-end time for the fallback.
    expect(onScrollToTurn).toHaveBeenCalledWith("turn-9", 1_718_000_000_000);
  });

  it("renders the timestamp as plain text when scrolling isn't wired", () => {
    const timed: EditedFileGroup = {
      key: "turn-9",
      turn: { id: "turn-9", completedAt: 1_718_000_000_000 },
      details: group(9).details,
      summary: "Edited 1 file",
      additions: 1,
      removals: 0,
      live: false,
    };
    render(<EditedFileGroupList groups={[timed, group(8)]} />);

    expect(
      screen.queryByRole("button", {
        name: /Scroll the transcript to this turn/,
      }),
    ).not.toBeInTheDocument();
  });
});

describe("EditedFileRow path + open affordances", () => {
  const fileGroup: EditedFileGroup = {
    key: "turn-x",
    turn: { id: "turn-x" },
    details: [
      {
        id: "detail-x",
        kind: "write",
        label: "Foo.ts",
        path: "/repo/apps/desktop/Foo.ts",
        fileDiff: {
          kind: "update",
          diff: "@@ -1 +1 @@\n+hello\n",
          additions: 1,
          removals: 0,
        },
      },
    ],
    summary: "Edited 1 file",
    additions: 1,
    removals: 0,
    live: false,
  };

  it("shows the repo-relative path and opens the file from the expanded row", () => {
    const onOpenFile = vi.fn();
    render(
      <EditedFileGroupList
        groups={[fileGroup]}
        worktreeRoot="/repo"
        onOpenFile={onOpenFile}
      />,
    );

    // The repo-relative path only appears once the row is expanded.
    expect(screen.queryByText("apps/desktop/Foo.ts")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Foo\.ts/ }));

    expect(screen.getByText("apps/desktop/Foo.ts")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open apps/desktop/Foo.ts in editor",
      }),
    );
    expect(onOpenFile).toHaveBeenCalledWith("/repo/apps/desktop/Foo.ts");
  });

  it("omits the open affordance when no handler is provided", () => {
    render(<EditedFileGroupList groups={[fileGroup]} worktreeRoot="/repo" />);

    fireEvent.click(screen.getByRole("button", { name: /Foo\.ts/ }));
    expect(screen.getByText("apps/desktop/Foo.ts")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Open .* in editor/ }),
    ).not.toBeInTheDocument();
  });
});

describe("EditedFileViewToggle", () => {
  function Harness() {
    const [view, setView] = useState<EditedFileGroupView>("turns");
    return (
      <>
        <EditedFileViewToggle view={view} onViewChange={setView} />
        <span data-testid="current-view">{view}</span>
      </>
    );
  }

  it("reflects the active view and reports changes", () => {
    render(<Harness />);

    expect(screen.getByTestId("current-view")).toHaveTextContent("turns");
    expect(screen.getByRole("button", { name: "By turn" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "All files" }));

    expect(screen.getByTestId("current-view")).toHaveTextContent("files");
    expect(screen.getByRole("button", { name: "All files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
