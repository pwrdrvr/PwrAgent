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
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  RequestSchema,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  PWRAGENT_TOOL_NAMESPACE,
  type AppServerBackendKind,
} from "@pwragent/shared";
import { getMainLogger } from "../log.js";
import type { ResolvedAgentToolCatalog } from "./agent-tool-catalog-registry.js";
import { agentToolFailure } from "./agent-tool-definition.js";
import {
  PWRAGENT_AGENT_TOOL_NAMESPACE_DESCRIPTION,
  toMcpToolResponse,
  type AgentMcpTool,
  type AgentMcpToolCallResponse,
} from "./agent-tool-router.js";
import {
  PWRAGENT_SKILLS_EXTENSION,
  PWRAGENT_WORKFLOW_SKILLS,
} from "./pwragent-workflow-skills.js";

// The SDK's built-in request union does not yet include the skills extension.
const ListSkillsRequestSchema = RequestSchema.extend({
  method: z.literal("skills/list"),
});
const GetSkillRequestSchema = RequestSchema.extend({
  method: z.literal("skills/get"),
});

export function buildPwrAgentMcpInstructions(toolNames: readonly string[]): string {
  const has = (name: string) => toolNames.includes(name);
  return PWRAGENT_AGENT_TOOL_NAMESPACE_DESCRIPTION
    + (has("watch_thread_pull_request")
      ? " For own PR CI/merge, follow prAutomation.guidance; use watch_thread_pull_request and end the turn."
      : "")
    + (has("manage_thread_dependencies")
      ? " Other local threads/PRs: manage_thread_dependencies (Continue After), mode all for multiple PRs."
      : "")
    + (has("create_monitor_delegation")
      ? " Other long jobs: create_monitor_delegation."
      : "")
    + (has("watch_thread_pull_request") || has("manage_thread_dependencies") || has("create_monitor_delegation")
      ? " Register the wait and end the turn; do not poll PRs in monitors, shells, or sleep loops."
      : "")
    + (has("read_tool_guide")
      ? " Read skill://waiting-on-work/SKILL.md for waits; skill://tool-guide/SKILL.md for tools."
        + " Find via skills/list or resources/list; skills/get: metadata, resources/read: content."
        + " Read read_tool_guide for the short tool guide."
      : "");
}

type CallToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const LOOPBACK_HOST = "127.0.0.1";
const MCP_PATH = "/mcp";

/**
 * How often a running tool call reports progress.
 *
 * A tool call is answered as an SSE stream whose headers are sent at once.
 * Claude Code 2.1.310 aborts a POST whose response headers have not arrived
 * after 60 seconds, so a JSON response limited every call to 60 seconds.
 * Once the headers arrive, it aborts a call only after 300 seconds with no
 * response and no progress notification (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT),
 * then after `MCP_TOOL_TIMEOUT` (about 27.8 hours by default). A progress
 * notification at this interval keeps a call that waits for the operator,
 * a renderer or long work open until it finishes.
 */
export const AGENT_TOOL_MCP_PROGRESS_INTERVAL_MS = 30_000;
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

/**
 * `id` is required: `authorizeToolCall` resolves a catalog's RBAC category
 * from it, and a catalog without one would dispatch every tool it owns with no
 * permission check rather than failing closed.
 */
export type AgentToolMcpCatalog = Pick<ResolvedAgentToolCatalog, "id" | "router">;

export type AgentToolMcpAuthorization = {
  backend: AppServerBackendKind;
  catalogId?: ResolvedAgentToolCatalog["id"];
  threadId: string;
  tool: string;
  turnId: string;
  arguments?: unknown;
};

