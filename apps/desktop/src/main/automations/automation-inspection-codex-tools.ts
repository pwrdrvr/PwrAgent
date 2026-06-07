import type {
  AppServerBackendKind,
  AutomationInspectionOperationName,
} from "@pwragent/shared";
import {
  AUTOMATION_INSPECTION_OPERATION_NAMES,
  AUTOMATION_INSPECTION_TOOL_NAMESPACE,
} from "@pwragent/shared";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import {
  readAgentDynamicToolCall,
  toDynamicToolResponse,
} from "../agent-tools/agent-tool-router.js";
import {
  buildAutomationInspectionToolRouter,
  type AutomationInspectionHandler,
} from "./automation-inspection-agent-tools.js";

export type { AutomationInspectionHandler } from "./automation-inspection-agent-tools.js";

export function buildAutomationInspectionDynamicToolSpecs(): DynamicToolSpec[] {
  return buildAutomationInspectionToolRouter(undefined).buildDynamicToolSpecs();
}

export function isAutomationInspectionDynamicToolCall(
  call: Pick<DynamicToolCallParams, "namespace" | "tool">,
): call is DynamicToolCallParams & {
  namespace: typeof AUTOMATION_INSPECTION_TOOL_NAMESPACE;
  tool: AutomationInspectionOperationName;
} {
  return (
    call.namespace === AUTOMATION_INSPECTION_TOOL_NAMESPACE &&
    AUTOMATION_INSPECTION_OPERATION_NAMES.includes(
      call.tool as AutomationInspectionOperationName,
    )
  );
}

export async function handleAutomationInspectionDynamicToolCall(params: {
  backend: AppServerBackendKind;
  call: DynamicToolCallParams;
  handler: AutomationInspectionHandler | undefined;
}): Promise<DynamicToolCallResponse> {
  return await buildAutomationInspectionToolRouter(params.handler).handleDynamicToolCall({
    backend: params.backend,
    call: params.call,
  });
}

export function buildAutomationInspectionDynamicToolErrorResponse(params: {
  code: "forbidden" | "internal_error" | "unsupported_operation";
  message: string;
  operation?: AutomationInspectionOperationName;
}): DynamicToolCallResponse {
  return toDynamicToolResponse({
    ok: false,
    code: params.code,
    message: params.message,
  });
}

export function readAutomationInspectionDynamicToolCall(
  request: {
    method: string;
    params: Record<string, unknown>;
  },
): DynamicToolCallParams | undefined {
  return readAgentDynamicToolCall(request);
}
