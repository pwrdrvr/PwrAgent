import type {
  PwrAgentAppManagementAction,
  PwrAgentAppOperationName,
  PwrAgentAppRequest,
  PwrAgentAppResponse,
} from "@pwragent/shared";
import {
  PWRAGENT_APP_MANAGEMENT_ACTIONS,
  PWRAGENT_APP_OPERATION_NAMES,
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

export const PWRAGENT_APP_MANAGEMENT_UNAVAILABLE_MESSAGE =
  "PwrAgent app management tools are not available.";

export type PwrAgentAppManagementHandler = (
  request: PwrAgentAppRequest,
) => PwrAgentAppResponse | Promise<PwrAgentAppResponse>;

export function buildPwrAgentAppToolRouter(
  handler: PwrAgentAppManagementHandler | undefined,
  options: { namespace?: string; unsupportedMessage?: string } = {},
): AgentToolRouter {
  return new AgentToolRouter(buildPwrAgentAppToolDefinitions(handler, {
    namespace: options.namespace,
  }), {
    unsupportedMessage:
      options.unsupportedMessage ?? "Unsupported PwrAgent app tool.",
  });
}

export function buildPwrAgentAppToolDefinitions(
  handler: PwrAgentAppManagementHandler | undefined,
  options: { namespace?: string } = {},
): AgentToolDefinition<PwrAgentAppOperationName>[] {
  return PWRAGENT_APP_OPERATION_NAMES.map((operation) => ({
    namespace: options.namespace ?? PWRAGENT_TOOL_NAMESPACE,
    name: operation,
    description: descriptionForOperation(operation),
    inputSchema: inputSchemaForOperation(operation),
    deferLoading: false,
    dispatch: async (args): Promise<AgentToolDispatchResult> => {
      if (!handler) {
        return agentToolFailure({
          code: "internal_error",
          message: PWRAGENT_APP_MANAGEMENT_UNAVAILABLE_MESSAGE,
        });
      }
      const action = normalizeAction(args.action);
      if (!action) {
        return agentToolFailure({
          code: "invalid_arguments",
          message:
            "manage_pwragent requires action to be one of: status, upgrade_check, restart, stop.",
        });
      }
      const response = await handler({
        operation,
        context: {},
        args: { action },
      } as PwrAgentAppRequest);
      return appResponseToAgentToolResult(response);
    },
  }));
}

function descriptionForOperation(operation: PwrAgentAppOperationName): string {
  switch (operation) {
    case "manage_pwragent":
      return "Read PwrAgent runtime/update status, check for upgrades, or request a PwrAgent restart/stop.";
  }
}

function inputSchemaForOperation(
  operation: PwrAgentAppOperationName,
): Record<string, unknown> {
  switch (operation) {
    case "manage_pwragent":
      return {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: PWRAGENT_APP_MANAGEMENT_ACTIONS,
            description:
              "`status` reports version, start time, uptime, and update state. `upgrade_check` checks for an available or downloaded update. `restart` restarts PwrAgent and installs a downloaded update when one is ready. `stop` quits PwrAgent.",
          },
        },
      };
  }
}

function normalizeAction(value: unknown): PwrAgentAppManagementAction | undefined {
  return typeof value === "string" &&
    PWRAGENT_APP_MANAGEMENT_ACTIONS.includes(
      value as PwrAgentAppManagementAction,
    )
    ? (value as PwrAgentAppManagementAction)
    : undefined;
}

function appResponseToAgentToolResult(
  response: PwrAgentAppResponse,
): AgentToolDispatchResult {
  if (response.ok) {
    return agentToolSuccess(response.data);
  }
  return agentToolFailure({
    code: response.error.code,
    message: response.error.message,
  });
}
