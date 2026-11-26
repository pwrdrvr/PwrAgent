import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { ResolvedInitialThreadContinueAfter } from "@pwragent/shared/contracts/thread-dependencies";
import { ThreadWorkspaceService } from "../app-server/thread-workspace-service";
import { buildPwrAgentThreadTodoToolRouter } from "../agent-tools/pwragent-thread-todo-agent-tools";
import * as appState from "../state/app-state";
import {
  createThreadTodoRunners,
  getThreadTodoService,
  installThreadTodoRuntime,
  resetThreadTodoServiceForTests,
} from "../thread-todos/thread-todo-runtime";
import { registryContextStandIn } from "./helpers/registry-context-stand-in";
import { openInMemoryStateDb } from "./sqlite-test-utils";

afterEach(() => {
  resetThreadTodoServiceForTests();
  vi.restoreAllMocks();
});

describe("ThreadWorkspaceService handoff_task continueAfter integration", () => {
  function buildHandoffWorkspaceService(overrides: {
    threadDependencyToolHandler?: ReturnType<typeof vi.fn>;
    startTurn?: ReturnType<typeof vi.fn>;
    startThread?: ReturnType<typeof vi.fn>;
  } = {}) {
    const events: string[] = [];
    const startThread = overrides.startThread ?? vi.fn(async () => {
      events.push("startThread");
      return { threadId: "child-thread-1" };
    });
    const startTurn = overrides.startTurn ?? vi.fn(async () => {
      events.push("startTurn");
      return { backend: "acp:antigravity" as const, threadId: "child-thread-1", turnId: "child-turn-1" };
    });
    const threadDependencyToolHandler = overrides.threadDependencyToolHandler;
    const context = registryContextStandIn({
      overlayStore: {
        getThreadOverlayState: vi.fn(async () => undefined),
        setThreadHandoffOrigin: vi.fn(async () => {}),
      },
      providers: {
        acp: {
          getInstalledAgent: () => undefined,
        },
      },
    });
    const host = {
      isLiveDynamicToolCall: () => true,
      readCausalMessagingContext: async () => ({}),
      resolveModelSettings: async (_backend: AppServerBackendKind, settings: Record<string, unknown>) => settings,
      admitNewThreadModelSettings: async (_backend: AppServerBackendKind, settings: Record<string, unknown>) => settings,
      resolveAgentCallerExecutionMode: async () => "full-access" as const,
      findThreadForWorkspaceHandoff: async () => ({
        id: "parent-thread-1",
        title: "Find and fix worst-case rendering (#688)",
        linkedDirectories: [],
      }),
      resolveThreadEnvironmentCwd: async () => undefined,
      getCachedThreadSummary: ({ threadId }: { threadId: string }) =>
        threadId === "sibling-thread" ? { id: "sibling-thread", title: "Sibling PR #687" } : undefined,
      startThread,
      renameThread: vi.fn(async () => ({})),
      pendingStartedThreads: new Map(),
      invalidateThreadListCache: vi.fn(),
      readDelegatedTurnAncestry: async () => ({}),
      getTurnInputAttachments: () => [],
      startTurn,
      dispatchMessagingRequest: async () => ({ ok: false, error: { code: "unsupported_operation", message: "none" } }),
      publishLocalEvent: vi.fn(async () => {}),
      ...(threadDependencyToolHandler ? { threadDependencyToolHandler } : {}),
    };
    const service = new ThreadWorkspaceService(
      context,
      { threadArchiveCoordinator: {} as never, gitWorkspaceHandoffService: {} as never },
      () => host as never,
    );
    return { service, host, events, startThread, startTurn };
  }

  it("registers Continue After on the child thread after startTurn and defaults omitted prerequisite to parent", async () => {
    const events: string[] = [];
    const startTurn = vi.fn(async () => {
      events.push("startTurn");
      return { backend: "acp:antigravity" as const, threadId: "child-thread-1", turnId: "child-turn-1" };
    });
    const threadDependencyToolHandler = vi.fn(async () => {
      events.push("registerDependency");
      return {
        ok: true as const,
        data: {
          threadDependencies: {
            dependencies: [{ id: "dep-1", status: "waiting" }],
          },
        },
      };
    });
    const { service } = buildHandoffWorkspaceService({ startTurn, threadDependencyToolHandler });

    const response = await service.handoffTaskToThread({
      operation: "handoff_task",
      context: { backend: "acp:antigravity", threadId: "parent-thread-1", turnId: "parent-turn-1" },
      args: {
        task: "Fix pointer-travel on top of #688; commit locally and do not open a PR yet.",
        workspaceMode: "none",
        continueAfter: {
          conditions: [{ when: "pr_merged", prUrl: "https://github.com/pwrdrvr/PwrGit/pull/688" }],
          continuation: "PR #688 merged. Fetch origin/main, rebase, verify, push, and open the PR.",
        },
      },
    });

    expect(response.ok).toBe(true);
    if (!response.ok || !("seedMode" in response.data)) return;
    expect(events).toEqual(["startTurn", "registerDependency"]);
    expect(response.data.continueAfter).toEqual({
      status: "registered",
      dependencyId: "dep-1",
      dependencyStatus: "waiting",
    });
    expect(threadDependencyToolHandler).toHaveBeenCalledWith(
      {
        action: "create",
        backend: "acp:antigravity",
        threadId: "child-thread-1",
        conditions: [
          {
            backend: "acp:antigravity",
            threadId: "parent-thread-1",
            when: "pr_merged",
            prUrl: "https://github.com/pwrdrvr/PwrGit/pull/688",
            title: "Find and fix worst-case rendering (#688)",
          },
        ],
        continuation: "PR #688 merged. Fetch origin/main, rebase, verify, push, and open the PR.",
      },
      {},
      "agent:acp:antigravity:parent-thread-1",
    );
    const turnInput = (startTurn.mock.calls[0] as unknown as [{ input: { text: string }[] }])[0].input[0]!.text;
    expect(turnInput).toContain("Continue After:");
    expect(turnInput).toContain("PR #688 is merged");
    expect(turnInput).toContain("Do not register a duplicate Continue After wait");
  });

  it("fails fast before creating a child thread when threadDependencyToolHandler is unavailable", async () => {
    const startThread = vi.fn();
    const { service } = buildHandoffWorkspaceService({ startThread });

    const response = await service.handoffTaskToThread({
      operation: "handoff_task",
      context: { backend: "acp:antigravity", threadId: "parent-thread-1", turnId: "parent-turn-1" },
      args: {
        task: "Fix pointer-travel.",
        workspaceMode: "none",
        continueAfter: {
          conditions: [{ when: "pr_merged" }],
          continuation: "Open PR after merge.",
        },
      },
    });

    expect(response).toEqual({
      ok: false,
      error: {
        code: "unsupported_operation",
        message: "Thread dependencies (Continue After) are not available on this instance.",
      },
    });
    expect(startThread).not.toHaveBeenCalled();
  });

  it("skips registration when the child thread's initial turn fails to start", async () => {
    const threadDependencyToolHandler = vi.fn();
    const startTurn = vi.fn(async () => {
      throw new Error("provider overloaded");
    });
    const { service } = buildHandoffWorkspaceService({ startTurn, threadDependencyToolHandler });

    const response = await service.handoffTaskToThread({
      operation: "handoff_task",
      context: { backend: "acp:antigravity", threadId: "parent-thread-1", turnId: "parent-turn-1" },
      args: {
        task: "Fix pointer-travel.",
        workspaceMode: "none",
        continueAfter: {
          conditions: [{ when: "pr_merged" }],
          continuation: "Open PR after merge.",
        },
      },
    });

    expect(response.ok).toBe(true);
    if (!response.ok || !("seedMode" in response.data)) return;
    expect(threadDependencyToolHandler).not.toHaveBeenCalled();
    expect(response.data.continueAfter).toEqual({
      status: "skipped",
      error: "Skipped registering Continue After because the child thread's initial turn failed to start.",
    });
  });

  it("keeps the created child thread and reports failure if dependency registration fails after startTurn", async () => {
    const threadDependencyToolHandler = vi.fn(async () => ({
      ok: false as const,
      error: { code: "invalid_arguments" as const, message: "Too many active waits." },
    }));
    const { service } = buildHandoffWorkspaceService({ threadDependencyToolHandler });

    const response = await service.handoffTaskToThread({
      operation: "handoff_task",
      context: { backend: "acp:antigravity", threadId: "parent-thread-1", turnId: "parent-turn-1" },
      args: {
        task: "Fix pointer-travel.",
        workspaceMode: "none",
        continueAfter: {
          conditions: [{ when: "pr_merged" }],
          continuation: "Open PR after merge.",
        },
      },
    });

    expect(response.ok).toBe(true);
    if (!response.ok || !("seedMode" in response.data)) return;
    expect(response.data.threadId).toBe("child-thread-1");
    expect(response.data.continueAfter).toEqual({
      status: "failed",
      error: "Too many active waits.",
    });
  });
});