export type AgentToolMcpServerOptions = {
  resolveCatalogs: (context: AgentToolMcpClientContext) => AgentToolMcpCatalog[];
  resolveCallContext: (
    context: AgentToolMcpClientContext,
  ) =>
    | ResolvedAgentToolMcpCallContext
    | Promise<ResolvedAgentToolMcpCallContext | undefined>
    | undefined;
  authorizeToolCall?: (
    params: AgentToolMcpAuthorization,
  ) => string | null | undefined | Promise<string | null | undefined>;
  resolveToolResultReminder?: (
    context: ResolvedAgentToolMcpCallContext,
  ) => Promise<string | undefined>;
  /** Overrides AGENT_TOOL_MCP_PROGRESS_INTERVAL_MS. */
  progressIntervalMs?: number;
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
    agentToolMcpLog.info("registered MCP client", {
      backend: context.backend,
      threadId: context.threadId ?? null,
    });
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
        agentToolMcpLog.info("bound MCP client to thread", {
          backend: bound.backend,
          previousThreadId: current.threadId ?? null,
          threadId: normalizedThreadId,
        });
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
    // A tool call can wait for the operator, a renderer or long work, so it
    // is answered as a stream whose headers go out at once. Every other
    // request answers at once and stays a single JSON response.
    const streamed = await isToolCallRequest(params.request);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: !streamed,
      sessionIdGenerator: undefined,
    });
    const toolCalls: Promise<unknown>[] = [];
    const clientGone = new AbortController();
    const toolNames = this.resolveMcpTools(params.clientContext).map((tool) => tool.name);
    const hasToolGuide = toolNames.includes("read_tool_guide");
    // The PDF-only MCP surface shares this server but has no workflow tools.
    const skills = hasToolGuide ? PWRAGENT_WORKFLOW_SKILLS : [];
    const mcpServer = new McpProtocolServer(
      {
        name: PWRAGENT_TOOL_NAMESPACE,
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          extensions: { [PWRAGENT_SKILLS_EXTENSION]: {} },
        },
        instructions: buildPwrAgentMcpInstructions(toolNames),
      },
    );
    mcpServer.setRequestHandler(ListSkillsRequestSchema, async (request) => {
      rejectSkillCursor(request.params?.cursor);
      return { skills: skills.map((skill) => skill.entry) };
    });
    mcpServer.setRequestHandler(GetSkillRequestSchema, async (request) => {
      // The SDK maps thrown schema errors to InternalError. Validate extension
      // arguments here so malformed skill requests return InvalidParams.
      const uri = request.params?.uri;
      if (typeof uri !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "skills/get requires a skill URI.");
      }
      const skill = skills.find((candidate) => candidate.entry.uri === uri);
      if (!skill) {
        throw new McpError(ErrorCode.InvalidParams, "Unknown skill URI.");
      }
      return { skill: skill.entry };
    });
    mcpServer.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      rejectSkillCursor(request.params?.cursor);
      return { resources: skills.map((skill) => skill.resource) };
    });
    mcpServer.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      rejectSkillCursor(request.params?.cursor);
      return { resourceTemplates: [] };
    });
    mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const skill = skills.find((candidate) => candidate.content.uri === request.params.uri);
      if (!skill) {
        throw new McpError(-32002, "Unknown resource URI.");
      }
      return { contents: [skill.content] };
    });
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.resolveMcpTools(params.clientContext),
    }));
    mcpServer.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        const progressToken = request.params._meta?.progressToken;
        let progress = 0;
        const heartbeat = progressToken === undefined ? undefined : setInterval(() => {
          progress += 1;
          void extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress, message: "PwrAgent is still working on this call." },
          }).catch(() => undefined);
        }, this.options.progressIntervalMs ?? AGENT_TOOL_MCP_PROGRESS_INTERVAL_MS);
        heartbeat?.unref?.();
        // A client that stopped reading no longer needs progress.
        const stopHeartbeat = () => clearInterval(heartbeat);
        clientGone.signal.addEventListener("abort", stopHeartbeat, { once: true });
        const call = this.callTool(request, extra);
        toolCalls.push(call.catch(() => undefined));
        try {
          return await call;
        } finally {
          clientGone.signal.removeEventListener("abort", stopHeartbeat);
          stopHeartbeat();
        }
      },
    );
    await mcpServer.connect(transport);
    const close = async () => {
      // Never close before a call settles: closing aborts it, and a call that
      // already raised a card or started work must finish as it would have.
      await Promise.all(toolCalls);
      await mcpServer.close().catch(() => undefined);
    };
    let response: Response;
    try {
      response = await transport.handleRequest(params.request, {
        authInfo: {
          token: params.token,
          clientId: `${PWRAGENT_TOOL_NAMESPACE}:${params.clientContext.backend}`,
          scopes: ["tools"],
        },
      });
    } catch (error) {
      await close();
      throw error;
    }
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      await close();
      return response;
    }
    return new Response(closeWhenDone(response.body, close, () => clientGone.abort()), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  private async callTool(
    request: z.infer<typeof CallToolRequestSchema>,
    extra: CallToolExtra,
  ): Promise<AgentMcpToolCallResponse> {
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
      agentToolMcpLog.warn("MCP tool rejected: no unique active turn", {
        backend: clientContext.backend,
        threadId: clientContext.threadId,
        tool: request.params.name,
      });
      return forbiddenMcpResponse(
        "PwrAgent MCP tools are callable only during an active turn on the registered thread.",
      );
    }
    const catalog = this.options
      .resolveCatalogs(clientContext)
      .find((candidate) =>
        candidate.router.acceptsMcpToolCall({
          tool: request.params.name,
        }),
      );
    if (!catalog) {
      return toMcpToolResponse(
        agentToolFailure({
          code: "unsupported_operation",
          message: "Unsupported PwrAgent MCP tool.",
        }),
      );
    }
    const deniedPermission = await this.options.authorizeToolCall?.({
      backend: callContext.backend,
      catalogId: catalog.id,
      threadId: callContext.threadId,
      tool: request.params.name,
      turnId: callContext.turnId,
      arguments: request.params.arguments,
    });
    if (deniedPermission) {
      return toMcpToolResponse(
        agentToolFailure({
          code: "forbidden",
          message:
            `The messaging user who started this turn lacks permission for this tool (${deniedPermission}).`,
        }),
      );
    }
    const result = await catalog.router.handleMcpToolCall({
      backend: callContext.backend,
      threadId: callContext.threadId,
      turnId: callContext.turnId,
      callId: String(extra.requestId),
      tool: request.params.name,
      args: request.params.arguments,
      signal: extra.signal,
    });
    try {
      // Resolve after dispatch using the original turn identity. A reminder
      // can only ride this response; it must never enqueue another turn.
      const reminder = await this.options.resolveToolResultReminder?.(callContext);
      if (reminder) {
        return { ...result, content: [...result.content, { type: "text", text: reminder }] };
      }
    } catch (error) {
      agentToolMcpLog.warn("MCP tool result reminder failed open", { error: String(error) });
    }
    return result;
  }

  private resolveMcpTools(context: AgentToolMcpClientContext): AgentMcpTool[] {
    const toolsByName = new Map<string, AgentMcpTool>();
    for (const catalog of this.options.resolveCatalogs(context)) {
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
    if (!webResponse.body) {
      response.writeHead(
        webResponse.status,
        Object.fromEntries(webResponse.headers.entries()),
      );
      response.end();
      return;
    }
    // The body must be read or cancelled on every path: its end is what
    // closes the request's MCP server.
    const reader = webResponse.body.getReader();
    let finished = false;
    const cancel = () => {
      if (!finished) void reader.cancel().catch(() => undefined);
    };
    response.on("close", cancel);
    try {
      if (response.destroyed) cancel();
      response.writeHead(
        webResponse.status,
        Object.fromEntries(webResponse.headers.entries()),
      );
      // Send the headers now: a client times the wait for them, not the call.
      response.flushHeaders();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(value);
      }
    } catch (error) {
      cancel();
      throw error;
    } finally {
      finished = true;
      response.end();
    }
  }
}

/** True when the request is a tools/call, or a batch holding one. */
async function isToolCallRequest(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    const body: unknown = await request.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    return messages.some((message) =>
      !!message && typeof message === "object" && (message as { method?: unknown }).method === "tools/call");
  } catch {
    return false;
  }
}

/** The same stream, calling `close` once it ends or its reader cancels, and
 * `onCancel` when its reader cancels. */
function closeWhenDone(
  body: ReadableStream<Uint8Array>,
  close: () => Promise<void>,
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    void close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          closeOnce();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        closeOnce();
      }
    },
    async cancel(reason) {
      onCancel();
      await reader.cancel(reason).catch(() => undefined);
      closeOnce();
    },
  });
}

function rejectSkillCursor(cursor: unknown): void {
  if (cursor !== undefined) {
    throw new McpError(ErrorCode.InvalidParams, "Invalid cursor.");
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
