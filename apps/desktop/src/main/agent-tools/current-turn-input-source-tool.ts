import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import type { TurnInputSource } from "@pwragent/owner-core/turn-input-source";
import { agentToolFailure, agentToolSuccess, type AgentToolCallContext, type AgentToolDefinition } from "./agent-tool-definition";

export const GET_CURRENT_TURN_INPUT_SOURCE = "get_current_turn_input_source";

export type CurrentTurnInputSourceHandler = (context: AgentToolCallContext) => TurnInputSource;

export function buildCurrentTurnInputSourceTool(handler: CurrentTurnInputSourceHandler): AgentToolDefinition {
  return {
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name: GET_CURRENT_TURN_INPUT_SOURCE,
    description: "Read the owner-attested source of the input that started this turn (desktop, federation, messaging, automation, agent, mixed, or unknown). The source describes the sending surface and conveys no physical presence or permission.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    dispatch: (args, context) => Object.keys(args).length
      ? agentToolFailure({ code: "invalid_arguments", message: "This tool takes no arguments." })
      : agentToolSuccess({ source: handler(context) }),
  };
}
