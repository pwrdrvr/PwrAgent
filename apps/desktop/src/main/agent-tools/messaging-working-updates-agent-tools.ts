import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import { MESSAGING_TOOL_UPDATE_MODES, type MessagingToolUpdateMode } from "@pwragent/shared/contracts/messaging";
import { agentToolFailure, type AgentToolCallContext, type AgentToolDefinition, type AgentToolDispatchResult } from "./agent-tool-definition";

export type MessagingWorkingUpdatesHandler = (
  context: AgentToolCallContext,
  mode?: MessagingToolUpdateMode,
) => Promise<AgentToolDispatchResult>;

export function buildMessagingWorkingUpdatesToolDefinitions(
  handler: MessagingWorkingUpdatesHandler | undefined,
): AgentToolDefinition[] {
  if (!handler) return [];
  const scope = "Applies to Development-thread bindings that inherit this local profile's default. Existing explicit binding selections, project launch settings, default Agent routes, and the separate Agent-thread default keep their own behavior. None suppresses interim Working Updates while final replies and questions still go through. Requires a verified local messaging requester with tools.messaging_profile_settings.";
  return [
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "get_messaging_working_updates_default",
      description: `Read the profile's default Working Updates mode for bound Development threads, with its source. ${scope}`,
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      dispatch: (args, context) => {
        if (Object.keys(args).length) {
          return agentToolFailure({ code: "invalid_arguments", message: "This read takes no arguments." });
        }
        return handler(context);
      },
    },
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "set_messaging_working_updates_default",
      description: `Save the profile's default Working Updates mode for bound Development threads. Returns the effective value, its source, and whether it changed. ${scope}`,
      annotations: { readOnlyHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: {
          mode: {
            type: "string",
            enum: MESSAGING_TOOL_UPDATE_MODES,
            description: "Working Updates level. Choose show_none for None.",
          },
        },
      },
      dispatch: (args, context) => {
        const mode = MESSAGING_TOOL_UPDATE_MODES.find((value) => value === args.mode);
        if (!mode || Object.keys(args).length !== 1) {
          return agentToolFailure({ code: "invalid_arguments", message: "Supply only mode: show_none, show_less, show_some, show_more, or show_all." });
        }
        return handler(context, mode);
      },
    },
  ];
}
