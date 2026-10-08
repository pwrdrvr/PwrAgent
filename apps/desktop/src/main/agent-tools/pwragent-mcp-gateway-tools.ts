import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import { agentToolFailure, type AgentToolCallContentItems, type AgentToolDefinition } from "./agent-tool-definition";

export function buildMcpGatewayToolDefinitions(service?: McpGatewayToolService, store?: TokenMiserStore): AgentToolDefinition[] {
  return [{
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name: "search_mcp_tools",
    description: "Search live tools on this thread's selected PwrAgent MCP connections. New connections and tools are discoverable during an existing turn. Results contain exact schemas and source identities. Invoke results through call_mcp_tool, even when their upstream names are not registered native tools. Search does not grant authorization or execute a tool. Emit the returned string unchanged in Code Mode so schemas survive Token Miser.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        connectionId: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 5 },
      },
    },
    dispatch: async (args, context) => {
      if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500
        || (args.connectionId !== undefined && (typeof args.connectionId !== "string" || !args.connectionId))
        || (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 5))
        || Object.keys(args).some((key) => !["query", "connectionId", "limit"].includes(key))) {
        return agentToolFailure({ code: "invalid_arguments", message: "Provide query, optional connectionId and a limit from 1 to 5." });
      }
      if (!service) return agentToolFailure({ code: "unavailable", message: "MCP gateway discovery is unavailable." });
      try {
        const result = await service.search({ query: args.query.trim(), connectionId: args.connectionId as string | undefined, limit: args.limit as number | undefined }, context);
        const visibleText = JSON.stringify(result);
        const protect = store && context.backend === "codex" && context.turnId;
        const delivery = protect
          ? await store.prepareToolDefinitionDelivery({ threadId: context.threadId, turnId: protect, visibleText })
          : undefined;
        if (protect && !delivery) return agentToolFailure({ code: "schema_delivery_unavailable", message: "Exact schema delivery is unavailable for this turn. Retry discovery." });
        return { ok: true, data: result, contentItems: [{ type: "inputText", text: delivery?.text ?? visibleText }] };
      } catch (error) {
        return gatewayFailure(error);
      }
    },
  }, {
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name: "call_mcp_tool",
    description: "Invoke a discovered tool on this thread's selected PwrAgent MCP connections. Use the exact connectionId, toolName, schemaRevision and arguments from search_mcp_tools. The gateway rechecks selection, authorization and schema. Full Access approves the invocation automatically. Automations pre-approve their allowed MCP servers and tools. Other Default and Auto calls ask for approval unless the server marks the tool read-only. Approval covers one tool, once or for this conversation. Conversation approval expires when PwrAgent restarts, MCP access changes, or the tool changes. A schema change requires another search. Never retry a failed side effect without knowing whether it completed. Native tools remain available independently.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["connectionId", "toolName", "schemaRevision", "arguments"],
      properties: {
        connectionId: { type: "string", minLength: 1 },
        toolName: { type: "string", minLength: 1 },
        schemaRevision: { type: "string", minLength: 1 },
        arguments: { type: "object", additionalProperties: true },
      },
    },
    dispatch: async (args, context) => {
      if (!["connectionId", "toolName", "schemaRevision"].every((key) => typeof args[key] === "string" && args[key])
        || !args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)
        || Object.keys(args).some((key) => !["connectionId", "toolName", "schemaRevision", "arguments"].includes(key))) {
        return agentToolFailure({ code: "invalid_arguments", message: "Provide the discovered connectionId, toolName, schemaRevision and an arguments object." });
      }
      if (!service) return agentToolFailure({ code: "unavailable", message: "MCP gateway invocation is unavailable." });
      try {
        const response = await service.call({
          connectionId: args.connectionId as string, toolName: args.toolName as string,
          schemaRevision: args.schemaRevision as string, arguments: args.arguments as Record<string, unknown>,
        }, context);
        const contentItems: AgentToolCallContentItems = [{
          type: "inputText",
          text: JSON.stringify({ ...response, result: { ...response.result, content: response.result.content.map((item) =>
            item.type === "image" || item.type === "audio" ? { ...item, data: undefined } : item) } }),
        }];
        for (const item of response.result.content) {
          if (item.type === "image") contentItems.push({ type: "inputImage", imageUrl: `data:${item.mimeType};base64,${item.data}` });
          if (item.type === "audio") contentItems.push({ type: "inputAudio", audioUrl: `data:${item.mimeType};base64,${item.data}` });
        }
        const mcpResult = { ...response.result, _meta: { ...response.result._meta, "pwragent/source": response.source } };
        return response.result.isError
          ? { ok: false, code: "upstream_tool_error", message: "The source MCP tool returned an error.", data: response, contentItems, mcpResult }
          : { ok: true, data: response, contentItems, mcpResult };
      } catch (error) {
        return gatewayFailure(error);
      }
    },
  }];
}

function gatewayFailure(error: unknown) {
  return agentToolFailure({
    code: error instanceof Error && error.name === "AbortError" ? "mcp_gateway_cancelled" : "mcp_gateway_error",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof McpError ? { data: { code: error.code, data: error.data } } : {}),
  });
}
