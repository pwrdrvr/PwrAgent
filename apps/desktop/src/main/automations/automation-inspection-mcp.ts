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
import type { AutomationInspectionHandler } from "./automation-inspection-codex-tools.js";
import { buildAutomationInspectionToolCatalog } from "./automation-inspection-tool-catalog.js";

export type AutomationInspectionMcpTool = {
  name: AutomationInspectionOperationName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AutomationInspectionMcpCallResponse = {
  content: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent?: unknown;
  isError?: boolean;
};

export function buildAutomationInspectionMcpTools(): AutomationInspectionMcpTool[] {
  return buildAutomationInspectionToolCatalog().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
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
  if (!isAutomationInspectionMcpToolName(params.tool)) {
    return toMcpToolResponse({
      ok: false,
      operation: "list_automations",
      error: {
        code: "unsupported_operation",
        message: `Unsupported ${AUTOMATION_INSPECTION_TOOL_NAMESPACE} tool.`,
      },
    });
  }
  if (!params.handler) {
    return toMcpToolResponse({
      ok: false,
      operation: params.tool,
      error: {
        code: "internal_error",
        message: "PwrAgent automation inspection is not available.",
      },
    });
  }
  const context: AutomationInspectionContext = {
    backend: params.backend,
    threadId: params.threadId,
  };
  return toMcpToolResponse(
    await params.handler({
      operation: params.tool,
      context,
      args: normalizeToolArguments(params.args),
    } as AutomationInspectionRequest),
  );
}

function toMcpToolResponse(
  response: AutomationInspectionResponse,
): AutomationInspectionMcpCallResponse {
  const payload = response.ok ? response.data : response.error;
  return {
    isError: response.ok ? undefined : true,
    structuredContent: payload,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
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
