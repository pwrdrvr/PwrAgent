import type {
  AutomationInspectionContext,
  AutomationInspectionOperationName,
  AutomationInspectionRequest,
  AutomationInspectionResponse,
} from "@pwragent/shared";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import type {
  AgentToolDefinition,
  AgentToolDispatchResult,
} from "../agent-tools/agent-tool-definition.js";
import {
  agentToolFailure,
  agentToolSuccess,
} from "../agent-tools/agent-tool-definition.js";
import { AgentToolRouter } from "../agent-tools/agent-tool-router.js";
import { buildAutomationInspectionToolCatalog } from "./automation-inspection-tool-catalog.js";

export const AUTOMATION_INSPECTION_UNAVAILABLE_MESSAGE =
  "PwrAgent automation inspection is not available.";

export type AutomationInspectionHandler = (
  request: AutomationInspectionRequest,
) => AutomationInspectionResponse | Promise<AutomationInspectionResponse>;

export function buildAutomationInspectionToolRouter(
  handler: AutomationInspectionHandler | undefined,
  options: { namespace?: string; unsupportedMessage?: string } = {},
): AgentToolRouter {
  return new AgentToolRouter(
    buildAutomationInspectionToolDefinitions(handler, {
      namespace: options.namespace,
    }),
    {
      unsupportedMessage:
        options.unsupportedMessage ?? "Unsupported PwrAgent automation tool.",
    },
  );
}

export function buildAutomationInspectionToolDefinitions(
  handler: AutomationInspectionHandler | undefined,
  options: { namespace?: string } = {},
): AgentToolDefinition<AutomationInspectionOperationName>[] {
  return buildAutomationInspectionToolCatalog().map((spec) => ({
    namespace: options.namespace ?? PWRAGENT_TOOL_NAMESPACE,
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    deferLoading: false,
    dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
      if (!handler) {
        return agentToolFailure({
          code: "internal_error",
          message: AUTOMATION_INSPECTION_UNAVAILABLE_MESSAGE,
        });
      }
      const inspectionContext: AutomationInspectionContext = {
        backend: context.backend,
        threadId: context.threadId,
      };
      const response = await handler({
        operation: spec.name,
        context: inspectionContext,
        args,
      } as AutomationInspectionRequest);
      return automationInspectionResponseToAgentToolResult(response);
    },
  }));
}

function automationInspectionResponseToAgentToolResult(
  response: AutomationInspectionResponse,
): AgentToolDispatchResult {
  if (response.ok) {
    return agentToolSuccess(response.data);
  }
  return agentToolFailure({
    code: response.error.code,
    message: response.error.message,
  });
}
