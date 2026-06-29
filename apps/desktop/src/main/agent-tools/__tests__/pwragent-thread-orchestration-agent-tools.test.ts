import { describe, expect, it, vi } from "vitest";

import {
  buildPwrAgentThreadOrchestrationToolRouter,
  PWRAGENT_THREAD_ORCHESTRATION_UNAVAILABLE_MESSAGE,
} from "../pwragent-thread-orchestration-agent-tools";

describe("pwragent thread orchestration agent tools", () => {
  it("projects handoff_task under the unified pwragent namespace", () => {
    const router = buildPwrAgentThreadOrchestrationToolRouter(undefined);

    expect(router.buildDynamicToolSpecs()).toEqual([
      expect.objectContaining({
        namespace: "pwragent",
        name: "handoff_task",
        description: expect.stringContaining("backports"),
        deferLoading: false,
        inputSchema: expect.objectContaining({
          required: ["task"],
          properties: expect.objectContaining({
            seedMode: expect.objectContaining({
              enum: ["clean", "fork"],
            }),
            groupingMode: expect.objectContaining({
              enum: ["none", "subthread"],
            }),
            workspaceMode: expect.objectContaining({
              enum: ["same", "same_workspace", "project_local", "new_worktree", "none"],
            }),
            branchName: expect.objectContaining({
              description: expect.stringContaining("existing base branch/ref"),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        namespace: "pwragent",
        name: "move_thread_workspace",
        description: expect.stringContaining("same-thread continuation"),
        deferLoading: false,
        inputSchema: expect.objectContaining({
          additionalProperties: false,
          properties: expect.objectContaining({
            direction: expect.objectContaining({
              enum: ["local-to-worktree", "worktree-to-local"],
            }),
            strategy: expect.objectContaining({
              enum: ["move-branch", "detached-changes", "new-branch"],
            }),
            sourcePath: expect.objectContaining({
              description: expect.stringContaining("multiple linked directories"),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        namespace: "pwragent",
        name: "send_message_to_thread",
        deferLoading: false,
        inputSchema: expect.objectContaining({
          required: ["backend", "threadId", "prompt"],
        }),
      }),
    ]);
  });

  it("returns unavailable when no handler is registered", async () => {
    const router = buildPwrAgentThreadOrchestrationToolRouter(undefined);

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: { task: "Ship it" },
        },
      }),
    ).resolves.toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(
            {
              code: "internal_error",
              message: PWRAGENT_THREAD_ORCHESTRATION_UNAVAILABLE_MESSAGE,
            },
            null,
            2,
          ),
        },
      ],
    });
  });

  it("validates task before dispatch", async () => {
    const handler = vi.fn();
    const router = buildPwrAgentThreadOrchestrationToolRouter(handler);

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: { task: "  " },
        },
      }),
    ).resolves.toMatchObject({ success: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("validates send_message_to_thread before dispatch", async () => {
    const handler = vi.fn();
    const router = buildPwrAgentThreadOrchestrationToolRouter(handler);

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent",
          tool: "send_message_to_thread",
          arguments: {
            backend: "codex",
            threadId: "target-thread",
            prompt: "  ",
          },
        },
      }),
    ).resolves.toMatchObject({ success: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("validates move_thread_workspace before dispatch", async () => {
    const handler = vi.fn();
    const router = buildPwrAgentThreadOrchestrationToolRouter(handler);

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent",
          tool: "move_thread_workspace",
          arguments: {
            direction: "sideways",
            sourcePath: "/repo/app",
          },
        },
      }),
    ).resolves.toMatchObject({ success: false });
    expect(handler).not.toHaveBeenCalled();

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-2",
          namespace: "pwragent",
          tool: "move_thread_workspace",
          arguments: {
            sourcePath: "  ",
          },
        },
      }),
    ).resolves.toMatchObject({ success: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("normalizes args and dispatches with caller context", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        backend: "codex" as const,
        threadId: "thread-child",
        turnId: "turn-child",
        seedMode: "fork" as const,
        groupingMode: "subthread" as const,
        inheritedSettings: { backend: "codex" as const },
        origin: {
          sourceBackend: "codex" as const,
          sourceThreadId: "thread-1",
          sourceTurnId: "turn-1",
          seedMode: "fork" as const,
          groupingMode: "subthread" as const,
          createdAt: 1_773_000_000_000,
          workspace: {
            mode: "same" as const,
            git: {
              kind: "none" as const,
              worktreeCreationAvailable: false as const,
              unavailableReason: "No workspace.",
            },
          },
        },
        workspace: {
          mode: "same" as const,
          git: {
            kind: "none" as const,
            worktreeCreationAvailable: false as const,
            unavailableReason: "No workspace.",
          },
        },
        messagingAttachment: {
          requested: false as const,
          outcome: "not_requested" as const,
        },
      },
    }));
    const router = buildPwrAgentThreadOrchestrationToolRouter(handler);

    await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "pwragent",
        tool: "handoff_task",
        arguments: {
          task: "  Ship it  ",
          seedMode: "fork",
          groupingMode: "subthread",
          workspaceMode: "same_workspace",
          messagingAttachment: "auto",
        },
      },
    });

    expect(handler).toHaveBeenCalledWith({
      operation: "handoff_task",
      context: {
        backend: "codex",
        threadId: "thread-1",
        callId: "call-1",
        turnId: "turn-1",
      },
      args: {
        task: "Ship it",
        seedMode: "fork",
        groupingMode: "subthread",
        workspaceMode: "same_workspace",
        messagingAttachment: "auto",
      },
    });
  });

  it("normalizes send_message_to_thread args and dispatches with caller context", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        backend: "codex" as const,
        threadId: "target-thread",
        turnId: "target-turn",
        promptPreview: "Check CI",
        settings: {
          model: "gpt-5.5",
          fastMode: true,
        },
      },
    }));
    const router = buildPwrAgentThreadOrchestrationToolRouter(handler);

    await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "pwragent",
        tool: "send_message_to_thread",
        arguments: {
          backend: "codex",
          threadId: " target-thread ",
          prompt: " Check CI ",
          model: " gpt-5.5 ",
          fastMode: true,
        },
      },
    });

    expect(handler).toHaveBeenCalledWith({
      operation: "send_message_to_thread",
      context: {
        backend: "codex",
        threadId: "thread-1",
        callId: "call-1",
        turnId: "turn-1",
      },
      args: {
        backend: "codex",
        threadId: "target-thread",
        prompt: "Check CI",
        model: "gpt-5.5",
        fastMode: true,
      },
    });
  });

  it("normalizes move_thread_workspace args and dispatches with caller context", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        backend: "codex" as const,
        threadId: "thread-1",
        workspaceMoveId: "workspace-move:codex:thread-1:turn-1:call-1",
        status: "queued" as const,
        phase: "waiting_for_turn_boundary" as const,
        direction: "local-to-worktree" as const,
        repositoryPath: "/repo/app",
        sourcePath: "/repo/app",
        createdAt: 1_773_000_000_000,
        updatedAt: 1_773_000_000_000,
        message:
          "Workspace move queued. Stop this turn and wait for the continuation.",
      },
    }));
    const router = buildPwrAgentThreadOrchestrationToolRouter(handler);

    await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "pwragent",
        tool: "move_thread_workspace",
        arguments: {
          repositoryPath: " /repo/app ",
          sourcePath: " /repo/app ",
          leaveLocalBranch: " main ",
        },
      },
    });

    expect(handler).toHaveBeenCalledWith({
      operation: "move_thread_workspace",
      context: {
        backend: "codex",
        threadId: "thread-1",
        callId: "call-1",
        turnId: "turn-1",
      },
      args: {
        direction: "local-to-worktree",
        repositoryPath: "/repo/app",
        sourcePath: "/repo/app",
        leaveLocalBranch: "main",
      },
    });
  });
});
