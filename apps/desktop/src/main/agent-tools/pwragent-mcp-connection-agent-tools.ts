import type {
  PwrAgentMcpConnectionOperationName,
  PwrAgentMcpConnectionRequest,
  PwrAgentMcpConnectionResponse,
  PwrAgentMcpConnectionToolArgs,
} from "@pwragent/shared";
import {
  isPwrAgentMcpConnectionAction,
  PWRAGENT_MCP_CONNECTION_OPERATION_NAMES,
  PWRAGENT_TOOL_NAMESPACE,
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

export const PWRAGENT_MCP_CONNECTION_UNAVAILABLE_MESSAGE =
  "PwrAgent MCP connection tools are not available.";

export type PwrAgentMcpConnectionHandler = (
  request: PwrAgentMcpConnectionRequest,
) => PwrAgentMcpConnectionResponse | Promise<PwrAgentMcpConnectionResponse>;

export function buildPwrAgentMcpConnectionToolRouter(
  handler: PwrAgentMcpConnectionHandler | undefined,
  options: { namespace?: string; unsupportedMessage?: string } = {},
): AgentToolRouter {
  return new AgentToolRouter(
    buildPwrAgentMcpConnectionToolDefinitions(handler, {
      namespace: options.namespace,
    }),
    {
      unsupportedMessage:
        options.unsupportedMessage
        ?? "Unsupported PwrAgent MCP connection tool.",
    },
  );
}

export function buildPwrAgentMcpConnectionToolDefinitions(
  handler: PwrAgentMcpConnectionHandler | undefined,
  options: { namespace?: string } = {},
): AgentToolDefinition<PwrAgentMcpConnectionOperationName>[] {
  return PWRAGENT_MCP_CONNECTION_OPERATION_NAMES.map((operation) => ({
    namespace: options.namespace ?? PWRAGENT_TOOL_NAMESPACE,
    name: operation,
    description: TOOL_DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    deferLoading: false,
    dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
      if (!handler) {
        return agentToolFailure({
          code: "internal_error",
          message: PWRAGENT_MCP_CONNECTION_UNAVAILABLE_MESSAGE,
        });
      }
      const normalized = normalizeArgs(args);
      if (!normalized) {
        return agentToolFailure({
          code: "invalid_arguments",
          message:
            'Pass action "list", "create" (with displayName and serverUrl), or "describe_thread".',
        });
      }
      const response = await handler({
        operation,
        context: {
          backend: context.backend,
          ...(context.threadId ? { threadId: context.threadId } : {}),
        },
        args: normalized,
      });
      if (response.ok) return agentToolSuccess(response.data);
      return agentToolFailure({
        code: response.error.code,
        message: response.error.message,
      });
    },
  }));
}

// Reflected tool descriptions are held to short, semicolon-free sentences of
// at most 20 words. `pwragent-task-monitor-agent-tools.test.ts` walks every
// catalog and enforces it.
const TOOL_DESCRIPTION = [
  "Inspect and propose PwrAgent's own MCP connections.",
  "PwrAgent holds their OAuth credentials centrally and proxies them to threads.",
  "One connection therefore works for Codex and for ACP agents alike.",
  "Use list to see what this profile has configured.",
  "Use create to register a new remote MCP server.",
  "Use describe_thread to check what a thread actually received.",
  "Prefer this to editing an agent's own MCP config file.",
  "A server registered directly with Codex is invisible here and unavailable to other backends.",
  "create writes an inert record only.",
  "A person must authorize it in Settings before any thread can use it.",
  "There is deliberately no tool to authorize, enable, or remove a connection.",
].join(" ");

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["list", "create", "describe_thread"],
      description:
        "list returns every MCP connection in this profile with its readiness. create registers a new remote MCP server. describe_thread reports what a thread's selection became inside its agent.",
    },
    displayName: {
      type: "string",
      description: "create only. The operator-facing name, such as Datadog.",
    },
    serverUrl: {
      type: "string",
      description:
        "create only. The remote MCP endpoint URL. It must support OAuth. Command-line stdio servers cannot be registered here.",
    },
    threadId: {
      type: "string",
      description: "describe_thread only. Defaults to the calling thread.",
    },
  },
} as const;

function normalizeArgs(
  args: unknown,
): PwrAgentMcpConnectionToolArgs | undefined {
  const values = args && typeof args === "object"
    ? args as Record<string, unknown>
    : {};
  const action = values.action;
  if (!isPwrAgentMcpConnectionAction(action)) return undefined;
  if (action === "list") return { action };
  if (action === "create") {
    const displayName = typeof values.displayName === "string"
      ? values.displayName.trim()
      : "";
    const serverUrl = typeof values.serverUrl === "string"
      ? values.serverUrl.trim()
      : "";
    if (!displayName || !serverUrl) return undefined;
    return { action, displayName, serverUrl };
  }
  return {
    action,
    ...(typeof values.threadId === "string" && values.threadId.trim()
      ? { threadId: values.threadId.trim() }
      : {}),
  };
}
