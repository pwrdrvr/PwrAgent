import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS } from "./mcp-connection-timeouts.js";
import { ConnectionRpcClient } from "./mcp-connection-rpc-client.js";

type BridgeDescription = {
  name?: string;
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
};

function logStderr(message: string, extra?: unknown): void {
  const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
  process.stderr.write(`[pwragent-mcp-connection] ${message}${suffix}\n`);
}


async function main(): Promise<void> {
  const socketPath = process.env.PWRAGENT_MCP_CONNECTION_SOCKET;
  const token = process.env.PWRAGENT_MCP_CONNECTION_TOKEN;
  const connectionName = process.env.PWRAGENT_MCP_CONNECTION_NAME;
  if (!socketPath || !token) {
    logStderr("missing bridge socket or token; refusing to start");
    process.exit(1);
  }
  const rpc = new ConnectionRpcClient(socketPath, token);
  // Before anything can start a server for this grant, so no window exists
  // in which a local command runs with no live bridge to own it.
  await rpc.attach();
  const startupDeadlineAt = Date.now() + MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS;
  const description = await rpc.request("describe", undefined, undefined, startupDeadlineAt) as BridgeDescription;
  const capabilities: ServerCapabilities = {
    ...(description.tools ? { tools: {} } : {}),
    ...(description.resources ? { resources: {} } : {}),
    ...(description.prompts ? { prompts: {} } : {}),
  };
  const server = new Server(
    { name: connectionName ?? description.name ?? "pwrsnap", version: "1.0.0" },
    { capabilities },
  );

  if (description.tools) {
    let firstCatalogDeadlineAt: number | undefined = startupDeadlineAt;
    // Upstream cursors can be deterministic across concurrent catalog reads.
    // Give each continuation its own opaque token and original read deadline.
    const continuations = new Map<string, { upstreamCursor: string; deadlineAt: number }>();
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const cursor = request.params?.cursor;
      const continuation = cursor ? continuations.get(cursor) : undefined;
      if (cursor && (!continuation || continuation.deadlineAt <= Date.now())) {
        continuations.delete(cursor);
        throw new Error("MCP catalog cursor expired. Restart discovery.");
      }
      const deadlineAt = (cursor ? continuation?.deadlineAt : firstCatalogDeadlineAt)
        ?? Date.now() + MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS;
      firstCatalogDeadlineAt = undefined;
      if (cursor) continuations.delete(cursor);
      const params = continuation ? { ...request.params, cursor: continuation.upstreamCursor } : request.params;
      const result = await rpc.request("tools/list", params, extra.signal, deadlineAt) as { nextCursor?: string };
      // Bound abandoned cursor chains without storing catalog contents.
      for (const [key, read] of continuations) if (read.deadlineAt <= Date.now()) continuations.delete(key);
      if (result.nextCursor) {
        if (continuations.size >= 20) throw new Error("Too many incomplete MCP catalog reads. Restart discovery.");
        const nextCursor = randomUUID();
        continuations.set(nextCursor, { upstreamCursor: result.nextCursor, deadlineAt });
        return { ...result, nextCursor } as never;
      }
      return result as never;
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      await rpc.request("tools/call", request.params, extra.signal) as never,
    );
  }
  if (description.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) =>
      await rpc.request("resources/list", request.params, extra.signal) as never,
    );
    server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async (request, extra) =>
        await rpc.request("resources/templates/list", request.params, extra.signal) as never,
    );
    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) =>
      await rpc.request("resources/read", request.params, extra.signal) as never,
    );
  }
  if (description.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request, extra) =>
      await rpc.request("prompts/list", request.params, extra.signal) as never,
    );
    server.setRequestHandler(GetPromptRequestSchema, async (request, extra) =>
      await rpc.request("prompts/get", request.params, extra.signal) as never,
    );
  }

  await server.connect(new StdioServerTransport());
  logStderr("ready");
}

void main().catch((error) => {
  logStderr("fatal", {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
