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
  isPwrAgentUpdateVersion,
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
  options: { namespace?: string; advertise?: boolean } = {},
): AgentToolDefinition<PwrAgentAppOperationName>[] {
  return PWRAGENT_APP_OPERATION_NAMES.map((operation) => ({
    namespace: options.namespace ?? PWRAGENT_TOOL_NAMESPACE,
    name: operation,
    advertise: options.advertise,
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
      if (Object.keys(args).some((key) => !["action", "expectedStateToken", "expectedVersion", "operationId"].includes(key))
        || (args.expectedStateToken !== undefined && (typeof args.expectedStateToken !== "string" || !args.expectedStateToken))
        || (args.expectedVersion !== undefined && !isPwrAgentUpdateVersion(args.expectedVersion))
        || (args.operationId !== undefined && (typeof args.operationId !== "string" || !args.operationId || args.operationId.length > 128))) {
        return agentToolFailure({ code: "invalid_arguments", message: "App management accepts only action, expectedStateToken, expectedVersion and operationId. It always targets this local owner." });
      }
      const action = normalizeAction(args.action);
      if (!action) {
        return agentToolFailure({
          code: "invalid_arguments",
          message:
            "manage_pwragent requires action to be one of: status, upgrade_check, download, cancel, restart, stop.",
        });
      }
      const response = await handler({
        operation,
        context: { backend: context.backend, threadId: context.threadId, turnId: context.turnId,
          ...(context.responseFlushed ? { responseFlushed: context.responseFlushed } : {}) },
        args: { action,
          ...(typeof args.expectedStateToken === "string" ? { expectedStateToken: args.expectedStateToken } : {}),
          ...(typeof args.expectedVersion === "string" ? { expectedVersion: args.expectedVersion } : {}),
          ...(typeof args.operationId === "string" ? { operationId: args.operationId } : {}),
        },
      } as PwrAgentAppRequest);
      return appResponseToAgentToolResult(response);
    },
  }));
}

function descriptionForOperation(operation: PwrAgentAppOperationName): string {
  switch (operation) {
    case "manage_pwragent":
      return "Manage this local desktop owner from a designated Agent with explicit lifecycle authority. No Federation target forwarding. Status is read-only. upgrade_check may download/stage. download starts or reuses an exact checked version. Restart uses Quiet & Continue After Restart after acknowledgement. Authorized chat operations require no desktop confirmation. Restart/stop require an explicit user request. Scheduled means pending acknowledgement. Accepted means handed to shutdown. Verify the running version after relaunch.";
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
          expectedVersion: {
            type: "string", maxLength: 128,
            description: "Exact version, such as 1.4.8. Required for download or download cancellation. Use with restart to refuse any other version.",
          },
          operationId: {
            type: "string", minLength: 1, maxLength: 128,
            description: "For cancel, copy the scheduled lifecycle operation id from status. Cancellation is refused after shutdown preparation starts.",
          },
          expectedStateToken: {
            type: "string",
            minLength: 1,
            description: "Copy stateToken from status to bind upgrade_check, restart or stop to that owner process and update state. A mismatch refuses the action. Omit only to act on the currently serving owner.",
          },
          action: {
            type: "string",
            enum: PWRAGENT_APP_MANAGEMENT_ACTIONS,
            description:
              "`status` reads runtime and update progress without a network request. `upgrade_check` checks the selected track and may download automatically. `download` starts or reuses the checked expectedVersion. Read status until that exact version is downloaded and staged. `restart` installs that ready version or relaunches the current version. It uses bounded Quiet & Continue After Restart after acknowledgement. Quiet checkpoints work and may interrupt unfinished turns after 15s. `cancel` uses operationId before shutdown preparation, or expectedVersion to request download cancellation. `stop` requests ordinary quit. Staged updates may apply under the platform quit policy. Scheduled and handed_off describe progress, not proof of installation. Post-restart continuations verify the target version. Headless owners do not support desktop lifecycle actions.",
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