describe("start_thread to-do card continueAfter integration", () => {
  it("resolves, updates, clears, and registers continueAfter when the operator starts a thread", async () => {
    const db = openInMemoryStateDb();
    vi.spyOn(appState, "getAppStateDb").mockReturnValue(db);
    try {
      const order: string[] = [];
      const registerContinueAfter = vi.fn(async () => {
        order.push("registerContinueAfter");
      });
      const startTurn = vi.fn(async () => {
        order.push("startTurn");
        return { backend: "codex" as const, threadId: "started-1", turnId: "turn-1" };
      });
      let registeredTodoHandler: Parameters<typeof buildPwrAgentThreadTodoToolRouter>[0];
      const registry = {
        setPwrAgentThreadTodoHandler: vi.fn((h) => { registeredTodoHandler = h; }),
        onEvent: vi.fn(() => () => {}),
        getThreadInfo: vi.fn(({ threadId }: { threadId: string }) =>
          threadId === "parent-1" ? { title: "Parent PR #688" } : undefined),
        resolveThreadWorkspaceCwd: vi.fn(async () => "/tmp/repo"),
        resolveThreadPrimaryDirectory: vi.fn(async () => undefined),
        readThreadHandoffSettings: vi.fn(async () => ({
          executionMode: "default" as const,
          model: "gpt-5.4",
        })),
        readBackendModelOptions: vi.fn(async () => ({ models: [{ id: "gpt-5.4", label: "GPT-5.4" }] })),
        listBackends: vi.fn(async () => ({
          backends: [{ kind: "codex" as const, label: "Codex", available: true }],
        })),
        renameThread: vi.fn(async () => ({})),
        startThread: vi.fn(async () => ({ backend: "codex" as const, threadId: "started-1" })),
        startTurn,
        sendThreadTodoMessage: vi.fn(),
        buildThreadTodoMessageOrigin: vi.fn(async () => ({ kind: "user" as const })),
      };
      installThreadTodoRuntime({
        registry: registry as never,
        broadcast: vi.fn(),
        listProjects: async () => [],
        readDefaultMergeMethod: () => "squash",
        registerContinueAfter,
        feed: { loadOwners: async () => [], managedThreadKeys: () => new Set<string>(), onDelta: vi.fn() },
      });
      const router = buildPwrAgentThreadTodoToolRouter(registeredTodoHandler);

      // 1. add_todo with omitted backend/threadId defaults to raising thread + title
      const added = await router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "parent-1",
          turnId: "t-1",
          callId: "c-1",
          namespace: "pwragent",
          tool: "add_todo",
          arguments: {
            title: "Follow up on pointer-travel",
            key: "pointer-travel",
            action: {
              type: "start_thread",
              prompt: "Build fix on top of #688.",
              continueAfter: {
                conditions: [{ when: "pr_merged", prUrl: "https://github.com/pwrdrvr/PwrGit/pull/688" }],
                continuation: "Rebase onto main and open PR.",
              },
            },
          },
        },
      });
      expect(added.success).toBe(true);
      const addedText = added.contentItems[0]?.type === "inputText" ? added.contentItems[0].text : "";
      const todoId = (JSON.parse(addedText) as { todo: { id: string } }).todo.id;
      const stored = getThreadTodoService().get(todoId);
      expect(stored.action).toMatchObject({
        type: "start_thread",
        continueAfter: {
          conditions: [{
            backend: "codex",
            threadId: "parent-1",
            when: "pr_merged",
            prUrl: "https://github.com/pwrdrvr/PwrGit/pull/688",
            title: "Parent PR #688",
          }],
          continuation: "Rebase onto main and open PR.",
        },
      });

      // 2. update_todo replaces continueAfter; clearContinueAfter removes it
      const updated = await router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "parent-1",
          turnId: "t-1",
          callId: "c-2",
          namespace: "pwragent",
          tool: "update_todo",
          arguments: {
            key: "pointer-travel",
            continueAfter: {
              conditions: [{ when: "pr_merged", prUrl: "https://github.com/pwrdrvr/PwrGit/pull/688" }],
              continuation: "Rebase onto main, re-run tests, and open PR.",
            },
          },
        },
      });
      expect(updated.success).toBe(true);

      // 3. Operator runs Start thread -> prompt note added, registerContinueAfter runs AFTER startTurn
      const done = await getThreadTodoService().runAction(todoId, { seenExecutionMode: "inherit" });
      expect(done.status).toBe("done");
      expect(order).toEqual(["startTurn", "registerContinueAfter"]);
      const firstPrompt = (startTurn.mock.calls[0] as unknown as [{ input: { text: string }[] }])[0].input[0]!.text;
      expect(firstPrompt).toContain("PR #688 is merged");
      expect(registerContinueAfter).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "started-1",
        continueAfter: expect.objectContaining({
          continuation: "Rebase onto main, re-run tests, and open PR.",
        }),
      });

      // 4. clearContinueAfter removes it cleanly on a new card
      const added2 = await router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "parent-1",
          turnId: "t-1",
          callId: "c-3",
          namespace: "pwragent",
          tool: "add_todo",
          arguments: {
            title: "Second follow-up",
            key: "second",
            action: {
              type: "start_thread",
              prompt: "Do work.",
              continueAfter: {
                conditions: [{ when: "pr_merged" }],
                continuation: "Open PR.",
              },
            },
          },
        },
      });
      const added2Text = added2.contentItems[0]?.type === "inputText" ? added2.contentItems[0].text : "";
      const todo2Id = (JSON.parse(added2Text) as { todo: { id: string } }).todo.id;
      const cleared = await router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "parent-1",
          turnId: "t-1",
          callId: "c-4",
          namespace: "pwragent",
          tool: "update_todo",
          arguments: { key: "second", clearContinueAfter: true },
        },
      });
      expect(cleared.success).toBe(true);
      const stored2 = getThreadTodoService().get(todo2Id);
      expect(stored2.action?.type === "start_thread" && stored2.action.continueAfter).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("reports an honest notice without prompt note when a card with continueAfter starts on another machine", async () => {
    const continueAfter: ResolvedInitialThreadContinueAfter = {
      conditions: [{
        backend: "codex",
        threadId: "parent-1",
        when: "pr_merged",
        prUrl: "https://github.com/pwrdrvr/PwrGit/pull/688",
      }],
      continuation: "Rebase and open PR.",
    };
    const registerContinueAfter = vi.fn(async () => {});
    const federation = vi.fn(async (req: { operation: string; args?: Record<string, unknown> }) => {
      if (req.operation === "list_instance_projects") {
        return {
          ok: true as const,
          data: {
            instanceLabel: "Remote Mac",
            complete: true,
            projects: [{ key: "directory:/remote/PwrGit", kind: "directory" as const, label: "PwrGit", path: "/remote/PwrGit" }],
          },
        };
      }
      return {
        ok: true as const,
        data: {
          backend: "codex" as const,
          threadId: "remote-child-1",
          isLocal: false,
          instanceId: "peer-1",
          instanceLabel: "Remote Mac",
          workMode: "worktree" as const,
        },
      };
    });
    const runners = createThreadTodoRunners({
      registry: {
        readThreadHandoffSettings: vi.fn(async () => ({ executionMode: "default" as const })),
        readBackendModelOptions: vi.fn(async () => ({ models: [] })),
        listBackends: vi.fn(async () => ({ backends: [], fetchedAt: 0 })),
        renameThread: vi.fn(),
        startThread: vi.fn(),
        startTurn: vi.fn(),
        sendThreadTodoMessage: vi.fn(),
        buildThreadTodoMessageOrigin: vi.fn(async () => ({ kind: "user" as const })),
      } as never,
      federation: federation as never,
      registerContinueAfter,
      isLocalInstance: () => false,
    });

    const result = await runners.startThreadOnInstance!({
      instanceId: "peer-1",
      sourceBackend: "codex",
      sourceThreadId: "parent-1",
      project: { key: "directory:/local/PwrGit", label: "PwrGit", path: "/local/PwrGit" },
      crossProject: false,
      action: { type: "start_thread", prompt: "Fix bug.", continueAfter },
      todo: { id: "todo-1", title: "Fix bug" },
    });

    expect(registerContinueAfter).not.toHaveBeenCalled();
    expect(result.notice).toContain("Continue After was not registered because the thread started on Remote Mac");
    const createCall = federation.mock.calls.find(([req]) => req.operation === "create_instance_thread")?.[0];
    expect((createCall?.args as { input?: string } | undefined)?.input).toBe("Fix bug.");
  });

  it("rejects add_todo action.continueAfter on non-start_thread action types and reports notice when redirecting a start_thread card to an existing thread", async () => {
    const db = openInMemoryStateDb();
    vi.spyOn(appState, "getAppStateDb").mockReturnValue(db);
    try {
      let registeredTodoHandler: Parameters<typeof buildPwrAgentThreadTodoToolRouter>[0];
      const sendThreadTodoMessage = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "existing-1",
        disposition: "queued" as const,
        summary: "Queued message for Existing thread",
      }));
      const registry = {
        setPwrAgentThreadTodoHandler: vi.fn((h) => { registeredTodoHandler = h; }),
        onEvent: vi.fn(() => () => {}),
        getThreadInfo: vi.fn(() => ({ title: "Parent PR #688" })),
        resolveThreadWorkspaceCwd: vi.fn(async () => "/tmp/repo"),
        resolveThreadPrimaryDirectory: vi.fn(async () => undefined),
        readThreadHandoffSettings: vi.fn(async () => ({ executionMode: "default" as const })),
        readBackendModelOptions: vi.fn(async () => ({ models: [] })),
        listBackends: vi.fn(async () => ({ backends: [] })),
        renameThread: vi.fn(async () => ({})),
        startThread: vi.fn(),
        startTurn: vi.fn(),
        sendThreadTodoMessage,
        buildThreadTodoMessageOrigin: vi.fn(async () => ({ kind: "user" as const })),
      };
      installThreadTodoRuntime({
        registry: registry as never,
        broadcast: vi.fn(),
        listProjects: async () => [],
        readDefaultMergeMethod: () => "squash",
        registerContinueAfter: vi.fn(async () => {}),
        feed: { loadOwners: async () => [], managedThreadKeys: () => new Set<string>(), onDelta: vi.fn() },
      });
      const router = buildPwrAgentThreadTodoToolRouter(registeredTodoHandler);

      // Non-start_thread actions reject action.continueAfter instead of silently discarding it
      for (const action of [
        {
          type: "send_message",
          prompt: "Follow up.",
          target: { backend: "codex", threadId: "existing-1" },
          continueAfter: { conditions: [{ when: "pr_merged" }], continuation: "Open PR." },
        },
        {
          type: "start_review",
          continueAfter: { conditions: [{ when: "pr_merged" }], continuation: "Open PR." },
        },
        {
          type: "merge_pull_request",
          pullRequest: "688",
          continueAfter: { conditions: [{ when: "pr_merged" }], continuation: "Open PR." },
        },
        {
          type: "add_forge_hands_off_rule",
          repository: "pwrdrvr/PwrGit",
          continueAfter: { conditions: [{ when: "pr_merged" }], continuation: "Open PR." },
        },
      ]) {
        const rejected = await router.handleDynamicToolCall({
          backend: "codex",
          call: {
            threadId: "parent-1",
            turnId: "t-1",
            callId: `c-reject-${action.type}`,
            namespace: "pwragent",
            tool: "add_todo",
            arguments: { title: "Invalid continueAfter", action },
          },
        });
        expect(rejected.success).toBe(false);
        const text = rejected.contentItems[0]?.type === "inputText" ? rejected.contentItems[0].text : "";
        expect(text).toContain("action.continueAfter is only supported when action.type is start_thread");
      }

      // Redirecting a start_thread card with continueAfter via Send to thread reports an explicit notice
      const added = await router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "parent-1",
          turnId: "t-1",
          callId: "c-send-redirect",
          namespace: "pwragent",
          tool: "add_todo",
          arguments: {
            title: "Stacked fix",
            action: {
              type: "start_thread",
              prompt: "Build fix on top of #688.",
              continueAfter: {
                conditions: [{ when: "pr_merged", prUrl: "https://github.com/pwrdrvr/PwrGit/pull/688" }],
                continuation: "Rebase and open PR.",
              },
            },
          },
        },
      });
      expect(added.success).toBe(true);
      const addedText = added.contentItems[0]?.type === "inputText" ? added.contentItems[0].text : "";
      const todoId = (JSON.parse(addedText) as { todo: { id: string } }).todo.id;

      const done = await getThreadTodoService().runAction(todoId, {
        messageTarget: { backend: "codex", threadId: "existing-1", title: "Existing thread" },
      });
      expect(done.status).toBe("done");
      expect(done.result).toContain("Continue After was not registered because the request was sent to an existing thread.");
    } finally {
      db.close();
    }
  });
});
