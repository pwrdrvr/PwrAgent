import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ErrorCode, ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  AgentToolRouter,
  PWRAGENT_AGENT_TOOL_NAMESPACE_DESCRIPTION,
} from "../agent-tool-router";
import {
  AgentToolMcpServer,
  buildPwrAgentMcpInstructions,
  type AgentToolMcpClientContext,
  type AgentToolMcpRegistration,
} from "../agent-tool-mcp-server";
import { agentToolSuccess } from "../agent-tool-definition";
import { resolveAgentToolCatalogs, type ResolvedAgentToolCatalog } from "../agent-tool-catalog-registry";
import { buildPwrAgentMessagingPdfToolRouter } from "../pwragent-messaging-agent-tools";
import { buildPwrAgentToolGuideDefinition, PWRAGENT_TOOL_GUIDE } from "../pwragent-tool-guide";
import { PWRAGENT_SKILLS_EXTENSION } from "../pwragent-workflow-skills";
import { searchPwrAgentTools } from "../pwragent-tool-search";
import { TestTokenMiserStore } from "../../__tests__/token-miser-test-store";
import { TokenMiserFocusedSummaries } from "../../token-miser/token-miser-focused";

describe("AgentToolMcpServer", () => {
  const openServers: AgentToolMcpServer[] = [];

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map(async (server) => server.close()));
  });

  it("advertises production read-only classifications and a callable guide over HTTP", async () => {
    const store = new TestTokenMiserStore("catalog-annotation-test");
    const focused = new TokenMiserFocusedSummaries({
      store,
      isEnabled: () => true,
      isFocusedEnabled: () => true,
      generateSummary: vi.fn(),
    });
    const catalogs = resolveAgentToolCatalogs({ tokenMiserStore: store, tokenMiserFocused: focused }, { taskMonitorRole: "all" });
    const server = new AgentToolMcpServer({
      resolveCatalogs: () => catalogs,
      resolveCallContext: (context) => context.threadId
        ? { backend: context.backend, threadId: context.threadId, turnId: "turn-1" }
        : undefined,
    });
    openServers.push(server);
    const registration = await server.registerClient({ backend: "acp:grok", threadId: "thread-1" });
    const client = await connectClient(registration);
    try {
      const { tools } = await client.listTools();
      const readOnlyNames = [
        "get_automation_run", "get_automation_run_artifact", "list_automation_runs",
        "list_automations", "summarize_automation_status",
        "search_threads", "read_thread", "get_thread_status",
        "get_forge_status", "list_ci_runs", "get_ci_run", "get_ci_job",
        "read_ci_job_log", "get_commit_checks", "list_ci_artifacts",
        "get_pull_request", "list_pull_requests", "list_pull_request_files", "get_pull_request_diff",
        "list_pull_request_reviews", "list_pull_request_review_threads", "get_issue", "list_issue_comments", "search_issues",
        "get_current_messaging_surface", "list_messaging_surfaces",
        "list_federation_instances", "list_instance_projects", "list_attention_threads", "search_federation_threads",
        "read_star_map_view", "read_operator_focus", "list_todos", "list_reviews",
        "search_mcp_tools", "search_token_miser_output", "read_token_miser_output",
        "read_token_miser_output_batch", "read_all_token_miser_output", "read_token_miser_segment",
        "read_tool_guide",
      ].sort();
      expect(tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name).sort()).toEqual(readOnlyNames);
      // Every advertised tool has an explicit classification, including mixed tools
      // with read actions (manage_pwragent, manage_mcp_connections, dependencies).
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(readOnlyNames.includes(tool.name));
      }
      expect(tools.map((tool) => tool.name)).not.toContain("tool_search");
      expect(tools.map((tool) => tool.name)).not.toContain("get_current_location");
      expect(tools.map((tool) => tool.name)).not.toContain("render_messaging_pdf_pages");

      expect(client.getInstructions()).toBe(buildPwrAgentMcpInstructions(true));
      expect(client.getInstructions()).toContain("skill://waiting-on-work/SKILL.md");
      expect(client.getInstructions()).toContain("watch_thread_pull_request and end the turn");
      expect(client.getInstructions()!.length).toBeLessThan(700);
      // Native dynamic-tool discovery reaches the same definition as MCP tools/list.
      expect(searchPwrAgentTools(catalogs.flatMap((catalog) => catalog.dynamicTools), "PwrAgent tool guide")[0]?.name).toBe("read_tool_guide");
      await expect(client.callTool({ name: "read_tool_guide", arguments: {} })).resolves.toMatchObject({
        content: [{ type: "text", text: PWRAGENT_TOOL_GUIDE }],
        structuredContent: { guide: PWRAGENT_TOOL_GUIDE },
      });
    } finally {
      await client.close();
    }
  });

  it("lists skill manifests and reads their exact bundled content through authenticated MCP before a turn", async () => {
    const resolveCallContext = vi.fn(() => undefined);
    const server = new AgentToolMcpServer({
      resolveCatalogs: () => [buildCatalog(new AgentToolRouter([buildPwrAgentToolGuideDefinition()]))],
      resolveCallContext,
    });
    openServers.push(server);
    const client = await connectClient(await server.registerClient({ backend: "claude" }));
    try {
      expect(client.getServerCapabilities()).toMatchObject({
        tools: {}, resources: {}, extensions: { [PWRAGENT_SKILLS_EXTENSION]: {} },
      });
      const toolsBefore = await client.listTools();
      const listed = await client.request({ method: "skills/list" }, ResultSchema);
      expect(listed.skills).toEqual([
        expect.objectContaining({ uri: "skill://waiting-on-work/SKILL.md" }),
        expect.objectContaining({ uri: "skill://tool-guide/SKILL.md" }),
      ]);
      const { resources } = await client.listResources();
      expect(resources.map((resource) => resource.uri)).toEqual([
        "skill://waiting-on-work/SKILL.md", "skill://tool-guide/SKILL.md",
      ]);
      for (const resource of resources) {
        const result = await client.request({
          method: "skills/get", params: { uri: resource.uri },
        }, ResultSchema);
        const { contents } = await client.readResource({ uri: resource.uri });
        expect(contents).toHaveLength(1);
        const content = contents[0];
        expect(content).toMatchObject({ uri: resource.uri, mimeType: "text/markdown" });
        if (!("text" in content)) {
          throw new Error("Expected a text skill resource.");
        }
        expect(content.text).toContain(`name: ${resource.name}\n`);
        expect(content.text).toContain(`description: ${resource.description}\n`);
        expect(Buffer.byteLength(content.text, "utf8")).toBe(resource.size);
        const manifest = {
          uri: resource.uri,
          frontmatter: { name: resource.name, description: resource.description },
          resources: [{
            uri: resource.uri,
            digest: `sha256:${createHash("sha256").update(content.text, "utf8").digest("hex")}`,
            size: resource.size,
          }],
        };
        expect(result.skill).toEqual(manifest);
        expect(listed.skills).toContainEqual(manifest);
        // The compatibility facade uses the same authored workflow bodies.
        expect(PWRAGENT_TOOL_GUIDE).toContain(content.text.split("\n---\n")[1].trim());
      }
      await expect(client.listResourceTemplates()).resolves.toEqual({ resourceTemplates: [] });
      await expect(client.listTools()).resolves.toEqual(toolsBefore);
      expect(resolveCallContext).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("rejects unknown skill/resource URIs, malformed skill requests, and unsupported cursors", async () => {
    const server = new AgentToolMcpServer({
      resolveCatalogs: () => [buildCatalog(new AgentToolRouter([buildPwrAgentToolGuideDefinition()]))],
      resolveCallContext: () => undefined,
    });
    openServers.push(server);
    const client = await connectClient(await server.registerClient({ backend: "acp:kimi" }));
    try {
      for (const uri of ["skill://unknown/SKILL.md", "skill://waiting-on-work/../../config.toml", "file:///etc/passwd"]) {
        await expect(client.request({ method: "skills/get", params: { uri } }, ResultSchema))
          .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
        await expect(client.readResource({ uri }))
          .rejects.toMatchObject({ code: -32002 });
      }
      for (const params of [undefined, {}, { uri: 42 }]) {
        await expect(client.request({ method: "skills/get", params }, ResultSchema))
          .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      }
      await expect(client.request({ method: "skills/list", params: { cursor: 42 } }, ResultSchema))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      for (const method of ["skills/list", "resources/list", "resources/templates/list"]) {
        await expect(client.request({ method, params: { cursor: "invalid" } }, ResultSchema))
          .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      }
    } finally {
      await client.close();
    }
  });

  it.each(["skills/list", "skills/get", "resources/list", "resources/read"])("requires bearer authentication for %s", async (method) => {
    const server = new AgentToolMcpServer({ resolveCatalogs: () => [], resolveCallContext: () => undefined });
    openServers.push(server);
    const registration = await server.registerClient({ backend: "claude" });
    const response = await fetch(registration.server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { uri: "skill://waiting-on-work/SKILL.md" } }),
    });
    expect(response.status).toBe(401);
  });

  it("keeps PDF rendering conservative on the separate advertised PDF MCP surface", async () => {
    const server = new AgentToolMcpServer({
      resolveCatalogs: () => [{ id: "messaging_context", router: buildPwrAgentMessagingPdfToolRouter(undefined) }],
      resolveCallContext: () => undefined,
    });
    openServers.push(server);
    const client = await connectClient(await server.registerClient({ backend: "codex" }));
    try {
      const { tools } = await client.listTools();
      expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]))).toEqual({
        inspect_messaging_pdfs: true,
        search_messaging_pdf_text: true,
        render_messaging_pdf_pages: false,
      });
      expect(client.getInstructions()).not.toContain("read_tool_guide");
      await expect(client.listResources()).resolves.toEqual({ resources: [] });
      await expect(client.request({ method: "skills/list" }, ResultSchema)).resolves.toEqual({ skills: [] });
    } finally {
      await client.close();
    }
  });

  it("serves and dispatches the dynamic-tool catalog over loopback MCP", async () => {
    const dispatch = vi.fn(() => agentToolSuccess({ status: "ok" }));
    const catalog = buildCatalog(
      new AgentToolRouter([
        {
          namespace: "pwragent",
          name: "inspect",
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          description: "Inspect test state.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
          },
          dispatch,
        },
      ]),
    );
    const server = new AgentToolMcpServer({
      resolveCallContext: (context) =>
        context.threadId
          ? {
              backend: context.backend,
              threadId: context.threadId,
              turnId: "turn-1",
            }
          : undefined,
      resolveCatalogs: () => [catalog],
    });
    openServers.push(server);
    const registration = await server.registerClient({
      backend: "acp:kimi",
    });
    registration.bindThread("thread-1");

    expect(registration.server).toMatchObject({
      name: "pwragent",
      type: "http",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u),
    });

    const client = await connectClient(registration);
    try {
      expect(client.getInstructions()).toBe(
        PWRAGENT_AGENT_TOOL_NAMESPACE_DESCRIPTION,
      );
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          {
            name: "inspect",
            description: "Inspect test state.",
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
        ],
      });
      await expect(
        client.callTool({
          name: "inspect",
          arguments: {},
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          status: "ok",
        },
      });
    } finally {
      await client.close();
    }

    expect(dispatch).toHaveBeenCalledWith(
      {},
      {
        backend: "acp:kimi",
        callId: expect.any(String),
        signal: expect.any(AbortSignal),
        threadId: "thread-1",
        transport: "mcp",
        turnId: "turn-1",
      },
    );
  });

  it("lists tools but rejects calls until the registration is thread-bound", async () => {
    const dispatch = vi.fn(() => agentToolSuccess({ status: "ok" }));
    const catalog = buildCatalog(
      new AgentToolRouter([
        {
          namespace: "pwragent",
          name: "inspect",
          description: "Inspect test state.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
          },
          dispatch,
        },
      ]),
    );
    const resolveCallContext = vi.fn(
      (context: AgentToolMcpClientContext) => ({
        backend: context.backend,
        threadId: context.threadId ?? "unrelated-thread",
        turnId: "turn-1",
      }),
    );
    const server = new AgentToolMcpServer({
      resolveCallContext,
      resolveCatalogs: () => [catalog],
    });
    openServers.push(server);
    const registration = await server.registerClient({
      backend: "acp:kimi",
    });
    const client = await connectClient(registration);

    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          {
            name: "inspect",
          },
        ],
      });
      await expect(
        client.callTool({
          name: "inspect",
          arguments: {},
        }),
      ).resolves.toMatchObject({
        isError: true,
        structuredContent: {
          code: "forbidden",
        },
      });
      expect(resolveCallContext).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();

      registration.bindThread("thread-1");
      await expect(
        client.callTool({
          name: "inspect",
          arguments: {},
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          status: "ok",
        },
      });
    } finally {
      await client.close();
    }

    expect(resolveCallContext).toHaveBeenCalledWith({
      backend: "acp:kimi",
      threadId: "thread-1",
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated, cross-origin, and inactive-turn calls", async () => {
    let active = false;
    const catalog = buildCatalog(
      new AgentToolRouter([
        {
          namespace: "pwragent",
          name: "inspect",
          annotations: { readOnlyHint: true },
          description: "Inspect test state.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
          },
          dispatch: () => agentToolSuccess({ status: "ok" }),
        },
      ]),
    );
    const server = new AgentToolMcpServer({
      resolveCallContext: (context) =>
        active && context.threadId
          ? {
              backend: context.backend,
              threadId: context.threadId,
              turnId: "turn-1",
            }
          : undefined,
      resolveCatalogs: () => [catalog],
    });
    openServers.push(server);
    const registration = await server.registerClient({
      backend: "acp:kimi",
      threadId: "thread-1",
    });

    await expect(
      fetch(registration.server.url, {
        method: "POST",
      }).then((response) => response.status),
    ).resolves.toBe(401);
    await expect(
      fetch(registration.server.url, {
        method: "POST",
        headers: {
          ...registrationHeaders(registration),
          Origin: "https://example.com",
        },
      }).then((response) => response.status),
    ).resolves.toBe(403);

    const client = await connectClient(registration);
    try {
      await expect(
        client.callTool({
          name: "inspect",
          arguments: {},
        }),
      ).resolves.toMatchObject({
        isError: true,
        structuredContent: {
          code: "forbidden",
        },
      });
      active = true;
      await expect(
        client.callTool({
          name: "inspect",
          arguments: {},
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          status: "ok",
        },
      });
    } finally {
      await client.close();
    }
  });

  it("rejects MCP calls denied by messaging RBAC", async () => {
    const dispatch = vi.fn(() => agentToolSuccess({ status: "ok" }));
    const catalog = buildCatalog(
      new AgentToolRouter([
        {
          namespace: "pwragent",
          name: "send_messaging_file",
          description: "Send a file.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
          },
          dispatch,
        },
      ]),
    );
    catalog.id = "messaging_context";
    catalog.summary.id = "messaging_context";
    const authorizeToolCall = vi.fn(() => "message.reply");
    const server = new AgentToolMcpServer({
      authorizeToolCall,
      resolveCallContext: (context) =>
        context.threadId
          ? {
              backend: context.backend,
              threadId: context.threadId,
              turnId: "turn-1",
            }
          : undefined,
      resolveCatalogs: () => [catalog],
    });
    openServers.push(server);
    const registration = await server.registerClient({
      backend: "acp:grok",
    });
    registration.bindThread("thread-1");
    const client = await connectClient(registration);
    try {
      await expect(
        client.callTool({
          name: "send_messaging_file",
          arguments: { path: "/tmp/resume.pdf" },
        }),
      ).resolves.toMatchObject({
        isError: true,
        structuredContent: {
          code: "forbidden",
        },
      });
    } finally {
      await client.close();
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(authorizeToolCall).toHaveBeenCalledWith({
      backend: "acp:grok",
      catalogId: "messaging_context",
      threadId: "thread-1",
      tool: "send_messaging_file",
      turnId: "turn-1",
      arguments: { path: "/tmp/resume.pdf" },
    });
  });
});

function buildCatalog(router: AgentToolRouter): ResolvedAgentToolCatalog {
  return {
    id: "app_management",
    dynamicTools: router.buildDynamicToolSpecs(),
    router,
    summary: {
      id: "app_management",
      namespace: "pwragent",
      enabled: true,
      toolCount: router.buildMcpTools().length,
      fingerprint: "test",
    },
  };
}

async function connectClient(
  registration: AgentToolMcpRegistration,
): Promise<Client> {
  const client = new Client({
    name: "pwragent-test",
    version: "1.0.0",
  });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(registration.server.url),
      {
        requestInit: {
          headers: registrationHeaders(registration),
        },
      },
    ),
  );
  return client;
}

function registrationHeaders(
  registration: AgentToolMcpRegistration,
): Record<string, string> {
  return Object.fromEntries(
    registration.server.headers.map((header) => [header.name, header.value]),
  );
}
