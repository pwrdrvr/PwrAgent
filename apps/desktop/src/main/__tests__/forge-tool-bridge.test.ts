import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FORGE_AGENT_TOOL_POLICY,
  FORGE_AGENT_TOOL_ACCESS_LEVELS,
  type AgentEvent,
  type AppServerPendingRequestNotification,
  type ForgeAgentToolPolicy,
  type NavigationSnapshot,
  type PrSummary,
} from "@pwragent/shared";
import type { ForgeReadHandler } from "../agent-tools/pwragent-forge-agent-tools";
import type { ForgePrToolHandler } from "../agent-tools/pwragent-forge-pr-agent-tools";
import {
  FORGE_APPROVAL_WITHDRAWN_TODO_KEY,
  FORGE_TOOL_REQUEST_ID_PREFIX,
} from "../app-server/backend-registry-runtime-helpers";
import type { PendingServerRequest } from "../app-server/backend-registry-types";
import {
  ForgeToolBridge,
  type ForgeToolBridgeHandlers,
  type ForgeToolBridgeHost,
} from "../app-server/forge-tool-bridge";
import type { RegistryContext } from "../app-server/registry-context";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";

const repository: ForgeRepository = { provider: "github", host: "github.com", owner: "fixture", repo: "project" };
const callContext = { backend: "codex", threadId: "thread-1", turnId: "turn-1", transport: "mcp" } as const;

function createBridge(options: {
  handlers?: ForgeToolBridgeHandlers;
  host?: Partial<ForgeToolBridgeHost>;
} = {}) {
  const events: AgentEvent[] = [];
  const published: AgentEvent[] = [];
  const pendingServerRequests = new Map<string, PendingServerRequest>();
  const addThreadPullRequestReference = vi.fn(async (params: { pr: PrSummary }) => ({ prs: [params.pr] }));
  const context = {
    stores: {
      threads: {
        getThreadOverlayState: async () => undefined,
        getThreadOverlayStates: async () => [],
        getThreadMetadata: async () => undefined,
      },
      pullRequests: { addThreadPullRequestReference },
    },
    providers: {
      codex: { reportedModelProviderForThread: () => "openai" },
      claude: { livePermissionMode: () => undefined },
      acp: { getSession: () => undefined, getInstalledAgent: () => undefined },
    },
    lifecycle: { closed: false },
    emit: async (event: AgentEvent) => { events.push(event); },
  } as unknown as RegistryContext;
  const host: ForgeToolBridgeHost = {
    pendingServerRequests,
    activeCodexTurnCollaborationModes: new Map(),
    threadTodoHandler: undefined,
    resolveCodexModelProvidersFn: () => [],
    findHeadlessAutomationTurnForRequest: () => undefined,
    getActiveTurnForThread: () => undefined,
    isTaskMonitorThread: () => false,
    taskMonitorForThread: () => undefined,
    isMcpGatewayFullAccess: async () => false,
    resolveCodexToolCallExecutionMode: async () => "default",
    resolveClaudeToolCallExecutionMode: async () => "default",
    readThreadInspectionSummaryForMutation: async () => undefined,
    publishLocalEvent: async (event) => { published.push(event); },
    ...options.host,
  };
  const bridge = new ForgeToolBridge(context, options.handlers ?? {}, host);
  return { bridge, events, published, pendingServerRequests, addThreadPullRequestReference };
}

function answerOnlyCard(pendingServerRequests: Map<string, PendingServerRequest>, persist?: "session"): void {
  expect(pendingServerRequests.size).toBe(1);
  const [pending] = pendingServerRequests.values();
  pending!.resolve({ action: "accept", content: {}, _meta: persist ? { persist } : null } as never);
}

