import { connect, type Socket } from "node:net";
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

const REQUEST_TIMEOUT_MS = 60_000;
// Resource reads can carry a full-resolution screenshot as base64. Keep the
// local framing bound finite without rejecting ordinary high-DPI captures.
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

type RpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

type BridgeDescription = {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
};

function logStderr(message: string, extra?: unknown): void {
  const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
  process.stderr.write(`[pwragent-mcp-connection] ${message}${suffix}\n`);
}

class ConnectionRpcClient {
  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {}

  request(operation: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket: Socket = connect(this.socketPath);
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const timeout = setTimeout(
        () => finish(new Error("PwrAgent MCP bridge timed out.")),
        REQUEST_TIMEOUT_MS,
      );
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({
          token: this.token,
          op: operation,
          ...(params === undefined ? {} : { params }),
        })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_RESPONSE_BYTES) {
          finish(new Error("PwrAgent MCP bridge response was too large."));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as RpcResponse;
          if (!response.ok) {
            finish(new Error(response.error));
            return;
          }
          finish(undefined, response.result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", () => {
        finish(new Error("PwrAgent MCP bridge closed unexpectedly."));
      });
    });
  }
}

async function main(): Promise<void> {
  const socketPath = process.env.PWRAGENT_MCP_CONNECTION_SOCKET;
  const token = process.env.PWRAGENT_MCP_CONNECTION_TOKEN;
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
    { name: "pwrsnap", version: "1.0.0" },
    { capabilities },
  );

  if (description.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async (request) =>
      await rpc.request("tools/list", request.params) as never,
    );
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      await rpc.request("tools/call", request.params) as never,
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
