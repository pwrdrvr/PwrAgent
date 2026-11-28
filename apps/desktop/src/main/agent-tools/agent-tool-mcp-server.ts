import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createResponseFlush } from "../util/response-flush";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolRequest,
  RequestId,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { PWRAGENT_MCP_HTTP_MAX_REQUEST_BYTES, PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import { type AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { getMainLogger } from "../log.js";
import { lazyModule } from "../lazy-module.js";
import { loadedMcpTypes, mcpServer as mcpServerSdk, mcpServerStdio, mcpServerStreamableHttp, mcpTypes } from "../mcp-connections/mcp-sdk.js";
import { CodexAgentToolIpc, type CodexAgentToolStdioConfig, type CodexIpcConnection, type CodexIpcListener, type OwnedCodexProcess } from "./codex-agent-tool-ipc.js";
import type { ResolvedAgentToolCatalog } from "./agent-tool-catalog-registry.js";
import { agentToolFailure } from "./agent-tool-definition.js";
import {
  ANTIGRAVITY_DIRECT_MCP_TOOLS,
  ANTIGRAVITY_MCP_CONNECTION_INSTRUCTIONS,
  ANTIGRAVITY_TOOL_DISCOVERY,
  ANTIGRAVITY_TOOL_DISCOVERY_INSTRUCTIONS,
  CALL_PWRAGENT_TOOL,
  readPwrAgentCallTarget,
} from "./antigravity-mcp-catalog.js";
import { agentToolPermissionDeniedMessage } from "./app-management-authorization.js";
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
import { PWRAGENT_TOOL_SEARCH, searchPwrAgentMcpTools } from "./pwragent-tool-search.js";

// The SDK's built-in request union does not yet include the skills extension.
// The SDK loads with the first request, not with the owner.
const skillRequestSchemas = lazyModule(async () => {
  const [{ RequestSchema }, { z }] = await Promise.all([mcpTypes.load(), import("zod")]);
  return {
    ListSkillsRequestSchema: RequestSchema.extend({
      method: z.literal("skills/list"),
    }),
    GetSkillRequestSchema: RequestSchema.extend({
      method: z.literal("skills/get"),
    }),
  };
});

export function buildPwrAgentMcpInstructions(toolNames: readonly string[]): string {
  const has = (name: string) => toolNames.includes(name);
  return PWRAGENT_AGENT_TOOL_NAMESPACE_DESCRIPTION
    + (has("watch_thread_pull_request")
      ? " Own PR CI/merge: follow prAutomation.guidance and use watch_thread_pull_request."
      : "")
    + (has("list_stacks") ? " For stacked PRs, use list_stacks to check layer order and health before merging." : "")
    + (has("plan_stack_operation") ? " Use plan_stack_operation to forecast local stack changes before applying them." : "")
    + (has("manage_thread_dependencies")
      ? " Use manage_thread_dependencies for prerequisites, ci_run for standalone CI, and local_file for watcher markers."
      : "")
    + (has("schedule_follow_up")
      ? " Timed waits: schedule_follow_up."
      : "")
    + (has("create_monitor_delegation")
      ? " Explicit Job Monitor or no built-in wait: create_monitor_delegation."
      : "")
    + (has("watch_thread_pull_request") || has("manage_thread_dependencies") || has("create_monitor_delegation")
      ? " Register the wait and end the turn."
      : "")
    + (has("read_tool_guide")
      ? " Read read_tool_guide or use resources/read for skill://waiting-on-work/SKILL.md and skill://tool-guide/SKILL.md."
      : "");
}

type CallToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const LOOPBACK_HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
const MCP_SESSION_HEADER = "Mcp-Session-Id";
const JOB_MONITOR_CATALOG_SCOPE = "jobMonitorCatalog";
// These tools key mutation admission or receipts by the internal call ID.
const MCP_TOOLS_REQUIRING_SESSION = new Set([
  "handoff_task",
  "move_thread_workspace",
  "research_assign",
  "research_start",
  "research_update",
  "start_review",
]);

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
/** A tool's own progress lines go out at most this often; the heartbeat repeats the latest. */
export const AGENT_TOOL_MCP_REPORTED_PROGRESS_MIN_GAP_MS = 2_000;
const AGENT_TOOL_MCP_DEFAULT_PROGRESS_MESSAGE = "PwrAgent is still working on this call.";
const agentToolMcpLog = getMainLogger("pwragent:agent-tool-mcp");

export type AgentToolMcpClientContext = {
  backend: AppServerBackendKind;
  threadId?: string;
  stdioFallback?: boolean;
  managedReview?: boolean;
  observeJobMonitorCatalog?: boolean;
  tokenMiserEnabled?: boolean;
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

export type AgentToolMcpRegistration = AgentToolRegistration & { server: AgentToolHttpMcpServerConfig };
export type CodexAgentToolMcpRegistration = AgentToolRegistration & { server: CodexAgentToolStdioConfig };
export type OwnedAgentToolMcpRegistration = AgentToolRegistration & {
  server: CodexAgentToolStdioConfig & { name: string; type: "stdio" };
  revoke: () => void;
};

type AgentToolRegistration = {
  bindThread: (threadId: string) => void;
  revokeUnbound?: () => void;
  readListedJobMonitorCreation?: () => boolean | undefined;
  /** The live tool description. Use catalog scope for a deferred invocation's target. */
  readTool?: (name: string, scope?: "listed" | "catalog") => Promise<AgentMcpTool | undefined>;
};

type JobMonitorCatalogListing = { scope: string; enabled?: boolean };

export type AgentToolMcpServerLike = {
  registerClient(
    context: AgentToolMcpClientContext,
  ): Promise<AgentToolMcpRegistration>;
  registerCodexClient?(context: AgentToolMcpClientContext): Promise<CodexAgentToolMcpRegistration>;
  registerOwnedClient?(
    context: AgentToolMcpClientContext,
    owned: OwnedCodexProcess,
  ): Promise<OwnedAgentToolMcpRegistration | undefined>;
  close(): Promise<void>;
};

export type AgentToolMcpCatalogId =
  | ResolvedAgentToolCatalog["id"]
  | "managed_review";

/**
 * `id` is required: `authorizeToolCall` resolves a catalog's RBAC category
 * from it, and a catalog without one would dispatch every tool it owns with no
 * permission check rather than failing closed.
 */
export type AgentToolMcpCatalog = {
  id: AgentToolMcpCatalogId;
  router: ResolvedAgentToolCatalog["router"];
};

export type AgentToolMcpAuthorization = {
  backend: AppServerBackendKind;
  catalogId?: AgentToolMcpCatalogId;
  threadId: string;
  tool: string;
  turnId: string;
  arguments?: unknown;
};

export type AgentToolMcpServerOptions = {
  verifyCodexThreadId?: boolean;
  codexRelayExecutable?: () => string;
  createCodexIpcListener?: (onConnection: CodexIpcConnection) => CodexIpcListener;
  resolveCatalogs: (
    context: AgentToolMcpClientContext,
  ) => AgentToolMcpCatalog[] | Promise<AgentToolMcpCatalog[]>;
  resolveCallContext: (
    context: AgentToolMcpClientContext,
  ) =>
    | ResolvedAgentToolMcpCallContext
    | Promise<ResolvedAgentToolMcpCallContext | undefined>
    | undefined;
  authorizeToolCall?: (
    params: AgentToolMcpAuthorization,
  ) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Whether a client may see a tool. A contained member lists only its
   * allowed tools; `authorizeToolCall` still refuses the rest per call.
   */
  isToolAdvertised?: (name: string, context: AgentToolMcpClientContext) => boolean | Promise<boolean>;
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
  private readonly codexStdioTokens = new Set<string>();
  private readonly tokensByBoundThread = new Map<string, string>();
  private readonly jobMonitorListings = new Map<string, JobMonitorCatalogListing>();
  private readonly ownedClientReleases = new WeakMap<OwnedCodexProcess["child"], Set<() => void>>();
  private readonly sessionSigningKey = randomBytes(32);
  private readonly connectionsWithoutRequests = new Set<Socket>();
  /** Ends each open standalone event stream (a client's GET). */
  private readonly standaloneStreams = new Set<() => void>();
  private httpServer?: NodeHttpServer;
  private port?: number;
  private startPromise?: Promise<void>;
  private closed = false;
  private readonly codexIpc: CodexIpcListener;

  constructor(private readonly options: AgentToolMcpServerOptions) {
    const onConnection: CodexIpcConnection = (stream, token, isAuthorized) =>
      this.openCodexSession(stream, token, isAuthorized);
    this.codexIpc = options.createCodexIpcListener?.(onConnection)
      ?? new CodexAgentToolIpc(onConnection, options.codexRelayExecutable);
  }

  async registerClient(
    context: AgentToolMcpClientContext,
  ): Promise<AgentToolMcpRegistration> {
    if (this.closed) {
      throw new Error("PwrAgent MCP server is closed.");
    }
    await this.ensureStarted();
    const token = this.tokenForContext(context);
    const listing: JobMonitorCatalogListing | undefined = context.observeJobMonitorCatalog
      ? { scope: randomUUID() } : undefined;
    if (listing) this.jobMonitorListings.set(token, listing);
    const url = new URL(`http://${LOOPBACK_HOST}:${this.port}${MCP_PATH}`);
    if (listing) url.searchParams.set(JOB_MONITOR_CATALOG_SCOPE, listing.scope);
    agentToolMcpLog.info("registered MCP client", {
      backend: context.backend,
      threadId: context.threadId ?? null,
    });
    return {
      server: {
        name: PWRAGENT_TOOL_NAMESPACE,
        type: "http",
        url: url.toString(),
        headers: [
          {
            name: "Authorization",
            value: `Bearer ${token}`,
          },
        ],
      },
      ...this.registration(token, listing),
    };
  }

  async registerCodexClient(context: AgentToolMcpClientContext): Promise<CodexAgentToolMcpRegistration> {
    if (context.backend !== "codex" || this.closed) throw new Error("Codex MCP registration is unavailable.");
    const token = this.tokenForContext(context, "stdio");
    this.codexStdioTokens.add(token);
    try {
      const server = await this.codexIpc.configuration(token);
      return { server, ...this.registration(token, undefined, "stdio") };
    } catch (error) {
      this.registration(token).revokeUnbound?.();
      throw error;
    }
  }

  async registerOwnedClient(
    context: AgentToolMcpClientContext,
    owned: OwnedCodexProcess,
  ): Promise<OwnedAgentToolMcpRegistration | undefined> {
    if (this.closed || process.platform !== "darwin" || context.backend === "codex" || !this.codexIpc.bindRuntime) {
      return undefined;
    }
    const token = randomBytes(32).toString("base64url");
    const threadId = context.threadId?.trim() || undefined;
    this.contextsByToken.set(token, { ...context, threadId });
    this.codexStdioTokens.add(token);
    const listing = context.observeJobMonitorCatalog ? { scope: randomUUID() } : undefined;
    if (listing) this.jobMonitorListings.set(token, listing);
    const releases = this.ownedClientReleases.get(owned.child) ?? new Set<() => void>();
    if (!this.ownedClientReleases.has(owned.child)) {
      this.ownedClientReleases.set(owned.child, releases);
      owned.child.once("close", () => {
        for (const release of releases) release();
        this.ownedClientReleases.delete(owned.child);
      });
    }
    const revoke = () => {
      releases.delete(revoke);
      this.contextsByToken.delete(token);
      this.codexStdioTokens.delete(token);
      this.jobMonitorListings.delete(token);
      this.codexIpc.revoke(token);
    };
    releases.add(revoke);
    try {
      const server = await this.codexIpc.configuration(token);
      await this.codexIpc.bindRuntime(token, owned);
      return {
        server: { name: PWRAGENT_TOOL_NAMESPACE, type: "stdio", ...server },
        ...this.registration(token, listing, null),
        revoke,
      };
    } catch {
      revoke();
      return undefined;
    }
  }

  private registration(token: string, listing?: JobMonitorCatalogListing, transport: "http" | "stdio" | null = "http"): AgentToolRegistration {
    return {
      ...(listing ? {
        readListedJobMonitorCreation: () => this.jobMonitorListings.get(token) === listing ? listing.enabled : undefined,
      } : {}),
      readTool: async (name, scope = "listed") => {
        const current = this.contextsByToken.get(token);
        if (!current) return undefined;
        if (scope === "listed" && usesAntigravityCatalog(current) && !ANTIGRAVITY_DIRECT_MCP_TOOLS.has(name)) {
          const wrapper = ANTIGRAVITY_TOOL_DISCOVERY.find((tool) => tool.name === name);
          if (wrapper) return await this.isToolAdvertised(name, current) ? wrapper : undefined;
          if (canDeferAntigravityTools(await this.resolveAntigravityDiscoveryTools(current))) return undefined;
        }
        return await this.resolveMcpTool(current, name);
      },
      revokeUnbound: () => {
        if (this.contextsByToken.get(token)?.threadId) return;
        this.contextsByToken.delete(token);
        this.codexStdioTokens.delete(token);
        this.codexIpc.revoke(token);
        this.jobMonitorListings.delete(token);
      },
      bindThread: (threadId) => {
        const normalizedThreadId = threadId.trim();
        const current = this.contextsByToken.get(token);
        if (!normalizedThreadId || !current || (current.threadId && current.threadId !== normalizedThreadId)) {
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
        if (transport) {
          const key = boundThreadKey(bound, normalizedThreadId, transport);
          if (!this.tokensByBoundThread.has(key)) this.tokensByBoundThread.set(key, token);
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.codexIpc.close();
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
        // HTTP idle cleanup can miss sockets before their first request. The
        // fetch pool replaces an aborted SSE connection with just such a socket.
        // It owns no admitted work, so shutdown must release it explicitly.
        for (const socket of this.connectionsWithoutRequests) socket.destroy();
        // A client's standalone event stream carries no call either, and its
        // client may never hang up. Ending it finishes its response, which
        // releases the connection.
        for (const end of this.standaloneStreams) end();
      });
    }
    this.port = undefined;
    this.contextsByToken.clear();
    this.codexStdioTokens.clear();
    this.tokensByBoundThread.clear();
    this.jobMonitorListings.clear();
  }

  private tokenForContext(context: AgentToolMcpClientContext, transport: "http" | "stdio" = "http"): string {
    const normalizedThreadId = context.threadId?.trim();
    const normalizedContext = {
      backend: context.backend,
      ...(context.stdioFallback ? { stdioFallback: true } : {}),
      ...(context.managedReview ? { managedReview: true } : {}),
      ...(context.tokenMiserEnabled ? { tokenMiserEnabled: true } : {}),
      ...(normalizedThreadId ? { threadId: normalizedThreadId } : {}),
    };
    if (normalizedThreadId) {
      const key = boundThreadKey(context, normalizedThreadId, transport);
      const existing = this.tokensByBoundThread.get(key);
      if (existing) {
        this.contextsByToken.set(existing, normalizedContext);
        return existing;
      }
    }
    const token = randomBytes(32).toString("base64url");
    this.contextsByToken.set(token, normalizedContext);
    if (normalizedThreadId) {
      this.tokensByBoundThread.set(
        boundThreadKey(context, normalizedThreadId, transport),
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
      this.connectionsWithoutRequests.delete(request.socket);
      // Shutdown closes idle connections at once but lets an admitted response
      // finish. Once it has, nothing but the client's keep-alive timer (about
      // 3 seconds in undici) would close that connection, and close() would
      // wait for it. Release it as soon as its response is done.
      const socket = request.socket;
      response.once("finish", () => {
        if (this.closed) socket.destroySoon();
      });
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
    httpServer.on("connection", (socket) => {
      if (this.closed) {
        socket.destroy();
        return;
      }
      this.connectionsWithoutRequests.add(socket);
      socket.once("close", () => this.connectionsWithoutRequests.delete(socket));
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
    responseFlushed?: Promise<void>;
  }): Promise<Response> {
    // A reload gets a distinct URL scope even when the thread keeps its
    // bearer. Sign the MCP session for that scope so another connection's
    // listing cannot satisfy the reload, including an in-flight old list.
    const scope = new URL(params.request.url).searchParams.get(JOB_MONITOR_CATALOG_SCOPE);
    const sessionKey = scope ? `${params.token}:${scope}` : params.token;
    const listing = this.jobMonitorListings.get(params.token);
    const observedListing = listing?.scope === scope ? listing : undefined;
    const sessionId = params.request.headers.get(MCP_SESSION_HEADER);
    const sessionNonce = sessionId === null ? undefined : this.verifySession(sessionId, sessionKey);
    if (sessionId !== null && !sessionNonce) {
      return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }, { status: 404 });
    }
    if (sessionNonce && params.request.method === "DELETE") {
      // Signed sessions carry identity only and expire with the server.
      return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
    }
    // A tool call can wait for the operator, a renderer or long work, so it
    // is answered as a stream whose headers go out at once. Every other
    // request answers at once and stays a single JSON response.
    const [{ WebStandardStreamableHTTPServerTransport }, { isInitializeRequest }] =
      await Promise.all([mcpServerStreamableHttp.load(), mcpTypes.load()]);
    const body = await readMcpRequestBody(params.request);
    const messages = Array.isArray(body) ? body : [body];
    const streamed = !params.clientContext.stdioFallback && messages.some((message) =>
      !!message && typeof message === "object" && (message as { method?: unknown }).method === "tools/call");
    const initializing = messages.some(isInitializeRequest);
    if (initializing && sessionNonce) {
      return Response.json({ jsonrpc: "2.0", error: { code: -32600, message: "Session already initialized" }, id: null }, { status: 400 });
    }
    // Let the SDK issue the session header on initialize. Later requests
    // verify the signed identity here and keep their isolated transports.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: !streamed,
      sessionIdGenerator: initializing ? () => this.createSession(sessionKey) : undefined,
    });
    const toolCalls: Promise<unknown>[] = [];
    const clientGone = new AbortController();
    const disconnectSignal = AbortSignal.any([clientGone.signal, params.request.signal]);
    const mcpServer = await this.createProtocolServer({
      readContext: () => params.clientContext,
      sessionNonce,
      token: params.token,
      disconnectSignal,
      responseFlushed: () => params.responseFlushed,
      onToolCall: (call) => toolCalls.push(call.catch(() => undefined)),
      ...(observedListing ? { observedListing } : {}),
    });
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

  private async createProtocolServer(params: {
    readContext: () => AgentToolMcpClientContext;
    sessionNonce?: string;
    token: string;
    disconnectSignal: AbortSignal;
    responseFlushed: (id: RequestId) => Promise<void> | undefined;
    onToolCall?: (call: Promise<unknown>) => void;
    observedListing?: JobMonitorCatalogListing;
    isAuthorized?: () => boolean;
  }) {
    const [
      { Server: McpProtocolServer },
      {
        CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema,
        ListToolsRequestSchema, McpError, ReadResourceRequestSchema,
      },
      { ListSkillsRequestSchema, GetSkillRequestSchema },
    ] = await Promise.all([mcpServerSdk.load(), mcpTypes.load(), skillRequestSchemas.load()]);
    const context = params.readContext();
    const toolNames = (await this.resolveMcpTools(context)).map((tool) => tool.name);
    const isAntigravity = usesAntigravityCatalog(context);
    const discoveryTools = isAntigravity ? await this.resolveAntigravityDiscoveryTools(context) : [];
    const deferTools = canDeferAntigravityTools(discoveryTools);
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
        instructions: context.managedReview
          ? "PwrAgent in-memory review candidate ledger for this review turn."
          : buildPwrAgentMcpInstructions(toolNames)
            + (deferTools
              ? ` ${ANTIGRAVITY_TOOL_DISCOVERY_INSTRUCTIONS}` : "")
            + (isAntigravity && toolNames.includes("search_mcp_tools") && toolNames.includes("call_mcp_tool")
              ? ` ${ANTIGRAVITY_MCP_CONNECTION_INSTRUCTIONS}` : ""),
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
      return { resources: skills.flatMap((skill) => skill.resources) };
    });
    mcpServer.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      rejectSkillCursor(request.params?.cursor);
      return { resourceTemplates: [] };
    });
    mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const content = skills
        .flatMap((skill) => skill.contents)
        .find((candidate) => candidate.uri === request.params.uri);
      if (!content) {
        throw new McpError(-32002, "Unknown resource URI.");
      }
      return { contents: [content] };
    });
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      const catalog = await this.resolveMcpTools(params.readContext());
      // Only defer tools if the agent may invoke them through the dispatcher.
      const tools = deferTools
        ? [...catalog.filter(({ name }) => ANTIGRAVITY_DIRECT_MCP_TOOLS.has(name)), ...discoveryTools]
        : [...catalog, ...discoveryTools];
      if (params.observedListing && params.sessionNonce) {
        params.observedListing.enabled = tools.some(({ name }) => name === "create_monitor_delegation");
      }
      return { tools };
    });
    mcpServer.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        const progressToken = request.params._meta?.progressToken;
        // One counter for heartbeats and reported lines: MCP requires the
        // progress value to increase with every notification.
        let progress = 0;
        let message = AGENT_TOOL_MCP_DEFAULT_PROGRESS_MESSAGE;
        let lastSentAt = Number.NEGATIVE_INFINITY;
        let settled = false;
        const sendProgress = () => {
          if (settled) return;
          progress += 1;
          lastSentAt = Date.now();
          void extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: progressToken!, progress, message },
          }).catch(() => undefined);
        };
        const heartbeat = progressToken === undefined
          ? undefined
          : setInterval(sendProgress, this.options.progressIntervalMs ?? AGENT_TOOL_MCP_PROGRESS_INTERVAL_MS);
        heartbeat?.unref?.();
        // A client that stopped reading no longer needs progress.
        const stopHeartbeat = () => {
          settled = true;
          clearInterval(heartbeat);
        };
        params.disconnectSignal.addEventListener("abort", stopHeartbeat, { once: true });
        const reportProgress = progressToken === undefined
          ? undefined
          : (line: string) => {
              message = line;
              if (Date.now() - lastSentAt >= AGENT_TOOL_MCP_REPORTED_PROGRESS_MIN_GAP_MS) sendProgress();
            };
        const call = this.callTool(request, extra, params.token, params.disconnectSignal, params.sessionNonce,
          params.responseFlushed(extra.requestId), reportProgress, params.isAuthorized);
        params.onToolCall?.(call);
        try {
          return await call;
        } finally {
          params.disconnectSignal.removeEventListener("abort", stopHeartbeat);
          stopHeartbeat();
        }
      },
    );
    return mcpServer;
  }

  private async openCodexSession(socket: Duplex, token: string, isAuthorized: () => boolean): Promise<void> {
    const context = this.contextsByToken.get(token);
    if (!context || !this.codexStdioTokens.has(token) || !isAuthorized()) {
      socket.destroy();
      return;
    }
    const [{ StdioServerTransport }, types] = await Promise.all([mcpServerStdio.load(), mcpTypes.load()]);
    const transport = new StdioServerTransport(socket, socket, { maxBufferSize: PWRAGENT_MCP_HTTP_MAX_REQUEST_BYTES });
    const disconnected = new AbortController();
    const responses = new Map<RequestId, ReturnType<typeof createResponseFlush>>();
    const inFlight = new Set<RequestId>();
    const initializeDeadline = setTimeout(() => socket.destroy(), 10_000);
    initializeDeadline.unref();
    socket.once("close", () => {
      clearTimeout(initializeDeadline);
      disconnected.abort();
      for (const flush of responses.values()) flush.finish(new Error("Codex MCP connection closed."));
      responses.clear();
      void transport.close();
    });
    const server = await this.createProtocolServer({
      readContext: () => this.contextsByToken.get(token) ?? context,
      token,
      sessionNonce: randomUUID(),
      disconnectSignal: disconnected.signal,
      observedListing: this.jobMonitorListings.get(token),
      isAuthorized,
      responseFlushed: (id) => {
        const flush = createResponseFlush();
        responses.set(id, flush);
        return flush.promise;
      },
    });
    if (!isAuthorized()) {
      socket.destroy();
      return;
    }
    transport.onerror = () => socket.destroy();
    transport.onclose = () => socket.destroy();
    let initializeId: RequestId | undefined;
    let initializeAnswered = false;
    transport.send = async (message) => {
      if (!isAuthorized() || socket.writableLength > 4 * PWRAGENT_MCP_HTTP_MAX_REQUEST_BYTES) {
        socket.destroy();
        throw new Error("Codex MCP connection is unavailable.");
      }
      let flush: ReturnType<typeof createResponseFlush> | undefined;
      if ((types.isJSONRPCResultResponse(message) || types.isJSONRPCErrorResponse(message)) && message.id !== undefined) {
        flush = responses.get(message.id);
        responses.delete(message.id);
        inFlight.delete(message.id);
        if (message.id === initializeId) initializeAnswered = types.isJSONRPCResultResponse(message);
      }
      await new Promise<void>((resolve, reject) => {
        socket.write(JSON.stringify(message) + "\n", (error) => {
          flush?.finish(error ?? undefined);
          if (error) reject(error);
          else resolve();
        });
      });
    };
    // The SDK owns parsing and negotiation. Guard message admission at the
    // socket boundary, including reads that are not tied to an active turn.
    let initialized = false;
    const connect = server.connect(transport);
    const receive = transport.onmessage;
    transport.onmessage = (message) => {
      if (!isAuthorized()) return void socket.destroy();
      if (!initialized) {
        if (initializeId === undefined && types.isJSONRPCRequest(message) && types.isInitializeRequest(message)) {
          initializeId = message.id;
        } else if (initializeAnswered && types.isInitializedNotification(message)) {
          initialized = true;
          clearTimeout(initializeDeadline);
        }
        else return void socket.destroy();
      }
      if (types.isJSONRPCRequest(message)) {
        if (inFlight.has(message.id) || inFlight.size >= 64) return void socket.destroy();
        inFlight.add(message.id);
      } else if (types.isJSONRPCNotification(message) && message.method === "notifications/cancelled") {
        const cancelled = types.CancelledNotificationSchema.safeParse(message);
        const id = cancelled.data?.params.requestId;
        if (id !== undefined) {
          inFlight.delete(id);
          responses.get(id)?.finish(new Error("The Codex MCP request was cancelled."));
          responses.delete(id);
        }
      }
      receive?.(message);
    };
    await connect;
    socket.resume();
  }

  private async callTool(
    request: CallToolRequest,
    extra: CallToolExtra,
    token: string,
    disconnectSignal: AbortSignal,
    sessionNonce: string | undefined,
    responseFlushed?: Promise<void>,
    reportProgress?: (message: string) => void,
    isAuthorized?: () => boolean,
  ): Promise<AgentMcpToolCallResponse> {
    const clientContext = this.contextsByToken.get(token);
    if (!clientContext) {
      return forbiddenMcpResponse("Unknown PwrAgent MCP client.");
    }
    if (!clientContext.threadId) {
      return forbiddenMcpResponse(
        "PwrAgent MCP tools are callable only after the client is bound to a thread.",
      );
    }
    // Codex native subagents can inherit the parent's connection config.
    if (this.options.verifyCodexThreadId
      && clientContext.backend === "codex"
      && request.params._meta?.threadId !== clientContext.threadId) {
      return forbiddenMcpResponse("The Codex tool call must identify the registered thread.");
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
    if (!allowsStdioFallbackTool(clientContext, request.params.name)) {
      return forbiddenMcpResponse("This ACP stdio client may call agent_memory and list_reviews only.");
    }
    let { name, arguments: args } = request.params;
    if (usesAntigravityCatalog(clientContext) && (name === PWRAGENT_TOOL_SEARCH || name === CALL_PWRAGENT_TOOL)) {
      const denial = await this.toolPermissionDenial(callContext, name, args);
      if (denial) return denial;
      if (!await this.isToolAdvertised(name, clientContext)) {
        return forbiddenMcpResponse("This client may not call the requested PwrAgent discovery tool.");
      }
      if (name === PWRAGENT_TOOL_SEARCH) {
        const catalog = await this.resolveMcpTools(clientContext);
        return toMcpToolResponse(searchPwrAgentMcpTools(catalog, args ?? {}));
      }
      if (name === CALL_PWRAGENT_TOOL) {
        const target = readPwrAgentCallTarget(args);
        if (!target) {
          return invalidMcpArguments("Provide a toolName and an arguments object.");
        }
        if (!await this.resolveMcpTool(clientContext, target.name)) return unsupportedMcpTool();
        ({ name, args } = target);
      }
    }
    const catalogs = await this.options.resolveCatalogs(clientContext);
    const catalog = catalogs.find((candidate) =>
      candidate.router.acceptsMcpToolCall({
        tool: name,
      }),
    );
    if (!catalog) {
      return unsupportedMcpTool();
    }
    const denial = await this.toolPermissionDenial(callContext, name, args, catalog.id);
    if (denial) return denial;
    if (!sessionNonce && MCP_TOOLS_REQUIRING_SESSION.has(name)) {
      return forbiddenMcpResponse(
        "This tool requires an MCP session to prevent duplicate mutations. Initialize the connection and send the returned Mcp-Session-Id header.",
      );
    }
    if (isAuthorized && !isAuthorized()) return forbiddenMcpResponse("The Codex MCP registration has ended.");
    const result = await catalog.router.handleMcpToolCall({
      backend: callContext.backend,
      threadId: callContext.threadId,
      turnId: callContext.turnId,
      // A retry carries the original session and typed wire ID. A sessionless
      // request has no way to establish that it is retrying an earlier call.
      callId: sessionNonce
        ? createHash("sha256").update(JSON.stringify([sessionNonce, callContext.turnId, extra.requestId])).digest("base64url")
        : randomUUID(),
      tool: name,
      args,
      signal: name === "resource_checkout_acquire"
        ? AbortSignal.any([extra.signal, disconnectSignal])
        : extra.signal,
      responseFlushed,
      ...(reportProgress ? { reportProgress } : {}),
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

  private signSession(nonce: string, token: string): string {
    return createHmac("sha256", this.sessionSigningKey).update(`${nonce}.${token}`).digest("base64url");
  }

  private createSession(token: string): string {
    const nonce = randomUUID();
    return `${nonce}.${this.signSession(nonce, token)}`;
  }

  private verifySession(sessionId: string, token: string): string | undefined {
    const match = /^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/u.exec(sessionId);
    if (!match) return undefined;
    const [, nonce, signature] = match;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(this.signSession(nonce, token))) ? nonce : undefined;
  }

  private async toolPermissionDenial(
    context: ResolvedAgentToolMcpCallContext,
    name: string,
    args: unknown,
    catalogId?: AgentToolMcpAuthorization["catalogId"],
  ): Promise<AgentMcpToolCallResponse | undefined> {
    const denied = await this.options.authorizeToolCall?.({ ...context, catalogId, tool: name, arguments: args });
    return denied ? forbiddenMcpResponse(agentToolPermissionDeniedMessage(name, denied)) : undefined;
  }

  private async isToolAdvertised(name: string, context: AgentToolMcpClientContext): Promise<boolean> {
    return (await this.options.isToolAdvertised?.(name, context)) ?? true;
  }

  private async resolveAntigravityDiscoveryTools(context: AgentToolMcpClientContext): Promise<AgentMcpTool[]> {
    const tools: AgentMcpTool[] = [];
    for (const tool of ANTIGRAVITY_TOOL_DISCOVERY) {
      if (await this.isToolAdvertised(tool.name, context)) tools.push(tool);
    }
    return tools;
  }

  /** One tool in the full allowed catalog, without checking the others. */
  private async resolveMcpTool(context: AgentToolMcpClientContext, name: string): Promise<AgentMcpTool | undefined> {
    if (!allowsStdioFallbackTool(context, name)) return undefined;
    const catalogs = await this.options.resolveCatalogs(context);
    const matches = catalogs
      .flatMap((catalog) => catalog.router.buildMcpTools())
      .filter((tool) => tool.name === name);
    if (matches.length !== 1) return undefined;
    if (!await this.isToolAdvertised(name, context)) return undefined;
    return matches[0];
  }

  private async resolveMcpTools(context: AgentToolMcpClientContext): Promise<AgentMcpTool[]> {
    const toolsByName = new Map<string, AgentMcpTool>();
    for (const catalog of await this.options.resolveCatalogs(context)) {
      for (const tool of catalog.router.buildMcpTools()) {
        if (!allowsStdioFallbackTool(context, tool.name)) continue;
        if (!await this.isToolAdvertised(tool.name, context)) continue;
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
      && !this.codexStdioTokens.has(token) ? this.contextsByToken.get(token) : undefined;
    if (!token || !clientContext) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="pwragent-mcp"');
      writeJsonResponse(response, 401, {
        error: "Unauthorized.",
      });
      return;
    }
    const flush = createResponseFlush();
    response.once("finish", () => flush.finish());
    response.once("close", () => { if (!response.writableFinished) flush.finish(new Error("MCP client disconnected before acknowledgement.")); });
    const webResponse = await this.handleMcpProtocolRequest({
      request: await toWebRequest(request, requestUrl),
      token,
      clientContext,
      responseFlushed: flush.promise,
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
    const standalone = request.method === "GET";
    if (standalone) this.standaloneStreams.add(cancel);
    try {
      if (response.destroyed || (standalone && this.closed)) cancel();
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
      flush.finish(error instanceof Error ? error : new Error(String(error)));
      cancel();
      throw error;
    } finally {
      finished = true;
      this.standaloneStreams.delete(cancel);
      response.end();
    }
  }
}

/** Inspect POSTs before selecting transport options. The SDK validates the wire body. */
async function readMcpRequestBody(request: Request): Promise<unknown> {
  if (request.method !== "POST") return undefined;
  try {
    return await request.clone().json();
  } catch {
    return undefined;
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
        onCancel();
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
    // Runs inside a request handler, after the SDK has loaded.
    const { ErrorCode, McpError } = loadedMcpTypes();
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

function invalidMcpArguments(message: string): AgentMcpToolCallResponse {
  return toMcpToolResponse(agentToolFailure({ code: "invalid_arguments", message }));
}

function unsupportedMcpTool(): AgentMcpToolCallResponse {
  return toMcpToolResponse(agentToolFailure({
    code: "unsupported_operation",
    message: "Unsupported PwrAgent MCP tool.",
  }));
}

function allowsStdioFallbackTool(context: AgentToolMcpClientContext, name: string): boolean {
  return !context.stdioFallback || name === "agent_memory" || name === "list_reviews";
}

function usesAntigravityCatalog(context: AgentToolMcpClientContext): boolean {
  return context.backend === "acp:antigravity"
    && !context.stdioFallback
    && !context.managedReview;
}

function canDeferAntigravityTools(discoveryTools: readonly AgentMcpTool[]): boolean {
  return discoveryTools.some(({ name }) => name === PWRAGENT_TOOL_SEARCH)
    && discoveryTools.some(({ name }) => name === CALL_PWRAGENT_TOOL);
}

function boundThreadKey(
  context: AgentToolMcpClientContext,
  threadId: string,
  transport: "http" | "stdio",
): string {
  return JSON.stringify([
    transport,
    context.backend,
    threadId,
    context.stdioFallback === true,
    context.managedReview === true,
  ]);
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
    if (totalBytes > PWRAGENT_MCP_HTTP_MAX_REQUEST_BYTES) {
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
