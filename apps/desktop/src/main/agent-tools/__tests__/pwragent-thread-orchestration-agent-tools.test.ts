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
        type: "namespace",
        name: "pwragent",
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: "function",
            name: "attach_thread_directory",
            description: expect.stringContaining("secondary worktree"),
            deferLoading: false,
            inputSchema: expect.objectContaining({
              required: ["path"],
              properties: expect.objectContaining({
                workspaceMode: expect.objectContaining({
                  enum: ["local", "new_worktree"],
                }),
                worktreeBranchMode: expect.objectContaining({
                  enum: ["attached", "detached"],
                }),
              }),
            }),
          }),
          expect.objectContaining({
            type: "function",
            name: "detach_thread_directory",
            description: expect.stringContaining("primary provider/runtime cwd"),
            deferLoading: false,
            inputSchema: expect.objectContaining({
              additionalProperties: false,
              properties: expect.objectContaining({
                directoryId: expect.objectContaining({
                  description: expect.stringContaining("linked-directory id"),
                }),
                worktreePath: expect.objectContaining({
                  description: expect.stringContaining("worktree path"),
                }),
              }),
            }),
          }),
          expect.objectContaining({
            type: "function",
            name: "handoff_task",
            description: expect.stringMatching(
              /Prefer this to backend-native spawning.*Same-project handoffs default to grouped subthreads.*Cross-project handoffs are ungrouped/,
            ),
            deferLoading: false,
            inputSchema: expect.objectContaining({
              required: ["task"],
              properties: expect.objectContaining({
                seedMode: expect.objectContaining({
                  enum: ["clean", "fork"],
                }),
                groupingMode: expect.objectContaining({
                  enum: ["none", "subthread"],
                  description: expect.stringContaining("defaults for same-project"),
                }),
                workspaceMode: expect.objectContaining({
                  enum: ["same", "same_workspace", "project_local", "new_worktree", "none"],
                }),
                cwd: expect.objectContaining({
                  description: expect.stringContaining("task text does not select cwd"),
                }),
                backend: expect.objectContaining({
                  description: expect.stringContaining("`acp:grok`"),
                }),
                model: expect.objectContaining({
                  description: expect.stringContaining("`grok-4.5`"),
                }),
                branchName: expect.objectContaining({
                  description: expect.stringContaining("existing base branch/ref"),
                }),
              }),
            }),
          }),
          expect.objectContaining({
            type: "function",
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
            type: "function",
            name: "send_message_to_thread",
            description: expect.stringMatching(/schedules\/queues.*steer_thread/),
            deferLoading: false,
            inputSchema: expect.objectContaining({
              required: ["backend", "threadId", "prompt"],
              properties: expect.objectContaining({
                instanceId: expect.objectContaining({ type: "string" }),
                includeRemote: expect.objectContaining({ type: "boolean" }),
              }),
            }),
          }),
          expect.objectContaining({
            type: "function",
            name: "steer_thread",
            description: expect.stringMatching(
              /next tool completion or message boundary.*never reports a queued follow-up as steered/,
            ),
            deferLoading: false,
            inputSchema: expect.objectContaining({
              required: ["backend", "threadId", "requestId", "prompt"],
              properties: expect.objectContaining({
                instanceId: expect.objectContaining({ type: "string" }),
                includeRemote: expect.objectContaining({ type: "boolean" }),
                expectedTurnId: expect.objectContaining({ type: "string" }),
              }),
            }),
          }),
          expect.objectContaining({
            type: "function",
            name: "stop_thread",
            description: expect.stringMatching(/high-urgency.*never queues text/),
            deferLoading: false,
            inputSchema: expect.objectContaining({
              required: ["backend", "threadId", "requestId"],
              properties: expect.objectContaining({
                instanceId: expect.objectContaining({ type: "string" }),
                includeRemote: expect.objectContaining({ type: "boolean" }),
                expectedTurnId: expect.objectContaining({ type: "string" }),
              }),
            }),
          }),
          expect.objectContaining({
            type: "function",
            name: "start_review",
            description: expect.stringContaining("after the current turn completes successfully"),
            deferLoading: false,
            inputSchema: expect.objectContaining({
              required: ["target"],
              properties: expect.objectContaining({
                target: expect.objectContaining({
                  required: ["type"],
                  properties: expect.objectContaining({
                    type: expect.objectContaining({
                      enum: [
                        "uncommittedChanges",
                        "baseBranch",
                        "commit",
                        "custom",
                      ],
                    }),
                  }),
                }),
              }),
            }),
          }),
        ]),
      }),
    ]);
  });

  it("keeps handoff_task metadata identical across dynamic and MCP exposure", () => {
    const router = buildPwrAgentThreadOrchestrationToolRouter(undefined);
    const dynamicTool = router.buildDynamicToolSpecs()
      .flatMap((spec) => spec.type === "namespace" ? spec.tools : [])
      .find((tool) => tool.name === "handoff_task");
    const mcpTool = router.buildMcpTools()
      .find((tool) => tool.name === "handoff_task");

    expect(dynamicTool).toBeDefined();
    expect(mcpTool).toEqual({
      name: dynamicTool?.name,
      description: dynamicTool?.description,
      inputSchema: dynamicTool?.inputSchema,
    });
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

  it("validates and dispatches structured start_review args", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        backend: "codex" as const,
        threadId: "thread-1",
        pendingReviewId: "pending-review:1",
        status: "scheduled" as const,
        target: {
          type: "baseBranch" as const,
          branch: "main",
        },
        cwd: "/repo/app",
        invokingTurnId: "turn-1",
        createdAt: 1_773_000_000_000,
        message: "Review scheduled.",
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
        tool: "start_review",
        arguments: {
          target: {
            type: "baseBranch",
            branch: " main ",
          },
          cwd: " /repo/app ",
        },
      },
    });

    expect(handler).toHaveBeenCalledWith({
      operation: "start_review",
      context: {
        backend: "codex",
        threadId: "thread-1",
        callId: "call-1",
        turnId: "turn-1",
      },
      args: {
        target: {
          type: "baseBranch",
          branch: "main",
        },
        cwd: "/repo/app",
      },
    });

    handler.mockClear();
    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-2",
          namespace: "pwragent",
          tool: "start_review",
          arguments: {
            target: {
              type: "commit",
              sha: " ",
            },
          },
        },
      }),
    ).resolves.toMatchObject({ success: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("validates attach_thread_directory before dispatch", async () => {
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
          tool: "attach_thread_directory",
          arguments: {
            path: "  ",
          },
        },
      }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-2",
          namespace: "pwragent",
          tool: "attach_thread_directory",
          arguments: {
            path: "/repo/app",
            workspaceMode: "same_workspace",
          },
        },
      }),
    ).resolves.toMatchObject({ success: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("validates detach_thread_directory before dispatch", async () => {
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
          tool: "detach_thread_directory",
          arguments: {},
        },
      }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-2",
          namespace: "pwragent",
          tool: "detach_thread_directory",
          arguments: {
            path: "  ",
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
        threadUrl: "pwragent://thread/thread-child?backend=codex",
        threadLink: "[thread-child](pwragent://thread/thread-child?backend=codex)",
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
          cwd: " /Users/test/OtherRepo ",
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
        cwd: "/Users/test/OtherRepo",
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
        threadUrl: "pwragent://thread/target-thread?backend=codex",
        threadLink: "[target-thread](pwragent://thread/target-thread?backend=codex)",
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
          instanceId: " pwr_studio ",
          includeRemote: true,
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
        instanceId: "pwr_studio",
        includeRemote: true,
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

  it("normalizes attach_thread_directory args and dispatches with caller context", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        backend: "codex" as const,
        threadId: "thread-1",
        workspaceMode: "new_worktree" as const,
        directory: {
          id: "/repo/app",
          kind: "worktree" as const,
          label: "app",
          path: "/repo/app",
          worktreePath: "/worktrees/app",
        },
        message: "Attached a managed worktree directory to this thread.",
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
        tool: "attach_thread_directory",
        arguments: {
          backend: " codex ",
          path: " /repo/app ",
          workspaceMode: "new_worktree",
          branchName: " origin/main ",
          worktreeBranchMode: "attached",
        },
      },
    });

    expect(handler).toHaveBeenCalledWith({
      operation: "attach_thread_directory",
      context: {
        backend: "codex",
        threadId: "thread-1",
        callId: "call-1",
        turnId: "turn-1",
      },
      args: {
        backend: "codex",
        path: "/repo/app",
        workspaceMode: "new_worktree",
        branchName: "origin/main",
        worktreeBranchMode: "attached",
      },
    });
  });

  it("normalizes detach_thread_directory args and dispatches with caller context", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        backend: "codex" as const,
        threadId: "thread-1",
        detachedDirectory: {
          id: "/repo/app",
          kind: "local" as const,
          label: "app",
          path: "/repo/app",
        },
        directories: [],
        message: "Detached a secondary directory from this thread.",
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
        tool: "detach_thread_directory",
        arguments: {
          backend: " codex ",
          directoryId: " directory:/repo/app ",
          path: " /repo/app ",
          worktreePath: " /worktrees/app ",
        },
      },
    });

    expect(handler).toHaveBeenCalledWith({
      operation: "detach_thread_directory",
      context: {
        backend: "codex",
        threadId: "thread-1",
        callId: "call-1",
        turnId: "turn-1",
      },
      args: {
        backend: "codex",
        directoryId: "directory:/repo/app",
        path: "/repo/app",
        worktreePath: "/worktrees/app",
      },
    });
  });
});
