import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  GetWorktreeOtherChangeDiffRequest,
  GetWorktreeOtherChangeDiffResponse,
} from "@pwragent/shared";
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
    expect(screen.queryByText("aaaaaaa")).not.toBeInTheDocument();
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
    expect(screen.queryByText("aaaaaaa")).not.toBeInTheDocument();
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

  it("uses current worktree diffs for the All files view instead of summing historical edits", async () => {
    const listWorktreeOtherChanges = vi.fn(async () => ({
      changes: [],
      totalChanges: 0,
      truncated: false,
      maxFiles: 50,
    }));
    const getWorktreeOtherChangeDiff = vi.fn(async () => ({
      detail: {
        id: "other-change:/repo/src/MemoryDumpMonitor.scala",
        kind: "write" as const,
        label: "MemoryDumpMonitor.scala",
        path: "/repo/src/MemoryDumpMonitor.scala",
        fileDiff: {
          kind: "add" as const,
          diff: "--- /dev/null\n+++ b/src/MemoryDumpMonitor.scala\n@@ -0,0 +1,194 @@\n+final file\n",
          additions: 194,
          removals: 0,
        },
      },
    }));
    const groups: EditedFileGroup[] = [
      {
        key: "turn-2",
        turn: { id: "turn-2", completedAt: 1_718_000_000_002 },
        details: [
          {
            id: "detail-update",
            kind: "write",
            label: "Update MemoryDumpMonitor.scala",
            path: "/repo/src/MemoryDumpMonitor.scala",
            fileDiff: {
              kind: "update",
              diff: "@@ -1 +1 @@\n-old\n+new\n",
              additions: 203,
              removals: 25,
            },
          },
        ],
        summary: "Edited 1 file",
        additions: 203,
        removals: 25,
        live: false,
      },
      {
        key: "turn-1",
        turn: { id: "turn-1", completedAt: 1_718_000_000_001 },
        details: [
          {
            id: "detail-add",
            kind: "write",
            label: "Add MemoryDumpMonitor.scala",
            path: "/repo/src/MemoryDumpMonitor.scala",
            fileDiff: {
              kind: "add",
              diff: "--- /dev/null\n+++ b/src/MemoryDumpMonitor.scala\n@@ -0,0 +1,194 @@\n+initial file\n",
              additions: 194,
              removals: 0,
            },
          },
        ],
        summary: "Edited 1 file",
        additions: 194,
        removals: 0,
        live: false,
      },
    ];

    render(
      <EditsPanel
        groups={groups}
        dock="sidebar"
        onDockChange={vi.fn()}
        worktreeRoot="/repo"
        desktopApi={{ listWorktreeOtherChanges, getWorktreeOtherChangeDiff }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "All files" }));

    await waitFor(() => {
      expect(getWorktreeOtherChangeDiff).toHaveBeenCalledWith({
        worktreePath: "/repo",
        path: "/repo/src/MemoryDumpMonitor.scala",
        maxBytes: 200000,
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Edited 1 file")).toBeInTheDocument();
      expect(screen.getAllByLabelText("+194 -0")).toHaveLength(2);
    });
    expect(screen.queryByLabelText("+397 -25")).not.toBeInTheDocument();
  });

  it("drops edited files that no longer have a current worktree diff", async () => {
    const listWorktreeOtherChanges = vi.fn(async () => ({
      changes: [],
      totalChanges: 0,
      truncated: false,
      maxFiles: 50,
    }));
    const getWorktreeOtherChangeDiff = vi.fn(async (request) => ({
      detail: request.path.endsWith("clean.ts")
        ? undefined
        : {
            id: "other-change:/repo/src/dirty.ts",
            kind: "write" as const,
            label: "dirty.ts",
            path: "/repo/src/dirty.ts",
            fileDiff: {
              kind: "update" as const,
              diff: "@@ -1 +1 @@\n+dirty\n",
              additions: 7,
              removals: 0,
            },
          },
    }));
    const dirtyGroup: EditedFileGroup = {
      ...editedGroup(2),
      details: [
        {
          id: "dirty",
          kind: "write",
          label: "Update dirty.ts",
          path: "/repo/src/dirty.ts",
          fileDiff: {
            kind: "update",
            diff: "@@ -1 +1 @@\n+dirty\n",
            additions: 7,
            removals: 0,
          },
        },
      ],
      additions: 7,
      removals: 0,
    };
    const cleanGroup: EditedFileGroup = {
      ...editedGroup(1),
      details: [
        {
          id: "clean",
          kind: "write",
          label: "Update clean.ts",
          path: "/repo/src/clean.ts",
          fileDiff: {
            kind: "update",
            diff: "@@ -1 +1 @@\n+clean\n",
            additions: 11,
            removals: 3,
          },
        },
      ],
      additions: 11,
      removals: 3,
    };

    render(
      <EditsPanel
        groups={[dirtyGroup, cleanGroup]}
        dock="sidebar"
        onDockChange={vi.fn()}
        worktreeRoot="/repo"
        desktopApi={{ listWorktreeOtherChanges, getWorktreeOtherChangeDiff }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "All files" }));

    await waitFor(() => {
      expect(screen.getAllByLabelText("+7 -0")).toHaveLength(2);
    });
    expect(screen.getByText("Edited 1 file")).toBeInTheDocument();
    expect(screen.getByText("Update dirty.ts")).toBeInTheDocument();
    expect(screen.queryByText("Update clean.ts")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("+18 -3")).not.toBeInTheDocument();
  });

  it("refreshes current All files diffs when the worktree refresh key changes", async () => {
    const listWorktreeOtherChanges = vi.fn(async () => ({
      changes: [],
      totalChanges: 0,
      truncated: false,
      maxFiles: 50,
    }));
    let currentAdditions = 5;
    const getWorktreeOtherChangeDiff = vi.fn(
      async (
        request: GetWorktreeOtherChangeDiffRequest,
      ): Promise<GetWorktreeOtherChangeDiffResponse> => {
        return {
          detail: request.path.endsWith("file-1.ts")
            ? {
                id: "other-change:/repo/apps/desktop/src/main/file-1.ts",
                kind: "write" as const,
                label: "file-1.ts",
                path: "/repo/apps/desktop/src/main/file-1.ts",
                fileDiff: {
                  kind: "update" as const,
                  diff: "@@ -1 +1 @@\n+live\n",
                  additions: currentAdditions,
                  removals: 0,
                },
              }
            : undefined,
        };
      },
    );
    const panel = (refreshKey: string) => (
      <EditsPanel
        groups={[editedGroup(2), editedGroup(1)]}
        dock="sidebar"
        onDockChange={vi.fn()}
        worktreeRoot="/repo"
        workingStateRefreshKey={refreshKey}
        desktopApi={{ listWorktreeOtherChanges, getWorktreeOtherChangeDiff }}
      />
    );
    const { rerender } = render(panel("first"));

    fireEvent.click(screen.getByRole("button", { name: "All files" }));
    await waitFor(() => {
      expect(screen.getAllByLabelText("+5 -0")).toHaveLength(2);
    });

    currentAdditions = 9;
    rerender(panel("second"));

    await waitFor(() => {
      expect(screen.getAllByLabelText("+9 -0")).toHaveLength(2);
    });
    expect(getWorktreeOtherChangeDiff).toHaveBeenCalledTimes(4);
  });
});
