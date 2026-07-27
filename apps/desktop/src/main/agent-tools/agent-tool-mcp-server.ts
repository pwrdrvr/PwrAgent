import { randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  Server as McpProtocolServer,
} from "@modelcontextprotocol/sdk/server/index.js";
import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  PWRAGENT_TOOL_NAMESPACE,
  type AppServerBackendKind,
} from "@pwragent/shared";
import { getMainLogger } from "../log.js";
import type { ResolvedAgentToolCatalog } from "./agent-tool-catalog-registry.js";
import { agentToolFailure } from "./agent-tool-definition.js";
import {
  toMcpToolResponse,
  type AgentMcpToolCallResponse,
} from "./agent-tool-router.js";

const LOOPBACK_HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
const agentToolMcpLog = getMainLogger("pwragent:agent-tool-mcp");

export type AgentToolMcpClientContext = {
  backend: AppServerBackendKind;
  threadId?: string;
};

export type ResolvedAgentToolMcpCallContext = {
  backend: AppServerBackendKind;
  threadId: string;
  turnId: string;
};

export type AgentToolHttpMcpServerConfig = {
  name: string;
  type: "http";
  url: string;
  headers: Array<{
    name: string;
    value: string;
  }>;
};

export type AgentToolMcpRegistration = {
  server: AgentToolHttpMcpServerConfig;
  bindThread: (threadId: string) => void;
};

export type AgentToolMcpServerLike = {
  registerClient(
    context: AgentToolMcpClientContext,
  ): Promise<AgentToolMcpRegistration>;
  close(): Promise<void>;
};

export type AgentToolMcpServerOptions = {
  resolveCatalogs: () => ResolvedAgentToolCatalog[];
  resolveCallContext: (
    context: AgentToolMcpClientContext,
  ) =>
    | ResolvedAgentToolMcpCallContext
    | Promise<ResolvedAgentToolMcpCallContext | undefined>
    | undefined;
};

export class AgentToolMcpServer implements AgentToolMcpServerLike {
  private readonly contextsByToken = new Map<
    string,
    AgentToolMcpClientContext
  >();
  private readonly tokensByBoundThread = new Map<string, string>();
  private httpServer?: NodeHttpServer;
  private port?: number;
  private startPromise?: Promise<void>;
  private closed = false;

  constructor(private readonly options: AgentToolMcpServerOptions) {}

