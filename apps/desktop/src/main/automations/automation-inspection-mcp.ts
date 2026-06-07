import type {
  AppServerBackendKind,
  AutomationInspectionOperationName,
} from "@pwragent/shared";
import {
  AUTOMATION_INSPECTION_OPERATION_NAMES,
  AUTOMATION_INSPECTION_TOOL_NAMESPACE,
} from "@pwragent/shared";
import type {
  AgentMcpTool,
  AgentMcpToolCallResponse,
} from "../agent-tools/agent-tool-router.js";
import {
  buildAutomationInspectionToolRouter,
  type AutomationInspectionHandler,
} from "./automation-inspection-agent-tools.js";

export type AutomationInspectionMcpTool = AgentMcpTool & {
  name: AutomationInspectionOperationName;
};
export type AutomationInspectionMcpCallResponse = AgentMcpToolCallResponse;

export function buildAutomationInspectionMcpTools(): AutomationInspectionMcpTool[] {
  return buildAutomationInspectionToolRouter(undefined).buildMcpTools() as
    AutomationInspectionMcpTool[];
}

export function isAutomationInspectionMcpToolName(
  value: unknown,
): value is AutomationInspectionOperationName {
  return (
    typeof value === "string" &&
    AUTOMATION_INSPECTION_OPERATION_NAMES.includes(
      value as AutomationInspectionOperationName,
    )
  );
}

export async function handleAutomationInspectionMcpToolCall(params: {
  backend: AppServerBackendKind;
  threadId: string;
  tool: string;
  args?: unknown;
  handler: AutomationInspectionHandler | undefined;
}): Promise<AutomationInspectionMcpCallResponse> {
  return await buildAutomationInspectionToolRouter(params.handler, {
    unsupportedMessage: `Unsupported ${AUTOMATION_INSPECTION_TOOL_NAMESPACE} tool.`,
  }).handleMcpToolCall({
    backend: params.backend,
    threadId: params.threadId,
    namespace: AUTOMATION_INSPECTION_TOOL_NAMESPACE,
    tool: params.tool,
    args: params.args,
  });
}
