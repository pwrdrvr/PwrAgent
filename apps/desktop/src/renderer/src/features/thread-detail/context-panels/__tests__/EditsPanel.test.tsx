import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditsPanel } from "../EditsPanel";
import type { EditedFileGroup } from "../../edited-file-groups";

afterEach(cleanup);

function editedGroup(n = 1): EditedFileGroup {
  return {
    key: `turn-${n}`,
    turn: { id: `turn-${n}`, completedAt: 1_718_000_000_000 + n },
    details: [
      {
        id: `detail-${n}`,
        kind: "write",
        label: `file-${n}.ts`,
        path: `/repo/apps/desktop/src/main/file-${n}.ts`,
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
}

function renderEditsPanel(groups: EditedFileGroup[]) {
  return (
    <EditsPanel
      groups={groups}
      commitStatesByKey={{
        "turn-1": {
          committed: true,
          commitSha: "a".repeat(40),
          shortSha: "aaaaaaa",
          pushed: true,
        },
      }}
      dock="sidebar"
      onDockChange={vi.fn()}
      onScrollToTurn={vi.fn()}
    />
  );
}

describe("EditsPanel", () => {
  it("keeps the group header for a single edit history in the sidebar", () => {
    render(renderEditsPanel([editedGroup()]));

    expect(
      screen.getByRole("button", { name: /Edited 1 file/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Scroll the transcript to this turn/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("aaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("Pushed")).toBeInTheDocument();
  });

  it("keeps the single group header after the hidden view toggle was left on All files", () => {
    const { rerender } = render(renderEditsPanel([editedGroup(2), editedGroup(1)]));

    fireEvent.click(screen.getByRole("button", { name: "All files" }));
    rerender(renderEditsPanel([editedGroup(1)]));

    expect(
      screen.getByRole("button", { name: /Edited 1 file/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Scroll the transcript to this turn/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("aaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("Pushed")).toBeInTheDocument();
  });
});
