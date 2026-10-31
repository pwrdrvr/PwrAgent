import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import type { McpConnectionGatewayService } from "./mcp-connection-gateway-service";
import { gatewayCatalogRevision, validateGatewayArguments, type McpGatewayInvocation, type McpGatewayTool, type McpGatewaySource } from "./mcp-gateway-catalog";
import { MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS, MCP_CONNECTION_TOOL_TIMEOUT_MS, MCP_DISCOVERY_RESPONSE_GRACE_MS } from "./mcp-connection-timeouts";

export type McpGatewayCallArgs = Omit<McpGatewayInvocation, "serverName">;
export type McpGatewaySearch = { query: string; connectionId?: string; limit?: number };
export type McpGatewayApproval = boolean | {
  /** Record conversation consent only after the owner's validation and call succeed. */
  onInvoked: () => Promise<void>;
};
export type McpGatewaySearchResult = {
  tools: Array<Omit<McpGatewayTool, "serverInstructions"> & { invocation: { name: "call_mcp_tool"; codeModeName: "pwragent__call_mcp_tool" } }>;
  unavailable: Array<{ connectionId: string; message: string }>;
  /** Each returned tool's server guidance, once per server. */
  serverInstructions?: Array<{ connectionId: string; serverName: string; instructions: string }>;
};

export type McpGatewayToolServiceOptions = {
  connections: Pick<McpConnectionGatewayService, "requestGatewayToolOperation">;
  /** Must check active turn, actor permissions and the latest saved selection. */
  selectedConnections: (context: AgentToolCallContext) => Promise<string[]>;
  /** A host policy can narrow discovery and invocation independently of approval. */
  toolAllowed?: (tool: McpGatewayTool, context: AgentToolCallContext) => boolean;
  /** `annotations` are the listed tool's own hints, under its exact schema revision. */
  approve: (invocation: McpGatewayInvocation, context: AgentToolCallContext, signal: AbortSignal, annotations: Tool["annotations"], catalogRevision: string) => Promise<McpGatewayApproval>;
};

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
      const instructions = new Map<string, { serverName: string; instructions: string }>();
      let candidateBytes = 0;
      const unavailable: McpGatewaySearchResult["unavailable"] = [];
      // Bounded fan-out; one slow server must not consume every socket.
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (next < ids.length) {
          const connectionId = ids[next++];
          try {
            await this.requireSelected(connectionId, context, signal);
            const tools = await this.options.connections.requestGatewayToolOperation({
              connectionId, scopeKey: this.scopeKey(context), operation: "gateway/tools/list", signal, deadlineAt,
            }) as McpGatewayTool[];
            await this.requireSelected(connectionId, context, signal);
            const bytes = Buffer.byteLength(JSON.stringify(tools));
            if (candidateBytes + bytes > 8 * 1024 * 1024) throw new Error("Search a specific connectionId to stay within the catalog memory budget.");
            candidateBytes += bytes;
            for (const { serverInstructions, ...tool } of tools) {
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
        const guidance = instructions.get(tool.connectionId);
        const serverInstructions = guidance && !result.serverInstructions?.some((entry) => entry.connectionId === tool.connectionId)
          ? [...(result.serverInstructions ?? []), { connectionId: tool.connectionId, ...guidance }]
          : result.serverInstructions;
        // Exact schemas are indivisible. Never return truncated valid-looking JSON.
        if (Buffer.byteLength(JSON.stringify({ ...result, tools: [...result.tools, entry], serverInstructions })) > 24_000) {
          result.unavailable.push({ connectionId: tool.connectionId, message: `The exact schema for ${tool.toolName} exceeds this result's size budget. Search its exact name alone or use native MCP invocation.` });
          continue;
        }
        result.tools.push(entry);
        if (serverInstructions) result.serverInstructions = serverInstructions;
      }
      return result;
    });
  }

  async call(args: McpGatewayCallArgs, context: AgentToolCallContext): Promise<{ source: McpGatewaySource; result: CallToolResult }> {
    if (Buffer.byteLength(JSON.stringify(args)) > 16_000) throw new Error("The MCP invocation exceeds the approval size limit. Use native MCP invocation for larger arguments.");
    return await this.run(context, MCP_CONNECTION_TOOL_TIMEOUT_MS, async (signal) => {
      await this.requireSelected(args.connectionId, context, signal);
      const tools = await this.options.connections.requestGatewayToolOperation({
        connectionId: args.connectionId, scopeKey: this.scopeKey(context), operation: "gateway/tools/list", signal,
      }) as McpGatewayTool[];
      const tool = tools.find((entry) => entry.toolName === args.toolName);
      if (!tool || tool.schemaRevision !== args.schemaRevision) throw new Error("The tool schema or authorization changed. Search again.");
      if (this.options.toolAllowed?.(tool, context) === false) throw new Error("This MCP tool is not permitted for the calling thread.");
      validateGatewayArguments(tool.definition, args.arguments);
      await this.requireSelected(args.connectionId, context, signal);
      const source: McpGatewaySource = {
        connectionId: tool.connectionId, serverName: tool.serverName,
        toolName: tool.toolName, schemaRevision: tool.schemaRevision,
      };
      const invocation = { ...source, arguments: args.arguments };
      const approval = await this.options.approve(invocation, context, signal, tool.definition.annotations, gatewayCatalogRevision(tools));
      if (!approval) throw new Error("The MCP tool invocation was not approved.");
      await this.requireSelected(args.connectionId, context, signal);
      if (this.options.toolAllowed?.(tool, context) === false) throw new Error("This MCP tool is no longer permitted for the calling thread.");
      // The owner lists and validates again, preventing schema/auth changes while
      // approval was pending from executing a different operation under that grant.
      const result = await this.options.connections.requestGatewayToolOperation({
        connectionId: args.connectionId, scopeKey: this.scopeKey(context),
        operation: "gateway/tools/call", invocation, signal,
      }) as CallToolResult;
      if (typeof approval === "object") await approval.onInvoked();
      return { source, result };
    });
  }

  private scopeKey(context: AgentToolCallContext): string {
    return JSON.stringify(["gateway", context.backend, context.threadId]);
  }

  private async requireSelected(id: string, context: AgentToolCallContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!(await this.options.selectedConnections(context)).includes(id)) throw new Error("This connection is no longer selected for the calling thread.");
    signal.throwIfAborted();
  }

  private async run<T>(context: AgentToolCallContext, timeout: number, operation: (signal: AbortSignal, deadlineAt: number) => Promise<T>): Promise<T> {
    const deadlineAt = Date.now() + timeout;
    const entry = { context, controller: new AbortController() };
    const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(timeout + (timeout === MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS ? MCP_DISCOVERY_RESPONSE_GRACE_MS : 0)), ...(context.signal ? [context.signal] : [])]);
    this.running.add(entry);
    try {
      signal.throwIfAborted();
      return await operation(signal, deadlineAt);
    } finally {
      this.running.delete(entry);
    }
  }
}
