import type { AppServerBackendKind } from "@pwragent/shared";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type {
  AgentToolCallContext,
  AgentToolDefinition,
  AgentToolDispatchFailure,
  AgentToolDispatchResult,
} from "./agent-tool-definition.js";
import { agentToolFailure } from "./agent-tool-definition.js";

export type AgentDynamicToolCallRequest = {
  method: string;
  params: Record<string, unknown>;
};

export type AgentToolRouterOptions = {
  unsupportedMessage?: string;
};

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
    return this.definitions.map((definition) => ({
      namespace: definition.namespace,
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema as DynamicToolSpec["inputSchema"],
      deferLoading: definition.deferLoading ?? false,
    }));
  }

  acceptsDynamicToolCall(
    call: Pick<DynamicToolCallParams, "namespace" | "tool">,
  ): boolean {
    return Boolean(this.findDefinition(call.namespace, call.tool));
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
      turnId: params.call.turnId,
      transport: "codex_dynamic_tool",
    };
    return toDynamicToolResponse(
      await definition.dispatch(normalizeToolArguments(params.call.arguments), context),
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
    typeof call.namespace === "string" || call.namespace === null
      ? call.namespace
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