describe("ForgeToolBridge", () => {
  describe("policy gate", () => {
    it("forwards a read exactly when the family is on and Read is not Off", async () => {
      await fc.assert(fc.asyncProperty(
        fc.boolean(),
        fc.constantFrom(...FORGE_AGENT_TOOL_ACCESS_LEVELS),
        async (enabled, read) => {
          const policy: ForgeAgentToolPolicy = {
            ...structuredClone(DEFAULT_FORGE_AGENT_TOOL_POLICY),
            enabled,
          };
          policy.access.read = read;
          const forgeRead = vi.fn<ForgeReadHandler>(async () => ({ ok: true }));
          const { bridge } = createBridge({
            handlers: { forgeReadHandler: forgeRead, forgeToolPolicyResolver: () => policy },
          });
          const call = bridge.gatedForgeReadHandler("get_forge_status", {}, callContext);
          if (enabled && read !== "off") {
            await expect(call).resolves.toEqual({ ok: true });
            expect(forgeRead).toHaveBeenCalledOnce();
          } else {
            await expect(call).rejects.toMatchObject({ code: "tools_disabled" });
            expect(forgeRead).not.toHaveBeenCalled();
          }
        },
      ));
    });

    it("treats an unreadable policy as off", async () => {
      const forgeRead = vi.fn<ForgeReadHandler>(async () => ({ ok: true }));
      const { bridge } = createBridge({
        handlers: {
          forgeReadHandler: forgeRead,
          forgeToolPolicyResolver: () => { throw new Error("fixture policy unreadable"); },
        },
      });
      expect(bridge.resolveForgeToolPolicy().enabled).toBe(false);
      await expect(bridge.gatedForgeReadHandler("get_forge_status", {}, callContext))
        .rejects.toMatchObject({ code: "tools_disabled" });
      expect(forgeRead).not.toHaveBeenCalled();
    });

    it("reports a missing read handler as unavailable", async () => {
      const { bridge } = createBridge();
      await expect(bridge.gatedForgeReadHandler("get_forge_status", {}, callContext))
        .rejects.toMatchObject({ code: "unavailable" });
    });
  });

  describe("write approval", () => {
    function commentsBridge() {
      const policy = structuredClone(DEFAULT_FORGE_AGENT_TOOL_POLICY);
      policy.access.comments = "ask";
      const github = vi.fn<ForgePrToolHandler>(async () => ({ ok: true }));
      let target = repository;
      const fixture = createBridge({
        handlers: {
          forgePrToolHandler: github,
          forgePrToolPreflight: async (_operation, args) => ({ repository: target, args }),
          forgeToolPolicyResolver: () => policy,
        },
      });
      return { ...fixture, github, setRepository: (next: ForgeRepository) => { target = next; } };
    }

    it("asks on a card, then reuses a conversation grant for the same tool and repository", async () => {
      const { bridge, events, pendingServerRequests, github, setRepository } = commentsBridge();
      const args = { number: 9, body: "Looks good." };

      const first = bridge.gatedForgePrToolHandler("add_issue_comment", args, callContext);
      await vi.waitFor(() => expect(pendingServerRequests.size).toBe(1));
      const card = events.find((event) => event.notification.method === "mcpServer/elicitation/request");
      const params = card?.notification.params as { requestId: string; serverName: string; _meta: Record<string, unknown> };
      expect(params.requestId.startsWith(FORGE_TOOL_REQUEST_ID_PREFIX)).toBe(true);
      expect(params.serverName).toBe("GitHub");
      expect(params._meta.connector_name).toBe("fixture/project");
      answerOnlyCard(pendingServerRequests, "session");
      await expect(first).resolves.toEqual({ ok: true });
      expect(pendingServerRequests.size).toBe(0);
      expect(github).toHaveBeenLastCalledWith("add_issue_comment", { ...args, repository }, callContext);

      const cardsBefore = events.length;
      await expect(bridge.gatedForgePrToolHandler("add_issue_comment", args, callContext)).resolves.toEqual({ ok: true });
      expect(events.length).toBe(cardsBefore);

      // A grant covers one repository, never every repository the thread links.
      setRepository({ ...repository, repo: "other" });
      const other = bridge.gatedForgePrToolHandler("add_issue_comment", args, callContext);
      await vi.waitFor(() => expect(pendingServerRequests.size).toBe(1));
      answerOnlyCard(pendingServerRequests);
      await expect(other).resolves.toEqual({ ok: true });
      expect(github).toHaveBeenCalledTimes(3);
    });

    it("refuses a declined call without running it", async () => {
      const { bridge, pendingServerRequests, github } = commentsBridge();
      const call = bridge.gatedForgePrToolHandler("add_issue_comment", { number: 9, body: "No." }, callContext);
      await vi.waitFor(() => expect(pendingServerRequests.size).toBe(1));
      const [pending] = pendingServerRequests.values();
      pending!.resolve({ action: "decline", content: null, _meta: null } as never);
      await expect(call).rejects.toMatchObject({ code: "declined" });
      expect(github).not.toHaveBeenCalled();
    });

    it("refuses every write in a Codex plan turn before asking", async () => {
      const policy = structuredClone(DEFAULT_FORGE_AGENT_TOOL_POLICY);
      policy.access.comments = "allow";
      const github = vi.fn<ForgePrToolHandler>(async () => ({ ok: true }));
      const { bridge, events } = createBridge({
        handlers: { forgePrToolHandler: github, forgeToolPolicyResolver: () => policy },
        host: { activeCodexTurnCollaborationModes: new Map([["codex:thread-1:turn-1", "plan" as const]]) },
      });
      await expect(bridge.gatedForgePrToolHandler("add_issue_comment", { number: 9, body: "x" }, callContext))
        .rejects.toMatchObject({ code: "plan_mode" });
      expect(github).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });
  });

  describe("Job Monitor threads", () => {
    const monitor = { parentBackend: "claude", parentThreadId: "parent-1", parentTurnId: "parent-turn" };

    it("reads the parent thread's forge state while monitoring is active", async () => {
      const forgeRead = vi.fn<ForgeReadHandler>(async () => ({ ok: true }));
      const { bridge } = createBridge({
        handlers: { forgeReadHandler: forgeRead },
        host: { isTaskMonitorThread: () => true, taskMonitorForThread: () => monitor as never },
      });
      await bridge.gatedForgeReadHandler("get_forge_status", {}, callContext);
      expect(forgeRead).toHaveBeenCalledWith("get_forge_status", {}, {
        ...callContext, backend: "claude", threadId: "parent-1", turnId: "parent-turn",
      });
    });

    it("refuses writes and reads after monitoring ends", async () => {
      const github = vi.fn<ForgePrToolHandler>(async () => ({ ok: true }));
      const forgeRead = vi.fn<ForgeReadHandler>(async () => ({ ok: true }));
      const active = createBridge({
        handlers: { forgePrToolHandler: github, forgeReadHandler: forgeRead },
        host: { isTaskMonitorThread: () => true, taskMonitorForThread: () => monitor as never },
      });
      await expect(active.bridge.gatedForgePrToolHandler("add_issue_comment", { number: 9, body: "x" }, callContext))
        .rejects.toMatchObject({ code: "forbidden" });
      const ended = createBridge({
        handlers: { forgeReadHandler: forgeRead },
        host: { isTaskMonitorThread: () => true, taskMonitorForThread: () => ({ ...monitor, finalizationStarted: true }) as never },
      });
      await expect(ended.bridge.gatedForgeReadHandler("get_forge_status", {}, callContext))
        .rejects.toMatchObject({ code: "forbidden" });
      expect(github).not.toHaveBeenCalled();
      expect(forgeRead).not.toHaveBeenCalled();
    });

    it("offers a monitor only the read-only forge tools", () => {
      const { bridge } = createBridge();
      const tools = bridge.buildTaskMonitorForgeToolDefinitions(DEFAULT_FORGE_AGENT_TOOL_POLICY);
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.annotations?.destructiveHint).not.toBe(true);
      }
    });
  });

  describe("peer reads", () => {
    it("reads a local thread with the local handler", async () => {
      const local = vi.fn<ForgeReadHandler>(async () => ({ ok: true }));
      const routed = vi.fn<ForgeReadHandler>(async () => ({ routed: true }));
      const { bridge } = createBridge({ handlers: { localForgeReadHandler: local, forgeReadHandler: routed } });
      await expect(bridge.readForgeForPeer({ operation: "get_forge_status", args: {}, backend: "codex", threadId: "thread-1" }))
        .resolves.toEqual({ ok: true });
      expect(local).toHaveBeenCalledWith(
        "get_forge_status",
        { backend: "codex", threadId: "thread-1" },
        { backend: "codex", threadId: "thread-1", transport: "mcp", signal: undefined },
      );
      expect(routed).not.toHaveBeenCalled();
    });

    it("refuses a peer read that names another instance", async () => {
      const local = vi.fn<ForgeReadHandler>(async () => ({ ok: true }));
      const { bridge } = createBridge({ handlers: { localForgeReadHandler: local } });
      await expect(bridge.readForgeForPeer({
        operation: "get_forge_status", args: { instanceId: "peer" }, backend: "codex", threadId: "thread-1",
      })).rejects.toMatchObject({ code: "invalid_arguments" });
      expect(local).not.toHaveBeenCalled();
    });
  });

  describe("withdrawn approvals", () => {
    const withdrawn: AppServerPendingRequestNotification = {
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        requestId: `${FORGE_TOOL_REQUEST_ID_PREFIX}fixture`,
        serverName: "GitHub",
        mode: "form",
        message: "Comment on pull request #9",
        requestedSchema: { type: "object", properties: {} },
        _meta: { connector_name: "fixture/project" },
      },
    } as AppServerPendingRequestNotification;

    it("leaves the thread a reminder of what was asked", async () => {
      const add = vi.fn(async () => ({ todo: {} as never, created: true }));
      const { bridge } = createBridge({ host: { threadTodoHandler: { add } as never } });
      await bridge.raiseWithdrawnForgeApprovalTodo("codex", "thread-1", [withdrawn]);
      expect(add).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1" }, {
        key: FORGE_APPROVAL_WITHDRAWN_TODO_KEY,
        title: "Reply to retry the withdrawn GitHub request",
        detail: "The agent asked “Comment on pull request #9” for fixture/project. Its turn ended before you answered, so the request was withdrawn and nothing ran.",
      });
    });

    it("never fails the terminal path when the card cannot be raised", async () => {
      const add = vi.fn(async () => { throw new Error("fixture to-do store closed"); });
      const { bridge } = createBridge({ host: { threadTodoHandler: { add } as never } });
      await expect(bridge.raiseWithdrawnForgeApprovalTodo("codex", "thread-1", [withdrawn])).resolves.toBeUndefined();
      const silent = createBridge();
      await expect(silent.bridge.raiseWithdrawnForgeApprovalTodo("codex", "thread-1", [withdrawn])).resolves.toBeUndefined();
    });
  });

  describe("PR bindings", () => {
    it("reports an unset mediator instead of answering for it", async () => {
      const { bridge } = createBridge();
      expect(bridge.isPullRequestLocallyMonitored("github:fixture/project#9")).toBe(false);
      expect(() => bridge.ownedProjectForgeAutomation()).toThrow("Forge Automation service is not available yet.");
      await expect(bridge.refreshOwnedThreadPullRequests({} as never)).rejects.toThrow("Pull-request refresh service is not available yet.");
      await expect(bridge.detachThreadPullRequest({} as never)).rejects.toThrow("Pull-request detach service is not available yet.");
      await expect(bridge.manageThreadPrWatchesForPeer({} as never)).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
    });

    it("delegates to a binding set after construction", async () => {
      const { bridge } = createBridge();
      const refresh = vi.fn(async () => ({ ok: true }) as never);
      const detach = vi.fn(async () => ({ ok: true }) as never);
      bridge.setLocalPullRequestAuthorityResolver((prKey) => prKey === "mine");
      bridge.setThreadPullRequestRefreshHandler(refresh);
      bridge.setThreadPullRequestDetachHandler(detach);
      expect(bridge.isPullRequestLocallyMonitored("mine")).toBe(true);
      expect(bridge.isPullRequestLocallyMonitored("peer")).toBe(false);
      await bridge.refreshOwnedThreadPullRequests({ backend: "codex", threadId: "thread-1" } as never);
      await bridge.detachThreadPullRequest({ backend: "codex", threadId: "thread-1" } as never);
      expect(refresh).toHaveBeenCalledOnce();
      expect(detach).toHaveBeenCalledOnce();
    });
  });

  describe("PR attachment", () => {
    it("refuses an unknown backend or thread before touching the store", async () => {
      const { bridge, addThreadPullRequestReference } = createBridge();
      await expect(bridge.handleAttachThreadPullRequestInspectionRequest({ backend: "nope" as never, threadId: "thread-1" }))
        .resolves.toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
      await expect(bridge.handleAttachThreadPullRequestInspectionRequest({ backend: "codex", threadId: "missing", number: 9 }))
        .resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(addThreadPullRequestReference).not.toHaveBeenCalled();
    });

    it("stores a named PR and publishes the canonical list", async () => {
      const summary = { linkedDirectories: [], pullRequests: [] };
      const { bridge, published, addThreadPullRequestReference } = createBridge({
        handlers: { threadPullRequestCanonicalizer: async (prs) => prs.map((pr) => ({ ...pr, state: "merged" as const })) },
        host: { readThreadInspectionSummaryForMutation: async () => summary as never },
      });
      const result = await bridge.handleAttachThreadPullRequestInspectionRequest({
        backend: "codex", threadId: "thread-1", url: "https://github.com/fixture/project/pull/9",
      });
      expect(result).toMatchObject({ ok: true });
      expect(addThreadPullRequestReference).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        pr: expect.objectContaining({ provider: "github.com", org: "fixture", repo: "project", number: 9, state: "pending" }),
      });
      expect(published).toEqual([{
        backend: "codex",
        notification: {
          method: "thread/pullRequests/updated",
          params: { threadId: "thread-1", prs: [expect.objectContaining({ number: 9, state: "merged" })] },
        },
      }]);
    });
  });

  describe("navigation PR canonicalization", () => {
    const thread = (id: string, prs?: PrSummary[]) => ({ id, source: "codex", prs }) as unknown as NavigationSnapshot["threads"][number];
    const pr = { provider: "github", org: "fixture", repo: "project", number: 9, state: "pending" } as PrSummary;

    it("adds the primary repository and canonical PR rows", async () => {
      const { bridge } = createBridge({
        handlers: {
          threadPrimaryGitRepositoryReader: (_backend, threadId) => `github.com/fixture/${threadId}`,
          threadPullRequestCanonicalizer: async (prs) => prs.map((row) => ({ ...row, state: "merged" as const })),
        },
      });
      const threads = await bridge.canonicalizeNavigationThreadPullRequests([thread("a", [pr]), thread("b")]);
      expect(threads.map((row) => row.primaryGitRepository)).toEqual(["github.com/fixture/a", "github.com/fixture/b"]);
      expect(threads[0]!.prs?.[0]?.state).toBe("merged");
      expect(threads[1]!.prs).toBeUndefined();
    });

    it("serves the stored rows when the status cache cannot be read", async () => {
      const { bridge } = createBridge({
        handlers: { threadPullRequestCanonicalizer: async () => { throw new Error("fixture cache read failed"); } },
      });
      const input = [thread("a", [pr])];
      await expect(bridge.canonicalizeNavigationThreadPullRequests(input)).resolves.toBe(input);
    });
  });

  describe("project labels", () => {
    it("falls back to the repository name when the label lookup is slow", async () => {
      vi.useFakeTimers();
      try {
        const { bridge } = createBridge({ handlers: { forgeProjectLabelResolver: () => new Promise(() => {}) } });
        const label = bridge.ruleRepositoryProjectLabel("github.com/fixture/project", "fixture/project");
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(label).resolves.toBe("fixture/project");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
