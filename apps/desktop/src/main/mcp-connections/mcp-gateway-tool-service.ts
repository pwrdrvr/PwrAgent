import type { CallToolResult, ElicitRequestParams, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import type { McpConnectionGatewayService } from "./mcp-connection-gateway-service";
import { gatewayCatalogRevision, validateGatewayArguments, type McpGatewayInvocation, type McpGatewayTool, type McpGatewaySource, type McpGatewayIdentity } from "./mcp-gateway-catalog";
import {
  MCP_CONNECTION_TOOL_MAX_TOTAL_TIMEOUT_MS,
  MCP_CONNECTION_TOOL_TIMEOUT_MS,
  MCP_DISCOVERY_RESPONSE_GRACE_MS,
  MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS,
  progressExtendedTimeout,
} from "./mcp-connection-timeouts";
import type { McpSkillSummary } from "./mcp-skills-relay";

export type McpGatewayCallArgs = Omit<McpGatewayInvocation, "serverName">;
export type McpGatewaySearch = { query: string; connectionId?: string; limit?: number };
export type McpGatewayApproval = boolean | {
  /** Record conversation consent only after the owner's validation and call succeed. */
  onInvoked: () => Promise<void>;
};
export type McpGatewaySearchResult = {
  tools: Array<Omit<McpGatewayTool, "serverInstructions" | "serverIdentity" | "serverSkills"> & { invocation: { name: "call_mcp_tool"; codeModeName: "pwragent__call_mcp_tool" } }>;
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
  unavailable: Array<{ connectionId: string; message: string }>;
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
    return await this.run(context, MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS, async (signal, deadlineAt) => {
      const selected = await this.options.selectedConnections(context);
      if (args.connectionId && !selected.includes(args.connectionId)) throw new Error("This connection is not selected for the calling thread.");
      const ids = args.connectionId ? [args.connectionId] : [...new Set(selected)];
      if (ids.length > 64) throw new Error("Specify a connectionId when searching more than 64 selected connections.");
      const candidates: McpGatewayTool[] = [];
      const identities = new Map<string, McpGatewayIdentity>();
      const instructions = new Map<string, { serverName: string; instructions: string }>();
      const skills = new Map<string, NonNullable<McpGatewayTool["serverSkills"]>>();
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
            const tools = await this.options.connections.requestGatewayToolOperation({
              connectionId, scopeKey: this.scopeKey(context), operation: "gateway/tools/list", signal, deadlineAt,
              // A skill is a resource, so only a backend with a resource reader asks.
              ...(resourceTools ? { skills: true } : {}),
            }) as McpGatewayTool[];
            await this.requireSelected(connectionId, context, signal);
            const bytes = Buffer.byteLength(JSON.stringify(tools));
            if (candidateBytes + bytes > 8 * 1024 * 1024) throw new Error("Search a specific connectionId to stay within the catalog memory budget.");
            candidateBytes += bytes;
            for (const { serverInstructions, serverIdentity, serverSkills, ...tool } of tools) {
              if (serverIdentity) identities.set(connectionId, serverIdentity);
              if (serverSkills) skills.set(connectionId, serverSkills);
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
      const ranked = candidates.filter((tool) => current.has(tool.connectionId)).map((tool) => {
        const name = tool.toolName.toLowerCase();
        const text = `${tool.serverName} ${name} ${tool.definition.description ?? ""}`.toLowerCase();
        const score = name === args.query.toLowerCase() ? 10_000
          : terms.reduce((sum, term) => sum + (name.includes(term) ? 8 : text.includes(term) ? 1 : 0), 0);
        return { tool, score };
      }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score
        || a.tool.connectionId.localeCompare(b.tool.connectionId) || a.tool.toolName.localeCompare(b.tool.toolName));
      const result: McpGatewaySearchResult = { tools: [], unavailable };
      for (const { tool } of ranked.slice(0, args.limit ?? 3)) {
        const entry = { ...tool, invocation: { name: "call_mcp_tool" as const, codeModeName: "pwragent__call_mcp_tool" as const } };
        const identity = identities.get(tool.connectionId);
        const serverNameInAgent = this.options.serverNameInAgent?.(tool.connectionId, context);
        const servers = (identity || serverNameInAgent) && !result.servers?.some((entry) => entry.connectionId === tool.connectionId)
          ? [...(result.servers ?? []), serverEntry(tool.connectionId, tool.serverName, identity, serverNameInAgent, resourceTools)]
          : result.servers;
        const guidance = instructions.get(tool.connectionId);
        const serverInstructions = guidance && !result.serverInstructions?.some((entry) => entry.connectionId === tool.connectionId)
          ? [...(result.serverInstructions ?? []), { connectionId: tool.connectionId, ...guidance }]
          : result.serverInstructions;
        // Exact schemas are indivisible. Never return truncated valid-looking JSON.
        if (Buffer.byteLength(JSON.stringify({ ...result, tools: [...result.tools, entry], serverInstructions, servers })) > MAX_SEARCH_RESULT_BYTES) {
          result.unavailable.push({ connectionId: tool.connectionId, message: `The exact schema for ${tool.toolName} exceeds this result's size budget. Search its exact name alone or use native MCP invocation.` });
          continue;
        }
        result.tools.push(entry);
        if (servers) result.servers = servers;
        if (serverInstructions) result.serverInstructions = serverInstructions;
      }
      // A server whose skills match the query is named even when none of
      // its tools did: a skill is how a server says which task it is for.
      for (const [connectionId, published] of [...skills].sort(([left], [right]) => left.localeCompare(right))) {
        if (!current.has(connectionId) || result.servers?.some((entry) => entry.connectionId === connectionId)) continue;
        if (!resourceTools || !published.skills.some((skill) => scoreText(`${skill.name} ${skill.description ?? ""}`) > 0)) continue;
        const serverName = candidates.find((tool) => tool.connectionId === connectionId)?.serverName;
        const serverNameInAgent = serverName ? this.options.serverNameInAgent?.(connectionId, context) : undefined;
        if (!serverName || !serverNameInAgent) continue;
        const servers = [...(result.servers ?? []), serverEntry(connectionId, serverName, identities.get(connectionId), serverNameInAgent, resourceTools)];
        if (Buffer.byteLength(JSON.stringify({ ...result, servers })) > MAX_SEARCH_RESULT_BYTES) break;
        result.servers = servers;
      }
      // Skills go in last, in whatever room the exact schemas left, so they
      // never cost the result a tool. Those matching the query go first.
      for (const server of result.servers ?? []) {
        const published = skills.get(server.connectionId);
        if (!published || !server.resourceDiscovery) continue;
        const ranked = published.skills
          .map((skill, index) => ({ skill, index, score: scoreText(`${skill.name} ${skill.description ?? ""}`) }))
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
    if (Buffer.byteLength(JSON.stringify(args)) > 16_000) throw new Error("The MCP invocation exceeds the approval size limit. Use native MCP invocation for larger arguments.");
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
