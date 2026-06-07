import type {
  PwrAgentThreadInspectionOperationName,
  PwrAgentThreadInspectionRequest,
  PwrAgentThreadInspectionResponse,
} from "@pwragent/shared";
import {
  PWRAGENT_THREAD_INSPECTION_OPERATION_NAMES,
  PWRAGENT_THREAD_TOOL_NAMESPACE,
} from "@pwragent/shared";
import type {
  AgentToolDefinition,
  AgentToolDispatchResult,
} from "./agent-tool-definition.js";
import {
  agentToolFailure,
  agentToolSuccess,
} from "./agent-tool-definition.js";
import { AgentToolRouter } from "./agent-tool-router.js";

export const PWRAGENT_THREAD_INSPECTION_UNAVAILABLE_MESSAGE =
  "PwrAgent thread inspection is not available.";

export type PwrAgentThreadInspectionHandler = (
  request: PwrAgentThreadInspectionRequest,
) => PwrAgentThreadInspectionResponse | Promise<PwrAgentThreadInspectionResponse>;

export function buildPwrAgentThreadToolRouter(
  handler: PwrAgentThreadInspectionHandler | undefined,
  options: { unsupportedMessage?: string } = {},
): AgentToolRouter {
  return new AgentToolRouter(buildPwrAgentThreadToolDefinitions(handler), {
    unsupportedMessage:
      options.unsupportedMessage ?? "Unsupported PwrAgent thread tool.",
  });
}

export function buildPwrAgentThreadToolDefinitions(
  handler: PwrAgentThreadInspectionHandler | undefined,
): AgentToolDefinition<PwrAgentThreadInspectionOperationName>[] {
  return PWRAGENT_THREAD_INSPECTION_OPERATION_NAMES.map((operation) => ({
    namespace: PWRAGENT_THREAD_TOOL_NAMESPACE,
    name: operation,
    description: descriptionForOperation(operation),
    inputSchema: inputSchemaForOperation(operation),
    deferLoading: false,
    dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
      if (!handler) {
        return agentToolFailure({
          code: "internal_error",
          message: PWRAGENT_THREAD_INSPECTION_UNAVAILABLE_MESSAGE,
        });
      }
      const response = await handler({
        operation,
        context: {
          backend: context.backend,
          threadId: context.threadId,
        },
        args,
      } as PwrAgentThreadInspectionRequest);
      return threadInspectionResponseToAgentToolResult(response);
    },
  }));
}

function descriptionForOperation(
  operation: PwrAgentThreadInspectionOperationName,
): string {
  switch (operation) {
    case "search_threads":
      return "Search known PwrAgent threads by title, summary, Agent metadata, backend, and linked directory.";
    case "get_thread_status":
      return "Read status and compact metadata for a known PwrAgent thread.";
  }
}

function inputSchemaForOperation(
  operation: PwrAgentThreadInspectionOperationName,
): Record<string, unknown> {
  switch (operation) {
    case "search_threads":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          backend: {
            type: "string",
          },
          includeArchived: { type: "boolean" },
          agentOnly: { type: "boolean" },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
          },
        },
      };
    case "get_thread_status":
      return {
        type: "object",
        additionalProperties: false,
        required: ["backend", "threadId"],
        properties: {
          backend: {
            type: "string",
          },
          threadId: { type: "string" },
        },
      };
  }
}

function threadInspectionResponseToAgentToolResult(
  response: PwrAgentThreadInspectionResponse,
): AgentToolDispatchResult {
  if (response.ok) {
    return agentToolSuccess(response.data);
  }
  return agentToolFailure({
    code: response.error.code,
    message: response.error.message,
  });
}
