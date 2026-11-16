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
    annotations: { readOnlyHint: false },
    description: descriptionForOperation(operation),
    inputSchema: inputSchemaForOperation(operation),
    deferLoading: false,
    dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
      if (!handler) {
        return agentToolFailure({
          code: "internal_error",
          message: PWRAGENT_APP_MANAGEMENT_UNAVAILABLE_MESSAGE,
        });
      }
      if (Object.keys(args).some((key) => key !== "action" && key !== "expectedStateToken")
        || (args.expectedStateToken !== undefined && (typeof args.expectedStateToken !== "string" || !args.expectedStateToken))) {
        return agentToolFailure({ code: "invalid_arguments", message: "App management accepts only action and an optional non-empty expectedStateToken. It always targets this local owner." });
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
        context: context.responseFlushed ? { responseFlushed: context.responseFlushed } : {},
        args: { action, ...(typeof args.expectedStateToken === "string" ? { expectedStateToken: args.expectedStateToken } : {}) },
      } as PwrAgentAppRequest);
      return appResponseToAgentToolResult(response);
    },
  }));
}

function descriptionForOperation(operation: PwrAgentAppOperationName): string {
  switch (operation) {
    case "manage_pwragent":
      return "Manage this local desktop owner only (no Federation routing). Status is read-only. upgrade_check may download/stage. Restart uses Quiet & Continue After Restart after acknowledgement and any quit confirmation. Stop uses ordinary quit. Restart/stop require an explicit user request. Scheduled means pending acknowledgement or confirmation. Accepted means handed to shutdown. It does not confirm installation completed.";
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
          expectedStateToken: {
            type: "string",
            minLength: 1,
            description: "Copy stateToken from status to bind upgrade_check, restart or stop to that owner process and update state. A mismatch refuses the action. Omit only to act on the currently serving owner.",
          },
          action: {
            type: "string",
            enum: PWRAGENT_APP_MANAGEMENT_ACTIONS,
            description:
              "`status` gets version, start time, uptime and update state. It also includes Codex app-server uptime, child-process count and last idle recycle. `upgrade_check` checks and may automatically download/stage. It never installs or restarts. `restart` installs a ready upgrade or relaunches the current version. It uses bounded Quiet & Continue After Restart. Quiet checkpoints and steers turns, terminates environment actions and may interrupt unfinished work after 15s. It does not wait indefinitely for idle. The operator can override with Quit Now. `stop` requests ordinary quit. Staged updates may apply under the platform quit policy. Read status for the asynchronous operation outcome. Headless owners do not support desktop lifecycle actions.",
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
