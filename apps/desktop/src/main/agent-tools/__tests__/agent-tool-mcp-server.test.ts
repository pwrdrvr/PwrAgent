import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentToolRouter } from "../agent-tool-router";
import {
  AgentToolMcpServer,
  type AgentToolMcpRegistration,
} from "../agent-tool-mcp-server";
import { agentToolSuccess } from "../agent-tool-definition";
import type { ResolvedAgentToolCatalog } from "../agent-tool-catalog-registry";

describe("AgentToolMcpServer", () => {
  const openServers: AgentToolMcpServer[] = [];

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map(async (server) => server.close()));
  });

  it("serves and dispatches the dynamic-tool catalog over loopback MCP", async () => {
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
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          {
            name: "inspect",
            description: "Inspect test state.",
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
        threadId: "thread-1",
        transport: "mcp",
        turnId: "turn-1",
      },
    );
  });

  it("rejects unauthenticated, cross-origin, and inactive-turn calls", async () => {
    let active = false;
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
