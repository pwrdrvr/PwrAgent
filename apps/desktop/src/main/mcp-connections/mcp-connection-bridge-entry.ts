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
  const description = await rpc.request("describe") as BridgeDescription;
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
    server.setRequestHandler(ListToolsRequestSchema, async (request) =>
      await rpc.request("tools/list", request.params) as never,
    );
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      await rpc.request("tools/call", request.params, extra.signal) as never,
    );
  }
  if (description.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) =>
      await rpc.request("resources/list", request.params) as never,
    );
    server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async (request) =>
        await rpc.request("resources/templates/list", request.params) as never,
    );
    server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
      await rpc.request("resources/read", request.params) as never,
    );
  }
  if (description.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) =>
      await rpc.request("prompts/list", request.params) as never,
    );
    server.setRequestHandler(GetPromptRequestSchema, async (request) =>
      await rpc.request("prompts/get", request.params) as never,
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
