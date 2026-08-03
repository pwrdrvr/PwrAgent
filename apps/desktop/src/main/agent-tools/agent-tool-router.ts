import {
  PWRAGENT_TOOL_NAMESPACE,
  type AppServerBackendKind,
} from "@pwragent/shared";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolNamespaceTool,
  DynamicToolSpec,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type {
  AgentToolCallContext,
  AgentToolCallContentItems,
  AgentToolDefinition,
  AgentToolDispatchFailure,
  AgentToolDispatchResult,
  AgentToolMcpContentItem,
} from "./agent-tool-definition.js";
import { agentToolFailure } from "./agent-tool-definition.js";

export type AgentDynamicToolCallRequest = {
  method: string;
  params: Record<string, unknown>;
};

export type AgentToolRouterOptions = {
  unsupportedMessage?: string;
};

export type AgentMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AgentMcpToolCallResponse = {
  content: AgentToolMcpContentItem[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export const PWRAGENT_AGENT_TOOL_NAMESPACE_DESCRIPTION =
  "PwrAgent-native tools for managing threads, delegated work, messaging, apps, and automations. Prefer PwrAgent thread and sub-agent management tools over backend-native equivalents when they can satisfy the request. Use backend-native spawning only when the user explicitly asks for it or requires a capability PwrAgent does not support.";

export class AgentToolRouter {
  private readonly definitions: AgentToolDefinition[];
  private readonly unsupportedMessage: string;

  constructor(
    definitions: AgentToolDefinition[],
    options: AgentToolRouterOptions = {},
  ) {
    this.definitions = [...definitions];
    this.unsupportedMessage =
      options.unsupportedMessage ?? "Unsupported PwrAgent agent tool.";
  }

  buildDynamicToolSpecs(): DynamicToolSpec[] {
    const toolsByNamespace = new Map<string, DynamicToolNamespaceTool[]>();
    for (const definition of this.definitions) {
      if (definition.advertise === false) {
        continue;
      }
      const tools = toolsByNamespace.get(definition.namespace) ?? [];
      tools.push({
        type: "function",
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema as DynamicToolNamespaceTool["inputSchema"],
        deferLoading: definition.deferLoading ?? false,
      });
      toolsByNamespace.set(definition.namespace, tools);
    }

    return Array.from(toolsByNamespace, ([name, tools]) => ({
      type: "namespace" as const,
      name,
      description: PWRAGENT_AGENT_TOOL_NAMESPACE_DESCRIPTION,
      tools,
    }));
  }

  buildMcpTools(): AgentMcpTool[] {
    return this.definitions
      .filter(
        (definition) =>
          definition.advertise !== false && definition.advertiseMcp !== false,
      )
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      }));
  }

  acceptsDynamicToolCall(
    call: Pick<DynamicToolCallParams, "namespace" | "tool">,
  ): boolean {
    return Boolean(this.findDefinition(call.namespace, call.tool));
  }

  acceptsMcpToolCall(params: {
    namespace?: string;
    tool: string;
  }): boolean {
    return Boolean(this.findMcpDefinition(params.namespace, params.tool));
  }

  async handleDynamicToolCall(params: {
    backend: AppServerBackendKind;
    call: DynamicToolCallParams;
  }): Promise<DynamicToolCallResponse> {
    const definition = this.findDefinition(params.call.namespace, params.call.tool);
    if (!definition) {
      return toDynamicToolResponse(
        agentToolFailure({
          code: "unsupported_operation",
          message: this.unsupportedMessage,
        }),
      );
    }

    const context: AgentToolCallContext = {
      backend: params.backend,
      threadId: params.call.threadId,
      callId: params.call.callId,
      turnId: params.call.turnId,
      transport: "codex_dynamic_tool",
    };
    return toDynamicToolResponse(
      await definition.dispatch(normalizeToolArguments(params.call.arguments), context),
    );
  }

  async handleMcpToolCall(params: {
    backend: AppServerBackendKind;
    threadId: string;
    namespace?: string;
    tool: string;
    args?: unknown;
    callId?: string;
    turnId?: string;
  }): Promise<AgentMcpToolCallResponse> {
    const definition = this.findMcpDefinition(params.namespace, params.tool);
    if (!definition) {
      return toMcpToolResponse(
        agentToolFailure({
          code: "unsupported_operation",
          message: this.unsupportedMessage,
        }),
      );
    }

    const context: AgentToolCallContext = {
      backend: params.backend,
      threadId: params.threadId,
      callId: params.callId,
      turnId: params.turnId,
      transport: "mcp",
    };
    return toMcpToolResponse(
      await definition.dispatch(normalizeToolArguments(params.args), context),
    );
  }

  private findDefinition(
    namespace: DynamicToolCallParams["namespace"],
    tool: string,
  ): AgentToolDefinition | undefined {
    return this.definitions.find(
      (definition) =>
        definition.namespace === namespace && definition.name === tool,
    );
  }

  private findMcpDefinition(
    namespace: string | undefined,
    tool: string,
  ): AgentToolDefinition | undefined {
    const definitions = this.definitions.filter(
      (definition) => definition.advertiseMcp !== false,
    );
    if (namespace) {
      return definitions.find(
        (definition) => definition.namespace === namespace && definition.name === tool,
      );
    }
    const matching = definitions.filter((definition) => definition.name === tool);
    return matching.length === 1 ? matching[0] : undefined;
  }
}

