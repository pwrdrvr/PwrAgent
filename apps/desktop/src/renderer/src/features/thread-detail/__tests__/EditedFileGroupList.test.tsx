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
    committed: false,
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

  it("does not show the turn toggle in the All files view", () => {
    render(<EditedFileGroupList groups={groups(5)} />);

    fireEvent.click(screen.getByRole("button", { name: "All files" }));
    expect(screen.queryByRole("button", { name: /Show \d+ more/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show less" })).not.toBeInTheDocument();
  });
});
