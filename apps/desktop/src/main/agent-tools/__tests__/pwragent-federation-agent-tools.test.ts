import { describe, expect, it, vi } from "vitest";
import {
  PWRAGENT_FEDERATION_UNAVAILABLE_MESSAGE,
  buildPwrAgentFederationToolRouter,
} from "../pwragent-federation-agent-tools";

describe("pwragent federation agent tools", () => {
  it("projects the federation tools under the unified pwragent namespace", () => {
    const router = buildPwrAgentFederationToolRouter(undefined);

    expect(router.buildDynamicToolSpecs()).toEqual([
      {
        type: "namespace",
        name: "pwragent",
        description: expect.stringContaining("PwrAgent"),
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: "function",
            name: "list_federation_instances",
            deferLoading: false,
            description: expect.stringContaining("known PwrAgent peers"),
            inputSchema: expect.objectContaining({
              type: "object",
              additionalProperties: false,
              properties: expect.objectContaining({
                query: expect.objectContaining({ type: "string" }),
                limit: expect.objectContaining({ minimum: 1, maximum: 100 }),
                cursor: expect.objectContaining({ type: "string" }),
                includeLoad: expect.objectContaining({ type: "boolean" }),
              }),
            }),
          }),
          expect.objectContaining({
            type: "function",
            name: "list_instance_projects",
            deferLoading: false,
            description: expect.stringContaining("list_federation_instances"),
            inputSchema: expect.objectContaining({
              required: ["instanceId"],
            }),
          }),
          expect.objectContaining({
            type: "function",
            name: "create_instance_thread",
            deferLoading: false,
            description: expect.stringContaining("~/.pwragent/AGENTS.md"),
            inputSchema: expect.objectContaining({
              required: ["instanceId", "projectKey"],
              properties: expect.objectContaining({
                workMode: expect.objectContaining({
                  enum: ["local", "worktree"],
                }),
              }),
            }),
          }),
          expect.objectContaining({
            type: "function",
            name: "search_federation_threads",
            deferLoading: false,
            description: expect.stringContaining("local and connected PwrAgent instances"),
            inputSchema: expect.objectContaining({
              required: ["query"],
              properties: expect.objectContaining({
                backend: expect.objectContaining({ type: "string" }),
                includeArchived: expect.objectContaining({ type: "boolean" }),
                projectKeys: expect.objectContaining({ type: "array" }),
                updatedAfter: expect.objectContaining({ type: "integer" }),
                updatedBefore: expect.objectContaining({ type: "integer" }),
                scope: expect.objectContaining({
                  enum: ["all", "local", "remote"],
                }),
              }),
            }),
          }),
        ]),
      },
    ]);
  });

  it("reports the unavailable message when no handler is wired", async () => {
    const router = buildPwrAgentFederationToolRouter(undefined);

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent",
          tool: "list_federation_instances",
          arguments: {},
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
              message: PWRAGENT_FEDERATION_UNAVAILABLE_MESSAGE,
            },
            null,
            2,
          ),
        },
      ],
    });
  });

  it.each([
    {
      name: "rejects a blank instanceId before dispatching list_instance_projects",
      tool: "list_instance_projects",
      arguments: { instanceId: "   " },
    },
    {
      name: "rejects an unknown workMode before dispatching create_instance_thread",
      tool: "create_instance_thread",
      arguments: {
        instanceId: "pwr_studio",
        projectKey: "dir:/repo",
        workMode: "container",
      },
    },
    {
      name: "rejects an unknown scope before dispatching search_federation_threads",
      tool: "search_federation_threads",
      arguments: { query: "recorder crash", scope: "nearby" },
    },
    {
      name: "rejects an out-of-range list limit before dispatching list_federation_instances",
      tool: "list_federation_instances",
      arguments: { limit: 500 },
    },
    {
      name: "rejects a non-boolean includeLoad before dispatching list_federation_instances",
      tool: "list_federation_instances",
      arguments: { includeLoad: "yes" },
    },
    {
      name: "rejects an out-of-range limit before dispatching search_federation_threads",
      tool: "search_federation_threads",
      arguments: { query: "recorder crash", limit: 500 },
    },
  ] as const)("$name", async ({ tool, arguments: callArguments }) => {
    const handler = vi.fn();
    const router = buildPwrAgentFederationToolRouter(handler);

    const response = await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "pwragent",
        tool,
        arguments: callArguments,
      },
    });

    expect(response).toMatchObject({ success: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("normalizes list_federation_instances filter args before dispatch", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        federationEnabled: true,
        instances: [],
        totalCount: 0,
      },
    }));
    const router = buildPwrAgentFederationToolRouter(handler);

    await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "pwragent",
        tool: "list_federation_instances",
        arguments: { query: " linux ", limit: 10, includeLoad: true },
      },
    });

    expect(handler).toHaveBeenCalledWith({
      operation: "list_federation_instances",
      context: {
        backend: "codex",
        threadId: "thread-1",
        callId: "call-1",
        turnId: "turn-1",
      },
      args: { query: "linux", limit: 10, includeLoad: true },
    });
  });

  it("normalizes create_instance_thread args before dispatch", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        instanceId: "pwr_studio",
        instanceLabel: "Studio Mac",
        isLocal: false,
        backend: "codex" as const,
        threadId: "thread-2",
        executionMode: "default" as const,
        workMode: "worktree" as const,
        groupingMode: "none" as const,
        message: "Created thread in PwrSnap on Studio Mac.",
      },
    }));
    const router = buildPwrAgentFederationToolRouter(handler);

    const response = await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "pwragent",
        tool: "create_instance_thread",
        arguments: {
          instanceId: " pwr_studio ",
          projectKey: " dir:/Users/op/pwrsnap ",
          input: " Fix the recorder crash ",
          workMode: "worktree",
          branchName: " origin/main ",
          groupingMode: "subthread",
          fastMode: true,
        },
      },
    });

    expect(response).toMatchObject({ success: true });
    expect(handler).toHaveBeenCalledWith({
      operation: "create_instance_thread",
      context: {
        backend: "codex",
        threadId: "thread-1",
        callId: "call-1",
        turnId: "turn-1",
      },
      args: {
        instanceId: "pwr_studio",
        projectKey: "dir:/Users/op/pwrsnap",
        input: "Fix the recorder crash",
        workMode: "worktree",
        branchName: "origin/main",
        groupingMode: "subthread",
        fastMode: true,
      },
    });
  });

  it("normalizes search_federation_threads args before dispatch", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        query: "recorder crash",
        totalCount: 0,
        truncated: false,
        results: [],
        searchedInstances: [],
        failures: [],
      },
    }));
    const router = buildPwrAgentFederationToolRouter(handler);

    await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "pwragent",
        tool: "search_federation_threads",
        arguments: {
          query: " recorder crash ",
          backend: "codex",
          includeArchived: true,
          projectKeys: [" PwrAgent "],
          updatedAfter: 1_000,
          updatedBefore: 2_000,
          instanceId: " pwr_studio ",
          limit: 5,
        },
      },
    });

    expect(handler).toHaveBeenCalledWith({
      operation: "search_federation_threads",
      context: {
        backend: "codex",
        threadId: "thread-1",
        callId: "call-1",
        turnId: "turn-1",
      },
      args: {
        query: "recorder crash",
        backend: "codex",
        includeArchived: true,
        projectKeys: ["PwrAgent"],
        updatedAfter: 1_000,
        updatedBefore: 2_000,
        instanceId: "pwr_studio",
        limit: 5,
      },
    });
  });
});
