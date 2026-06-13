import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditedFileGroupList } from "../EditedFileGroupList";
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
    expect(
      screen.getByRole("button", { name: `Copy commit ${"a".repeat(40)}` }),
    ).toBeInTheDocument();
  });

  it("shows a local-only badge for an unpushed commit", () => {
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

    expect(screen.getByText("Local")).toBeInTheDocument();
    // turn-2 has no resolved state yet → no badge (avoids a wrong flash).
    expect(screen.queryByText("Uncommitted")).not.toBeInTheDocument();
  });

  it("does not show the turn toggle in the All files view", () => {
    render(<EditedFileGroupList groups={groups(5)} />);

    fireEvent.click(screen.getByRole("button", { name: "All files" }));
    expect(screen.queryByRole("button", { name: /Show \d+ more/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show less" })).not.toBeInTheDocument();
  });
});
