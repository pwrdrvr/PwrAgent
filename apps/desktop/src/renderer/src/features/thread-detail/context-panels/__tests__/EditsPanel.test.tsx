import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("excludes live turn files with repo-relative paths from other changes", async () => {
    const listWorktreeOtherChanges = vi.fn(async () => ({
      changes: [],
      totalChanges: 0,
      truncated: false,
      maxFiles: 50,
    }));
    const group: EditedFileGroup = {
      ...editedGroup(),
      key: "live-turn",
      live: true,
      details: [
        {
          id: "live-detail-1",
          kind: "write",
          label: "Update ipc.ts",
          path: "apps/desktop/src/shared/ipc.ts",
          fileDiff: {
            kind: "update",
            diff: "@@ -1 +1 @@\n+hello\n",
            additions: 1,
            removals: 0,
          },
        },
      ],
    };

    render(
      <EditsPanel
        groups={[group]}
        dock="sidebar"
        onDockChange={vi.fn()}
        worktreeRoot="/repo"
        desktopApi={{ listWorktreeOtherChanges }}
      />,
    );

    await waitFor(() => {
      expect(listWorktreeOtherChanges).toHaveBeenCalledWith({
        worktreePath: "/repo",
        excludePaths: ["/repo/apps/desktop/src/shared/ipc.ts"],
        maxFiles: 50,
      });
    });
  });

  it("shows non-turn worktree changes first and fetches their diff only when expanded", async () => {
    const listWorktreeOtherChanges = vi.fn(async () => ({
      changes: [
        {
          path: "/repo/docs/design.md",
          repoPath: "docs/design.md",
          status: "modified" as const,
          staged: false,
          unstaged: true,
          additions: 3,
          removals: 1,
        },
        {
          path: "/repo/docs/PwrAgent.zip",
          repoPath: "docs/PwrAgent.zip",
          status: "untracked" as const,
          staged: false,
          unstaged: true,
          binary: true,
          sizeBytes: 15_846_287,
        },
      ],
      totalChanges: 2,
      truncated: false,
      maxFiles: 50,
    }));
    const getWorktreeOtherChangeDiff = vi.fn(async () => ({
      detail: {
        id: "other-change:/repo/docs/design.md",
        kind: "write" as const,
        label: "design.md",
        path: "/repo/docs/design.md",
        fileDiff: {
          kind: "update" as const,
          diff: "--- a/docs/design.md\n+++ b/docs/design.md\n@@ -1 +1 @@\n-old\n+new\n",
          additions: 1,
          removals: 1,
        },
      },
    }));

    render(
      <EditsPanel
        groups={[editedGroup()]}
        dock="sidebar"
        onDockChange={vi.fn()}
        worktreeRoot="/repo"
        desktopApi={{ listWorktreeOtherChanges, getWorktreeOtherChangeDiff }}
      />,
    );

    const otherToggle = await screen.findByRole("button", {
      name: /Other 2 files/i,
    });
    expect(otherToggle).toBeInTheDocument();
    expect(screen.getAllByLabelText("+3 -1")).toHaveLength(2);
    expect(screen.getByText("Update design.md")).toBeInTheDocument();
    expect(screen.getByText("Add PwrAgent.zip")).toBeInTheDocument();
    expect(screen.getByLabelText("15.1 MB")).toBeInTheDocument();
    expect(listWorktreeOtherChanges).toHaveBeenCalledWith({
      worktreePath: "/repo",
      excludePaths: ["/repo/apps/desktop/src/main/file-1.ts"],
      maxFiles: 50,
    });
    expect(getWorktreeOtherChangeDiff).not.toHaveBeenCalled();

    fireEvent.click(otherToggle);
    expect(screen.queryByText("Update design.md")).not.toBeInTheDocument();

    fireEvent.click(otherToggle);
    fireEvent.click(screen.getByRole("button", { name: /Update design\.md/i }));

    await waitFor(() => {
      expect(getWorktreeOtherChangeDiff).toHaveBeenCalledWith({
        worktreePath: "/repo",
        path: "/repo/docs/design.md",
        maxBytes: 200000,
      });
    });
    expect(screen.getByText("docs/design.md")).toBeInTheDocument();
    expect(await screen.findByText("new")).toBeInTheDocument();
  });
});
