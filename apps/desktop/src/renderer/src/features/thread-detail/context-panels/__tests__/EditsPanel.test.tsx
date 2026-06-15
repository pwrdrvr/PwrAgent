import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EditsPanel } from "../EditsPanel";
import type { EditedFileGroup } from "../../edited-file-groups";

afterEach(cleanup);

function editedGroup(): EditedFileGroup {
  return {
    key: "turn-1",
    turn: { id: "turn-1", completedAt: 1_718_000_000_000 },
    details: [
      {
        id: "detail-1",
        kind: "write",
        label: "ipc.ts",
        path: "/repo/apps/desktop/src/main/ipc.ts",
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

describe("EditsPanel", () => {
  it("keeps the group header for a single edit history in the sidebar", () => {
    render(
      <EditsPanel
        groups={[editedGroup()]}
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
      />,
    );

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
