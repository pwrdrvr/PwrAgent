import { describe, expect, it } from "vitest";

import {
  PWRAGENT_THREAD_ORCHESTRATION_ERROR_CODES,
  PWRAGENT_THREAD_ORCHESTRATION_OPERATION_NAMES,
  type HandoffTaskResult,
  type HandoffTaskToolArgs,
  type ThreadHandoffOrigin,
} from "../thread-orchestration-tools";

describe("thread orchestration tool contracts", () => {
  it("defines the handoff task operation", () => {
    expect(PWRAGENT_THREAD_ORCHESTRATION_OPERATION_NAMES).toEqual([
      "handoff_task",
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
      messagingAttachment: "new_child",
      fastMode: true,
    } satisfies HandoffTaskToolArgs;

    expect(args).toMatchObject({
      seedMode: "fork",
      groupingMode: "subthread",
      workspaceMode: "new_worktree",
      messagingAttachment: "new_child",
    });
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
});
