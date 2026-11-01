import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ElicitResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type Implementation,
  type InitializeResult,
  type Notification,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS, MCP_CONNECTION_TOOL_TIMEOUT_MS } from "./mcp-connection-timeouts.js";
import { McpInitializationTransport } from "./mcp-initialization-transport.js";
import { ConnectionRpcClient, type McpBridgeEvent } from "./mcp-connection-rpc-client.js";
import { clientSupportsFormElicitation, type ElicitationRoute } from "./mcp-elicitation-relay.js";

type BridgeDescription = {
  name?: string;
  serverInfo?: Implementation;
  capabilities?: ServerCapabilities;
  instructions?: string;
  metadata?: InitializeResult["_meta"];
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
  let server: Server | undefined;
  let closed = false;
  let initialized = false;
  const pending: McpBridgeEvent[] = [];
  const forward = (event: McpBridgeEvent): void => {
    if (event.method === "connection/closed") {
      closed = true;
      logStderr("upstream ended; start the desktop yourself and reconnect MCP. Rediscover tools and reread skills/resources. Never replay writes or approvals.");
      void server?.close();
    } else if (server && initialized) {
      void server.notification(event as Notification).catch((error: unknown) => logStderr("notification failed", String(error)));
    } else if (pending.length < 128) pending.push(event);
  };
  await rpc.attach(5_000, forward);
  const startupDeadlineAt = Date.now() + MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS;
  const description = await rpc.request("describe", undefined, undefined, startupDeadlineAt) as BridgeDescription;
  const capabilities: ServerCapabilities = {
    ...(description.tools ? { tools: description.capabilities?.tools ?? {} } : {}),
    ...(description.resources ? { resources: description.capabilities?.resources ?? {} } : {}),
    ...(description.prompts ? { prompts: description.capabilities?.prompts ?? {} } : {}),
  };
  if (closed) throw new Error("The upstream MCP session ended during startup. Reconnect explicitly.");
  server = new Server(
    description.serverInfo ?? { name: connectionName ?? description.name ?? "pwrsnap", version: "1.0.0" },
    { capabilities, instructions: description.instructions },
  );
  server.oninitialized = () => {
    initialized = true;
    for (const event of pending.splice(0)) forward(event);
  };

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
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      // The upstream server's form goes to the agent's own MCP client, tied
      // to this call, exactly as the server sent it. A client that never
      // declared elicitation is not asked; the owner then refuses the form.
      const onElicit: ElicitationRoute | undefined = clientSupportsFormElicitation(server.getClientCapabilities())
        ? async (params, signal) => await extra.sendRequest(
          { method: "elicitation/create", params },
          ElicitResultSchema,
          // A person is answering; wait as long as the call itself may run.
          { signal, timeout: MCP_CONNECTION_TOOL_TIMEOUT_MS },
        )
        : undefined;
      return await rpc.request(
        "tools/call", request.params, extra.signal, undefined, undefined, undefined, onElicit,
      ) as never;
    });
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
  if (description.capabilities?.resources?.subscribe) {
    server.setRequestHandler(SubscribeRequestSchema, async (request, extra) =>
      await rpc.request("resources/subscribe", request.params, extra.signal) as never,
    );
    server.setRequestHandler(UnsubscribeRequestSchema, async (request, extra) =>
      await rpc.request("resources/unsubscribe", request.params, extra.signal) as never,
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

  await server.connect(new McpInitializationTransport(new StdioServerTransport(), description.metadata));
  if (closed) await server.close();
  logStderr("ready");
}

void main().catch((error) => {
  logStderr("fatal", {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
