import type {
  AppServerBackendKind,
  AutomationInspectionContext,
  AutomationInspectionOperationName,
  AutomationInspectionRequest,
  AutomationInspectionResponse,
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
import type {
  AgentToolDefinition,
  AgentToolDispatchResult,
} from "../agent-tools/agent-tool-definition.js";
import { agentToolFailure, agentToolSuccess } from "../agent-tools/agent-tool-definition.js";
import {
  AgentToolRouter,
  readAgentDynamicToolCall,
  toDynamicToolResponse,
} from "../agent-tools/agent-tool-router.js";
import { buildAutomationInspectionToolCatalog } from "./automation-inspection-tool-catalog.js";

export type AutomationInspectionHandler = (
  request: AutomationInspectionRequest,
) => AutomationInspectionResponse | Promise<AutomationInspectionResponse>;

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

function buildAutomationInspectionToolRouter(
  handler: AutomationInspectionHandler | undefined,
): AgentToolRouter {
  return new AgentToolRouter(buildAutomationInspectionToolDefinitions(handler), {
    unsupportedMessage: "Unsupported PwrAgent automation tool.",
  });
}

function buildAutomationInspectionToolDefinitions(
  handler: AutomationInspectionHandler | undefined,
): AgentToolDefinition<AutomationInspectionOperationName>[] {
  return buildAutomationInspectionToolCatalog().map((spec) => ({
    namespace: AUTOMATION_INSPECTION_TOOL_NAMESPACE,
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    deferLoading: false,
    dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
      if (!handler) {
        return agentToolFailure({
          code: "internal_error",
          message: "PwrAgent automation inspection is not available.",
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
