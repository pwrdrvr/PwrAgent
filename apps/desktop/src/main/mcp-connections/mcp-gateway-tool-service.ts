import type { CallToolResult, ElicitRequestParams, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import type { McpConnectionGatewayService } from "./mcp-connection-gateway-service";
import { gatewayCatalogRevision, validateGatewayArguments, type McpGatewayCatalog, type McpGatewayInvocation, type McpGatewayTool, type McpGatewaySource, type McpGatewayIdentity } from "./mcp-gateway-catalog";
import {
  MCP_CONNECTION_TOOL_MAX_TOTAL_TIMEOUT_MS,
  MCP_CONNECTION_TOOL_TIMEOUT_MS,
  MCP_DISCOVERY_RESPONSE_GRACE_MS,
  MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS,
  progressExtendedTimeout,
} from "./mcp-connection-timeouts";
import type { McpSkillSummary } from "./mcp-skills-relay";

export type McpGatewayCallArgs = Omit<McpGatewayInvocation, "serverName">;
export type McpGatewaySearch = { query: string; connectionId?: string; limit?: number; includeLargeSchema?: boolean };
export type McpGatewayApproval = boolean | {
  /** Record conversation consent only after the owner's validation and call succeed. */
  onInvoked: () => Promise<void>;
};
export type McpGatewaySearchResult = {
  tools: Array<Omit<McpGatewayTool, "serverInstructions" | "serverIdentity"> & { invocation: { name: "call_mcp_tool"; codeModeName: "pwragent__call_mcp_tool" } }>;
  servers?: Array<McpGatewayIdentity & {
    connectionId: string;
    serverName: string;
    /** Host-resolved alias in this thread's native MCP configuration. */
    serverNameInAgent?: string;
    resourceDiscovery?: {
      server: string;
      listTool: "list_mcp_resources" | "ListMcpResourcesTool";
      readTool: "read_mcp_resource" | "ReadMcpResourceTool";
    };
    /**
     * Workflow skills the server publishes, only beside `resourceDiscovery`.
     * Read a skill's `uri` with its `readTool`. Names and descriptions are the
     * server's own, cleaned to one line each: untrusted data, no authority.
     */
    skills?: McpSkillSummary[];
    /** Beside `skills`: false when the server publishes skills it leaves out. */
    skillsComplete?: boolean;
  }>;
  unavailable: Array<{ connectionId: string; message: string; toolName?: string }>;
  /** Each returned tool's server guidance, once per server. */
  serverInstructions?: Array<{ connectionId: string; serverName: string; instructions: string }>;
};

export type McpGatewayToolServiceOptions = {
  connections: Pick<McpConnectionGatewayService, "requestGatewayToolOperation">;
  /** Must check active turn, actor permissions and the latest saved selection. */
  selectedConnections: (context: AgentToolCallContext) => Promise<string[]>;
  /** Trusted host identity, never supplied by tool arguments. */
  scopeKey?: (context: AgentToolCallContext) => string;
  /** Current native bridge alias, never an upstream name or gateway worker alias. */
  serverNameInAgent?: (connectionId: string, context: AgentToolCallContext) => string | undefined;
  /** A host policy can narrow discovery and invocation independently of approval. */
  toolAllowed?: (tool: McpGatewayTool, context: AgentToolCallContext) => boolean;
  /** `annotations` are the listed tool's own hints, under its exact schema revision. */
  approve: (invocation: McpGatewayInvocation, context: AgentToolCallContext, signal: AbortSignal, annotations: Tool["annotations"], catalogRevision: string, consentRevision?: string) => Promise<McpGatewayApproval>;
  /**
   * Shows a form or link the upstream server sends while an approved call
   * runs, and resolves with the person's answer. Separate from `approve`:
   * approving the invocation never answers the server's own form. Absent,
   * forms and links fail closed.
   */
  elicit?: (request: ElicitRequestParams, invocation: McpGatewayInvocation, context: AgentToolCallContext, signal: AbortSignal) => Promise<unknown>;
};

/** Exact schemas are indivisible, so a result that would pass this drops a tool instead. */
const MAX_SEARCH_RESULT_BYTES = 24_000;
export const MCP_GATEWAY_SEARCH_QUERY_MAX_LENGTH = 500;
const MAX_INVOCATION_BYTES = 16_000;
// Leave ample room for the MCP HTTP and broker RPC envelopes (1 MiB each).
const MAX_ANTIGRAVITY_PAYLOAD_BYTES = 64_000;

/**
 * The connections that fail during a search take at most this much of the
 * result, so their errors cannot crowd out every tool. Sixty-four failures
 * with 64-character ids fit in their short form.
 */
const MAX_CONNECTION_ERROR_BYTES = 10_000;

/** What a failed connection says once its own error no longer fits. */
const CONNECTION_ERROR_OMITTED = "Unavailable. Search this connectionId alone for the error.";

/** A display-only tool name can be abbreviated. A retry query must stay exact. */
const MAX_NOTICE_PREVIEW_CHARS = 128;

/**
 * A search returns at most this many tools, the tool contract's own limit.
 * The budget's room for notices assumes no more.
 */
const MAX_SEARCH_LIMIT = 5;

type McpGatewayUnavailable = McpGatewaySearchResult["unavailable"][number];

/** What a search says about a tool whose exact schema the result has no room for. */
function schemaBudgetNotice(tool: McpGatewaySource, antigravity: boolean, includeLargeSchema: boolean): McpGatewayUnavailable {
  const { connectionId, toolName } = tool;
  if (antigravity && !includeLargeSchema && toolName.length > 0
    && toolName.length <= MCP_GATEWAY_SEARCH_QUERY_MAX_LENGTH && toolName === toolName.trim()) {
    return {
      connectionId, toolName,
      message: "The exact schema exceeds this result's size budget. Search with this connectionId, toolName as query, and includeLargeSchema: true.",
    };
  }
  // Counted in code points, so a cut never leaves half a surrogate pair.
  const characters = Array.from(toolName);
  const longName = characters.length > MAX_NOTICE_PREVIEW_CHARS;
  const name = longName ? `${characters.slice(0, MAX_NOTICE_PREVIEW_CHARS - 1).join("")}…` : toolName;
  if (antigravity) {
    const guidance = includeLargeSchema
      ? "The exact schema cannot be delivered through this gateway."
      : "This tool name cannot be used as an exact search query.";
    return {
      connectionId,
      message: `The exact schema for ${name} exceeds this result's size budget. ${guidance}`,
    };
  }
  const query = longName ? "Search part of its name with this connectionId alone," : "Search its exact name alone";
  return {
    connectionId: tool.connectionId,
    message: `The exact schema for ${name} exceeds this result's size budget. ${query} or use native MCP invocation.`,
  };
}

/**
 * Fits the failed connections' entries into `room` bytes of JSON, in order.
 * Every failed connection keeps an entry. Its own error stays while it fits
 * beside the short form of every entry after it; otherwise the entry says
 * only that the connection is unavailable.
 */
function fitConnectionErrors(entries: McpGatewayUnavailable[], room: number): McpGatewayUnavailable[] {
  const short = entries.map(({ connectionId }) => ({ connectionId, message: CONNECTION_ERROR_OMITTED }));
  // Full retry names can leave less room than the ordinary short errors need.
  const omitted = Buffer.byteLength(JSON.stringify(short)) <= room
    ? short
    : short.map(({ connectionId }) => ({ connectionId, message: "Unavailable." }));
  const omittedBytes = omitted.map((entry) => Buffer.byteLength(JSON.stringify(entry)));
  // Every later entry in its short form, with the comma before it.
  let laterBytes = omittedBytes.reduce((sum, bytes) => sum + bytes + 1, 0);
  // "[]" is the empty list's own two bytes.
  let bytes = 2;
  return entries.map((entry, index) => {
    laterBytes -= omittedBytes[index] + 1;
    const comma = index > 0 ? 1 : 0;
    const full = Buffer.byteLength(JSON.stringify(entry));
    const fitted = bytes + comma + full + laterBytes <= room ? entry : omitted[index];
    bytes += comma + (fitted === entry ? full : omittedBytes[index]);
    return fitted;
  });
}

type McpGatewaySearchServer = NonNullable<McpGatewaySearchResult["servers"]>[number];

function serverEntry(
  connectionId: string,
  serverName: string,
  identity: McpGatewayIdentity | undefined,
  serverNameInAgent: string | undefined,
  resourceTools: Pick<NonNullable<McpGatewaySearchServer["resourceDiscovery"]>, "listTool" | "readTool"> | undefined,
): McpGatewaySearchServer {
  return {
    ...identity, connectionId, serverName,
    ...(serverNameInAgent ? {
      serverNameInAgent,
      ...(resourceTools ? { resourceDiscovery: { server: serverNameInAgent, ...resourceTools } } : {}),
    } : {}),
  };
}

/** No disk catalog. Every invocation revalidates
 * its current source on the owner broker after scoped approval has completed.
 */
export class McpGatewayToolService {
  private readonly running = new Set<{ context: AgentToolCallContext; controller: AbortController }>();

  constructor(private readonly options: McpGatewayToolServiceOptions) {}

  cancel(backend?: string, threadId?: string, turnId?: string): void {
    for (const entry of this.running) {
      if ((!backend || entry.context.backend === backend)
        && (!threadId || entry.context.threadId === threadId)
        && (!turnId || entry.context.turnId === turnId)) {
        entry.controller.abort(new DOMException("MCP gateway call cancelled.", "AbortError"));
      }
    }
  }

  async search(args: McpGatewaySearch, context: AgentToolCallContext): Promise<McpGatewaySearchResult> {
    const antigravity = context.backend === "acp:antigravity";
    const includeLargeSchema = args.includeLargeSchema === true;
    if (includeLargeSchema && (!antigravity || !args.connectionId)) {
      throw new Error("includeLargeSchema requires Antigravity and a connectionId. Set query to the exact tool name.");
    }
    const resultBudget = includeLargeSchema ? MAX_ANTIGRAVITY_PAYLOAD_BYTES : MAX_SEARCH_RESULT_BYTES;
    return await this.run(context, MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS, async (signal, deadlineAt) => {
      const selected = await this.options.selectedConnections(context);
      if (args.connectionId && !selected.includes(args.connectionId)) throw new Error("This connection is not selected for the calling thread.");
      const ids = args.connectionId ? [args.connectionId] : [...new Set(selected)];
      if (ids.length > 64) throw new Error("Specify a connectionId when searching more than 64 selected connections.");
      const candidates: McpGatewayTool[] = [];
      const identities = new Map<string, McpGatewayIdentity>();
      const instructions = new Map<string, { serverName: string; instructions: string }>();
      const skills = new Map<string, NonNullable<McpGatewayCatalog["serverSkills"]>>();
      const serverNames = new Map<string, string>();
      /** Connections with at least one tool, before host policy narrows them. */
      const listsTools = new Set<string>();
      let candidateBytes = 0;
      const unavailable: McpGatewaySearchResult["unavailable"] = [];
      const resourceTools = context.backend === "codex"
        ? { listTool: "list_mcp_resources" as const, readTool: "read_mcp_resource" as const }
        : context.backend === "claude"
          ? { listTool: "ListMcpResourcesTool" as const, readTool: "ReadMcpResourceTool" as const }
          : undefined;
      // Bounded fan-out; one slow server must not consume every socket.
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (next < ids.length) {
          const connectionId = ids[next++];
          try {
            await this.requireSelected(connectionId, context, signal);
            const listed = await this.options.connections.requestGatewayToolOperation({
              connectionId, scopeKey: this.scopeKey(context), operation: "gateway/tools/list", signal, deadlineAt,
              // A skill is a resource, so only a backend with a resource reader asks.
              ...(resourceTools ? { skills: true } : {}),
            }) as McpGatewayTool[] | McpGatewayCatalog;
            await this.requireSelected(connectionId, context, signal);
            const bytes = Buffer.byteLength(JSON.stringify(listed));
            if (candidateBytes + bytes > 8 * 1024 * 1024) throw new Error("Search a specific connectionId to stay within the catalog memory budget.");
            candidateBytes += bytes;
            // An owner that predates the envelope answers with the bare list.
            const tools = Array.isArray(listed) ? listed : listed.tools;
            if (!Array.isArray(listed)) {
              serverNames.set(connectionId, listed.serverName);
              if (listed.serverIdentity) identities.set(connectionId, listed.serverIdentity);
              if (listed.serverSkills) skills.set(connectionId, listed.serverSkills);
            }
            if (tools.length > 0) listsTools.add(connectionId);
            for (const { serverInstructions, serverIdentity, ...tool } of tools) {
              if (serverIdentity && !identities.has(connectionId)) identities.set(connectionId, serverIdentity);
              if (!serverNames.has(connectionId)) serverNames.set(connectionId, tool.serverName);
              if (this.options.toolAllowed?.(tool, context) === false) continue;
              if (serverInstructions) {
                instructions.set(connectionId, { serverName: tool.serverName, instructions: serverInstructions });
              }
              candidates.push(tool);
            }
          } catch (error) {
            signal.throwIfAborted();
            unavailable.push({ connectionId, message: (error instanceof Error ? error.message : String(error)).slice(0, 180) });
          }
        }
      }));
      const current = new Set(await this.options.selectedConnections(context));
      signal.throwIfAborted();
      const terms = args.query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
      const scoreText = (text: string): number => {
        const lower = text.toLowerCase();
        return terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      };
      const skillScore = (skill: McpSkillSummary): number => scoreText(`${skill.name} ${skill.description ?? ""}`);
      const ranked = candidates.filter((tool) => current.has(tool.connectionId)
        && (!includeLargeSchema || tool.toolName === args.query)).map((tool) => {
        const name = tool.toolName.toLowerCase();
        const text = `${tool.serverName} ${name} ${tool.definition.description ?? ""}`.toLowerCase();
        const score = name === args.query.toLowerCase() ? 10_000
          : terms.reduce((sum, term) => sum + (name.includes(term) ? 8 : text.includes(term) ? 1 : 0), 0);
        return { tool, score };
      }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score
        || a.tool.connectionId.localeCompare(b.tool.connectionId) || a.tool.toolName.localeCompare(b.tool.toolName));
      // The tools below start from the failed connections' entries, so those
      // are fitted first, into a share that leaves room for every notice.
      // They are fitted in selection order, not the order the fan-out
      // finished in, so the same failures keep the same errors each search.
      const picked = ranked.slice(0, includeLargeSchema ? 1 : Math.min(args.limit ?? 3, MAX_SEARCH_LIMIT));
      const notices = picked.map(({ tool }) => schemaBudgetNotice(tool, antigravity, includeLargeSchema));
      const selectionOrder = new Map(ids.map((id, index) => [id, index]));
      unavailable.sort((left, right) => selectionOrder.get(left.connectionId)! - selectionOrder.get(right.connectionId)!);
      const errorBudget = Math.min(MAX_CONNECTION_ERROR_BYTES,
        resultBudget - Buffer.byteLength(JSON.stringify({ tools: [], unavailable: notices })));
      const result: McpGatewaySearchResult = { tools: [], unavailable: fitConnectionErrors(unavailable, errorBudget) };
      // A tool turned away adds its notice to `unavailable` after the tools
      // before it were measured, so each admission keeps room for the notice
      // of every candidate still to come, and for the comma before each one
      // that will not be the list's first entry.
      const noticeBytes = notices.map((notice) => Buffer.byteLength(JSON.stringify(notice)));
      let laterNoticeBytes = noticeBytes.reduce((sum, bytes) => sum + bytes, 0);
      for (const [index, { tool }] of picked.entries()) {
        laterNoticeBytes -= noticeBytes[index];
        const later = picked.length - index - 1;
        const reserved = later === 0 ? 0
          : laterNoticeBytes + later - (result.unavailable.length === 0 ? 1 : 0);
        const entry = { ...tool, invocation: { name: "call_mcp_tool" as const, codeModeName: "pwragent__call_mcp_tool" as const } };
        const identity = identities.get(tool.connectionId);
        const serverNameInAgent = this.options.serverNameInAgent?.(tool.connectionId, context);
        let servers = (identity || serverNameInAgent) && !result.servers?.some((entry) => entry.connectionId === tool.connectionId)
          ? [...(result.servers ?? []), serverEntry(tool.connectionId, tool.serverName, identity, serverNameInAgent, resourceTools)]
          : result.servers;
        const guidance = instructions.get(tool.connectionId);
        let serverInstructions = guidance && !result.serverInstructions?.some((entry) => entry.connectionId === tool.connectionId)
          ? [...(result.serverInstructions ?? []), { connectionId: tool.connectionId, ...guidance }]
          : result.serverInstructions;
        // Exact schemas are indivisible. Never return truncated valid-looking JSON.
        const next = { ...result, tools: [...result.tools, entry] };
        const fits = (serverEntries?: typeof servers, instructions?: typeof serverInstructions) =>
          Buffer.byteLength(JSON.stringify({ ...next, servers: serverEntries, serverInstructions: instructions })) + reserved <= resultBudget;
        if (!fits(servers, serverInstructions)) {
          if (!includeLargeSchema || !fits()) {
            result.unavailable.push(notices[index]);
            continue;
          }
          if (!fits(servers)) servers = undefined;
          if (!fits(servers, serverInstructions)) serverInstructions = undefined;
        }
        result.tools.push(entry);
        if (servers) result.servers = servers;
        if (serverInstructions) result.serverInstructions = serverInstructions;
      }
      // A server whose skills match the query is named even when none of
      // its tools did, or it has none: a skill is how a server says which
      // task it is for. A server whose every tool host policy hides stays
      // hidden, since its skills would steer toward those tools.
      for (const [connectionId, published] of [...skills].sort(([left], [right]) => left.localeCompare(right))) {
        if (!current.has(connectionId) || result.servers?.some((entry) => entry.connectionId === connectionId)) continue;
        if (!resourceTools || !published.skills.some((skill) => skillScore(skill) > 0)) continue;
        if (listsTools.has(connectionId) && !candidates.some((tool) => tool.connectionId === connectionId)) continue;
        const serverName = serverNames.get(connectionId);
        const serverNameInAgent = serverName ? this.options.serverNameInAgent?.(connectionId, context) : undefined;
        if (!serverName || !serverNameInAgent) continue;
        const servers = [...(result.servers ?? []), serverEntry(connectionId, serverName, identities.get(connectionId), serverNameInAgent, resourceTools)];
        if (Buffer.byteLength(JSON.stringify({ ...result, servers })) > MAX_SEARCH_RESULT_BYTES) continue;
        result.servers = servers;
      }
      // Skills go in last, in whatever room the exact schemas left, so they
      // never cost the result a tool. Those matching the query go first.
      for (const server of result.servers ?? []) {
        const published = skills.get(server.connectionId);
        if (!published || !server.resourceDiscovery) continue;
        const ranked = published.skills
          .map((skill, index) => ({ skill, index, score: skillScore(skill) }))
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .map(({ skill }) => skill);
        // Measured once with the longer `false`; each skill adds its own JSON
        // and a comma, so the result is never serialized per skill.
        server.skills = [];
        server.skillsComplete = false;
        let bytes = Buffer.byteLength(JSON.stringify(result));
        let complete = published.complete;
        for (const skill of ranked) {
          const size = Buffer.byteLength(JSON.stringify(skill)) + (server.skills.length > 0 ? 1 : 0);
          if (bytes + size > MAX_SEARCH_RESULT_BYTES) {
            complete = false;
            break;
          }
          server.skills.push(skill);
          bytes += size;
        }
        server.skillsComplete = complete;
        if (server.skills.length === 0) {
          delete server.skills;
          delete server.skillsComplete;
        }
      }
      return result;
    });
  }

  async call(args: McpGatewayCallArgs, context: AgentToolCallContext): Promise<{ source: McpGatewaySource; result: CallToolResult }> {
    const antigravity = context.backend === "acp:antigravity";
    const limit = antigravity ? MAX_ANTIGRAVITY_PAYLOAD_BYTES : MAX_INVOCATION_BYTES;
    if (Buffer.byteLength(JSON.stringify(args)) > limit) {
      throw new Error(antigravity
        ? `The MCP invocation exceeds the ${limit}-byte gateway size limit. No tool was invoked.`
        : "The MCP invocation exceeds the approval size limit. Use native MCP invocation for larger arguments.");
    }
    // The call's own cap starts after approval, which can take up to one
    // idle timeout, so the outer cap allows for it.
    return await this.run(context, MCP_CONNECTION_TOOL_TIMEOUT_MS, async (signal, _deadlineAt, extend) => {
      await this.requireSelected(args.connectionId, context, signal);
      const tools = await this.options.connections.requestGatewayToolOperation({
        connectionId: args.connectionId, scopeKey: this.scopeKey(context), operation: "gateway/tools/list", signal,
      }) as McpGatewayTool[];
      const tool = tools.find((entry) => entry.toolName === args.toolName);
      if (!tool || tool.schemaRevision !== args.schemaRevision) throw new Error("The tool schema or authorization changed. Search again.");
      if (this.options.toolAllowed?.(tool, context) === false) throw new Error("This MCP tool is not permitted for the calling thread.");
      await validateGatewayArguments(tool.definition, args.arguments);
      await this.requireSelected(args.connectionId, context, signal);
      const source: McpGatewaySource = {
        connectionId: tool.connectionId, serverName: tool.serverName,
        toolName: tool.toolName, schemaRevision: tool.schemaRevision,
      };
      const invocation = { ...source, arguments: args.arguments };
      const approval = tool.consentRevision
        ? await this.options.approve(invocation, context, signal, tool.definition.annotations, gatewayCatalogRevision(tools), tool.consentRevision)
        : await this.options.approve(invocation, context, signal, tool.definition.annotations, gatewayCatalogRevision(tools));
      if (!approval) throw new Error("The MCP tool invocation was not approved.");
      await this.requireSelected(args.connectionId, context, signal);
      if (this.options.toolAllowed?.(tool, context) === false) throw new Error("This MCP tool is no longer permitted for the calling thread.");
      // The owner lists and validates again, preventing schema/auth changes while
      // approval was pending from executing a different operation under that grant.
      const elicit = this.options.elicit;
      const result = await this.options.connections.requestGatewayToolOperation({
        connectionId: args.connectionId, scopeKey: this.scopeKey(context),
        operation: "gateway/tools/call", invocation, signal, onProgress: extend,
        // The thread's card shows forms and links alike.
        ...(elicit ? { elicitUrl: true, elicit: async (request: ElicitRequestParams, formSignal: AbortSignal) =>
          await elicit(request, invocation, context, AbortSignal.any([signal, formSignal])) } : {}),
      }) as CallToolResult;
      if (typeof approval === "object") await approval.onInvoked();
      return { source, result };
    }, MCP_CONNECTION_TOOL_MAX_TOTAL_TIMEOUT_MS + MCP_CONNECTION_TOOL_TIMEOUT_MS + MCP_DISCOVERY_RESPONSE_GRACE_MS);
  }

  private scopeKey(context: AgentToolCallContext): string {
    return this.options.scopeKey?.(context) ?? JSON.stringify(["gateway", context.backend, context.threadId]);
  }

  private async requireSelected(id: string, context: AgentToolCallContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!(await this.options.selectedConnections(context)).includes(id)) throw new Error("This connection is no longer selected for the calling thread.");
    signal.throwIfAborted();
  }

  /**
   * Runs one operation under `timeout`. With `maxTotalTimeout`, `extend`
   * restarts that timeout, as the upstream server's progress reports do,
   * but never past the total.
   */
  private async run<T>(
    context: AgentToolCallContext,
    timeout: number,
    operation: (signal: AbortSignal, deadlineAt: number, extend: () => void) => Promise<T>,
    maxTotalTimeout?: number,
  ): Promise<T> {
    const deadlineAt = Date.now() + timeout;
    const entry = { context, controller: new AbortController() };
    const idleMs = timeout + (timeout === MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS ? MCP_DISCOVERY_RESPONSE_GRACE_MS : 0);
    const deadline = maxTotalTimeout === undefined ? undefined : progressExtendedTimeout(idleMs, maxTotalTimeout);
    const signal = AbortSignal.any([
      entry.controller.signal,
      deadline?.signal ?? AbortSignal.timeout(idleMs),
      ...(context.signal ? [context.signal] : []),
    ]);
    this.running.add(entry);
    try {
      signal.throwIfAborted();
      return await operation(signal, deadlineAt, deadline?.extend ?? (() => undefined));
    } finally {
      deadline?.clear();
      this.running.delete(entry);
    }
  }
}
