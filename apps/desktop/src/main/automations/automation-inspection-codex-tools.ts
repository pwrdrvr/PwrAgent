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
} from "@pwragent/codex-app-server-protocol/v2";
import { buildAutomationInspectionToolCatalog } from "./automation-inspection-tool-catalog.js";

export type AutomationInspectionHandler = (
  request: AutomationInspectionRequest,
) => AutomationInspectionResponse | Promise<AutomationInspectionResponse>;

export function buildAutomationInspectionDynamicToolSpecs(): DynamicToolSpec[] {
  return buildAutomationInspectionToolCatalog().map((spec) => {
    return {
      namespace: AUTOMATION_INSPECTION_TOOL_NAMESPACE,
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema as DynamicToolSpec["inputSchema"],
      deferLoading: false,
    };
  });
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
  if (!isAutomationInspectionDynamicToolCall(params.call)) {
    return toDynamicToolResponse({
      ok: false,
      operation: params.call.tool as AutomationInspectionOperationName,
      error: {
        code: "unsupported_operation",
        message: "Unsupported PwrAgent automation tool.",
      },
    });
  }
  if (!params.handler) {
    return toDynamicToolResponse({
      ok: false,
      operation: params.call.tool,
      error: {
        code: "internal_error",
        message: "PwrAgent automation inspection is not available.",
      },
    });
  }
  const context: AutomationInspectionContext = {
    backend: params.backend,
    threadId: params.call.threadId,
  };
  const response = await params.handler({
    operation: params.call.tool,
    context,
    args: normalizeToolArguments(params.call.arguments),
  } as AutomationInspectionRequest);
  return toDynamicToolResponse(response);
}

export function buildAutomationInspectionDynamicToolErrorResponse(params: {
  code: "forbidden" | "internal_error" | "unsupported_operation";
  message: string;
  operation?: AutomationInspectionOperationName;
}): DynamicToolCallResponse {
  return toDynamicToolResponse({
    ok: false,
    operation: params.operation ?? "list_automations",
    error: {
      code: params.code,
      message: params.message,
    },
  });
}

export function readAutomationInspectionDynamicToolCall(
  request: {
    method: string;
    params: Record<string, unknown>;
  },
): DynamicToolCallParams | undefined {
  if (request.method !== "item/tool/call") {
    return undefined;
  }
  const call = request.params;
  const threadId = readString(call.threadId);
  const turnId = readString(call.turnId) ?? "";
  const callId = readString(call.callId) ?? readString(call.requestId);
  const tool = readString(call.tool);
  const namespace =
    typeof call.namespace === "string" || call.namespace === null
      ? call.namespace
      : undefined;
  if (!threadId || !callId || !tool || namespace === undefined) {
    return undefined;
  }
  return {
    threadId,
    turnId,
    callId,
    namespace,
    tool,
    arguments: (call.arguments ?? null) as DynamicToolCallParams["arguments"],
  };
}

function toDynamicToolResponse(
  response: AutomationInspectionResponse,
): DynamicToolCallResponse {
  return {
    success: response.ok,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify(response.ok ? response.data : response.error, null, 2),
      },
    ],
  };
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
