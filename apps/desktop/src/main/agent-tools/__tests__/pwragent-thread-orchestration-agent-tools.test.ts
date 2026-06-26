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
});