export function readAgentDynamicToolCall(
  request: AgentDynamicToolCallRequest,
): DynamicToolCallParams | undefined {
  if (request.method !== "item/tool/call") {
    return undefined;
  }
  const call = request.params;
  const threadId = readString(call.threadId);
  const turnId = readString(call.turnId) ?? "";
  const callId = readString(call.callId) ?? readString(call.requestId);
  const tool = readString(call.tool);
  const namespace =
    typeof call.namespace === "string"
      ? call.namespace
      : call.namespace === null
        ? PWRAGENT_TOOL_NAMESPACE
        : undefined;
  if (!threadId || !callId || !tool || namespace === undefined) {
    return undefined;
  }
  return {
    threadId,
    turnId,
    callId,
    namespace,
    tool,
    arguments: (call.arguments ?? null) as DynamicToolCallParams["arguments"],
  };
}

export function toDynamicToolResponse(
  result: AgentToolDispatchResult,
): DynamicToolCallResponse {
  const payload = result.ok
    ? result.data
    : toFailurePayload(result);
  return {
    success: result.ok,
    contentItems:
      result.contentItems ??
      [
        {
          type: "inputText",
          text: JSON.stringify(payload, null, 2),
        },
      ],
  };
}

export function toMcpToolResponse(
  result: AgentToolDispatchResult,
): AgentMcpToolCallResponse {
  const payload = result.ok ? result.data : toFailurePayload(result);
  return {
    isError: result.ok ? undefined : true,
    structuredContent: toStructuredContent(payload),
    content: result.mcpContentItems ?? (result.contentItems
      ? toMcpContentItems(result.contentItems)
      : [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ]),
  };
}

function toMcpContentItems(
  contentItems: AgentToolCallContentItems,
): AgentMcpToolCallResponse["content"] {
  return contentItems.map((item) => {
    if (item.type === "inputText") {
      return { type: "text", text: item.text };
    }
    const dataUrlMatch = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u.exec(
      item.imageUrl,
    );
    return dataUrlMatch
      ? {
          type: "image",
          data: dataUrlMatch[2]!,
          mimeType: dataUrlMatch[1]!,
        }
      : {
          type: "text",
          text: "PwrAgent returned an image with an unsupported data URL.",
        };
  });
}

function toStructuredContent(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : { result: payload };
}

function toFailurePayload(result: AgentToolDispatchFailure): Record<string, unknown> {
  return result.data === undefined
    ? {
        code: result.code,
        message: result.message,
      }
    : {
        code: result.code,
        message: result.message,
        data: result.data,
      };
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
