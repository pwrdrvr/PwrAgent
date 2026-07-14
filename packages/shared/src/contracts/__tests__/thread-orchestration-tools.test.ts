import { describe, expect, it } from "vitest";

import {
  ATTACH_THREAD_DIRECTORY_WORKSPACE_MODES,
  DEFAULT_MOVE_THREAD_WORKSPACE_STRATEGY,
  PWRAGENT_THREAD_ORCHESTRATION_ERROR_CODES,
  PWRAGENT_THREAD_ORCHESTRATION_OPERATION_NAMES,
  type AttachThreadDirectoryResult,
  type AttachThreadDirectoryToolArgs,
  type DetachThreadDirectoryResult,
  type DetachThreadDirectoryToolArgs,
  type HandoffTaskResult,
  type HandoffTaskToolArgs,
  type MoveThreadWorkspaceResult,
  type MoveThreadWorkspaceToolArgs,
  type ThreadHandoffOrigin,
} from "../thread-orchestration-tools";

describe("thread orchestration tool contracts", () => {
  it("defines the handoff task operation", () => {
    expect(PWRAGENT_THREAD_ORCHESTRATION_OPERATION_NAMES).toEqual([
      "attach_thread_directory",
      "detach_thread_directory",
      "handoff_task",
      "move_thread_workspace",
      "send_message_to_thread",
    ]);
  });

  it("defines structured handoff error codes", () => {
    expect(PWRAGENT_THREAD_ORCHESTRATION_ERROR_CODES).toEqual([
      "invalid_arguments",
      "not_found",
      "forbidden",
      "unsupported_backend",
      "unsupported_workspace",
      "unsupported_operation",
      "ambiguous_workspace",
      "requires_confirmation",
      "turn_start_failed",
      "internal_error",
    ]);
  });

  it("models clean, fork, grouping, workspace, and messaging modes", () => {
    const args = {
      task: "Implement the handoff service",
      seedMode: "fork",
      groupingMode: "subthread",
      workspaceMode: "new_worktree",
      cwd: "/Users/test/OtherRepo",
      messagingAttachment: "new_child",
      fastMode: true,
    } satisfies HandoffTaskToolArgs;

    expect(args).toMatchObject({
      seedMode: "fork",
      groupingMode: "subthread",
      workspaceMode: "new_worktree",
      cwd: "/Users/test/OtherRepo",
      messagingAttachment: "new_child",
    });
  });

  it("models attach and detach directory operations", () => {
    expect(ATTACH_THREAD_DIRECTORY_WORKSPACE_MODES).toEqual([
      "local",
      "new_worktree",
    ]);

    const attachArgs = {
      path: "/repo/agent-kit",
      workspaceMode: "new_worktree",
      branchName: "origin/main",
      worktreeBranchMode: "detached",
    } satisfies AttachThreadDirectoryToolArgs;
    const attachResult: AttachThreadDirectoryResult = {
      backend: "codex",
      threadId: "thread-1",
      workspaceMode: attachArgs.workspaceMode,
      directory: {
        id: "/repo/agent-kit",
        kind: "worktree",
        label: "agent-kit",
        path: attachArgs.path,
        worktreePath: "/worktrees/agent-kit",
      },
      message: "Attached a managed worktree directory to this thread.",
    };
    const detachArgs = {
      worktreePath: "/worktrees/agent-kit",
    } satisfies DetachThreadDirectoryToolArgs;
    const detachResult: DetachThreadDirectoryResult = {
      backend: "codex",
      threadId: "thread-1",
      detachedDirectory: attachResult.directory,
      directories: [],
      message: "Detached a secondary directory from this thread.",
    };

    expect(JSON.parse(JSON.stringify(attachResult))).toEqual(attachResult);
    expect(JSON.parse(JSON.stringify(detachArgs))).toEqual(detachArgs);
    expect(JSON.parse(JSON.stringify(detachResult))).toEqual(detachResult);
  });

  it("keeps handoff origin serializable and separate from parent grouping", () => {
    const origin = {
      sourceBackend: "codex",
      sourceThreadId: "thread-parent",
      sourceTurnId: "turn-1",
      sourceTitle: "Parent",
      taskTitle: "Handoff",
      seedMode: "clean",
      groupingMode: "none",
      createdAt: 1_773_000_000_000,
      workspace: {
        mode: "same",
        cwd: "/repo",
        branch: "main",
        git: {
          kind: "git_local",
          worktreeCreationAvailable: true,
        },
      },
    } satisfies ThreadHandoffOrigin;

    const result: HandoffTaskResult = {
      backend: "codex",
      threadId: "thread-child",
      turnId: "turn-child",
      threadUrl: "pwragent://thread/thread-child?backend=codex",
      threadLink: "[thread-child](pwragent://thread/thread-child?backend=codex)",
      seedMode: "clean",
      groupingMode: "none",
      inheritedSettings: {
        backend: "codex",
        executionMode: "default",
        model: "gpt-5",
        fastMode: false,
      },
      origin,
      workspace: origin.workspace,
      messagingAttachment: {
        requested: false,
        outcome: "not_requested",
      },
    };

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result.groupedUnderThreadId).toBeUndefined();
  });

  it("models pending same-thread workspace moves separately from task handoffs", () => {
    expect(DEFAULT_MOVE_THREAD_WORKSPACE_STRATEGY).toBe("detached-changes");

    const args = {
      direction: "local-to-worktree",
      repositoryPath: "/repo/app",
      sourcePath: "/repo/app",
      leaveLocalBranch: "main",
    } satisfies MoveThreadWorkspaceToolArgs;

    const result: MoveThreadWorkspaceResult = {
      backend: "codex",
      threadId: "thread-1",
      workspaceMoveId: "workspace-move:codex:thread-1:turn-1:call-1",
      status: "queued",
      phase: "waiting_for_turn_boundary",
      direction: args.direction,
      repositoryPath: args.repositoryPath,
      sourcePath: args.sourcePath,
      createdAt: 1_773_000_000_000,
      updatedAt: 1_773_000_000_000,
      message:
        "Workspace move queued. Stop this turn and wait for the continuation.",
    };

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result.status).toBe("queued");
  });
});