  async registerClient(
    context: AgentToolMcpClientContext,
  ): Promise<AgentToolMcpRegistration> {
    if (this.closed) {
      throw new Error("PwrAgent MCP server is closed.");
    }
    await this.ensureStarted();
    const token = this.tokenForContext(context);
    return {
      server: {
        name: PWRAGENT_TOOL_NAMESPACE,
        type: "http",
        url: `http://${LOOPBACK_HOST}:${this.port}${MCP_PATH}`,
        headers: [
          {
            name: "Authorization",
            value: `Bearer ${token}`,
          },
        ],
      },
      bindThread: (threadId) => {
        const normalizedThreadId = threadId.trim();
        const current = this.contextsByToken.get(token);
        if (!normalizedThreadId || !current) {
          return;
        }
        const bound = {
          ...current,
          threadId: normalizedThreadId,
        };
        this.contextsByToken.set(token, bound);
        const key = boundThreadKey(bound.backend, normalizedThreadId);
        if (!this.tokensByBoundThread.has(key)) {
          this.tokensByBoundThread.set(key, token);
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.startPromise?.catch(() => undefined);
    const httpServer = this.httpServer;
    this.httpServer = undefined;
    if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
    this.port = undefined;
    this.contextsByToken.clear();
    this.tokensByBoundThread.clear();
  }

  private tokenForContext(context: AgentToolMcpClientContext): string {
    const normalizedThreadId = context.threadId?.trim();
    if (normalizedThreadId) {
      const key = boundThreadKey(context.backend, normalizedThreadId);
      const existing = this.tokensByBoundThread.get(key);
      if (existing) {
        return existing;
      }
    }
    const token = randomBytes(32).toString("base64url");
    const normalizedContext = {
      backend: context.backend,
      ...(normalizedThreadId ? { threadId: normalizedThreadId } : {}),
    };
    this.contextsByToken.set(token, normalizedContext);
    if (normalizedThreadId) {
      this.tokensByBoundThread.set(
        boundThreadKey(context.backend, normalizedThreadId),
        token,
      );
    }
    return token;
  }

  private async ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.start().catch((error) => {
        this.startPromise = undefined;
        throw error;
      });
    }
    await this.startPromise;
  }

  private async start(): Promise<void> {
    const httpServer = createHttpServer((request, response) => {
      void this.handleHttpRequest(request, response).catch((error) => {
        agentToolMcpLog.error("MCP request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) {
          writeJsonResponse(response, 500, {
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal MCP server error.",
            },
            id: null,
          });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    });
    await listenOnLoopback(httpServer);
    const address = httpServer.address() as AddressInfo | null;
    if (!address || typeof address.port !== "number") {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      throw new Error("PwrAgent MCP server did not receive a loopback port.");
    }
    httpServer.on("error", (error) => {
      agentToolMcpLog.error("MCP HTTP server error", {
        error: error.message,
      });
    });
    this.httpServer = httpServer;
    this.port = address.port;
    agentToolMcpLog.info("MCP server listening", {
      address: LOOPBACK_HOST,
      port: address.port,
      transport: "streamable_http",
    });
  }

  private async handleMcpProtocolRequest(params: {
    request: Request;
    token: string;
    clientContext: AgentToolMcpClientContext;
  }): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });
    const mcpServer = new McpProtocolServer(
      {
        name: PWRAGENT_TOOL_NAMESPACE,
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
        instructions:
          "Tools for inspecting and controlling the PwrAgent thread that registered this MCP server.",
      },
    );
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.resolveMcpTools(),
    }));
    mcpServer.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        const token = extra.authInfo?.token;
        const clientContext = token
          ? this.contextsByToken.get(token)
          : undefined;
        if (!clientContext) {
          return forbiddenMcpResponse("Unknown PwrAgent MCP client.");
        }
        if (!clientContext.threadId) {
          return forbiddenMcpResponse(
            "PwrAgent MCP tools are callable only after the client is bound to a thread.",
          );
        }
        const callContext = await this.options.resolveCallContext(clientContext);
        if (!callContext) {
          return forbiddenMcpResponse(
            "PwrAgent MCP tools are callable only during an active turn on the registered thread.",
          );
        }
        const router = this.options
          .resolveCatalogs()
          .map((catalog) => catalog.router)
          .find((candidate) =>
            candidate.acceptsMcpToolCall({
              tool: request.params.name,
            }),
          );
        if (!router) {
          return toMcpToolResponse(
            agentToolFailure({
              code: "unsupported_operation",
              message: "Unsupported PwrAgent MCP tool.",
            }),
          );
        }
        return await router.handleMcpToolCall({
          backend: callContext.backend,
          threadId: callContext.threadId,
          turnId: callContext.turnId,
          callId: String(extra.requestId),
          tool: request.params.name,
          args: request.params.arguments,
        });
      },
    );
    await mcpServer.connect(transport);
    try {
      return await transport.handleRequest(params.request, {
        authInfo: {
          token: params.token,
          clientId: `${PWRAGENT_TOOL_NAMESPACE}:${params.clientContext.backend}`,
          scopes: ["tools"],
        },
      });
    } finally {
      await mcpServer.close().catch(() => undefined);
    }
  }

  private resolveMcpTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    const toolsByName = new Map<
      string,
      {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }
    >();
    for (const catalog of this.options.resolveCatalogs()) {
      for (const tool of catalog.router.buildMcpTools()) {
        if (toolsByName.has(tool.name)) {
          throw new Error(`Duplicate PwrAgent MCP tool name: ${tool.name}`);
        }
        toolsByName.set(tool.name, tool);
      }
    }
    return [...toolsByName.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${LOOPBACK_HOST}:${this.port}`,
    );
    if (requestUrl.pathname !== MCP_PATH) {
      writeJsonResponse(response, 404, {
        error: "Not found.",
      });
      return;
    }
    const expectedHost = `${LOOPBACK_HOST}:${this.port}`;
    if (request.headers.host !== expectedHost) {
      writeJsonResponse(response, 403, {
        error: "Invalid Host header.",
      });
      return;
    }
    if (!isAllowedOrigin(request.headers.origin)) {
      writeJsonResponse(response, 403, {
        error: "Invalid Origin header.",
      });
      return;
    }
    const token = readBearerToken(request.headers.authorization);
    const clientContext = token
      ? this.contextsByToken.get(token)
      : undefined;
    if (!token || !clientContext) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="pwragent-mcp"');
      writeJsonResponse(response, 401, {
        error: "Unauthorized.",
      });
      return;
    }
    const webResponse = await this.handleMcpProtocolRequest({
      request: await toWebRequest(request, requestUrl),
      token,
      clientContext,
    });
    response.writeHead(
      webResponse.status,
      Object.fromEntries(webResponse.headers.entries()),
    );
    const body = Buffer.from(await webResponse.arrayBuffer());
    response.end(body);
  }
}

function forbiddenMcpResponse(message: string): AgentMcpToolCallResponse {
  return toMcpToolResponse(
    agentToolFailure({
      code: "forbidden",
      message,
    }),
  );
}

function boundThreadKey(
  backend: AppServerBackendKind,
  threadId: string,
): string {
  return JSON.stringify([backend, threadId]);
}

function readBearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(value ?? "");
  return match?.[1];
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  try {
    const hostname = new URL(origin).hostname;
    return (
      hostname === "127.0.0.1"
      || hostname === "localhost"
      || hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function writeJsonResponse(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(body));
}

async function toWebRequest(
  request: IncomingMessage,
  url: URL,
): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const method = request.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await readRequestBody(request);
  return new Request(url, {
    method,
    headers,
    body: body?.toString("utf8"),
  });
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 1024 * 1024) {
      throw new Error("MCP request body exceeds the 1 MiB limit.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function listenOnLoopback(server: NodeHttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = (): void => {
      server.off("error", handleError);
      resolve();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(0, LOOPBACK_HOST);
  });
}
