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

export type AutomationInspectionHandler = (
  request: AutomationInspectionRequest,
) => AutomationInspectionResponse | Promise<AutomationInspectionResponse>;

type OperationSpec = {
  description: string;
  inputSchema: Record<string, unknown>;
};

const OPERATION_SPECS: Record<AutomationInspectionOperationName, OperationSpec> = {
  list_automations: {
    description:
      "List automations attached to this PwrAgent Agent thread with compact status and latest-run metadata.",
    inputSchema: {
      type: "object",
      properties: {
        includePaused: { type: "boolean" },
        includeDeleted: { type: "boolean" },
        limit: { type: "number", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  summarize_automation_status: {
    description:
      "Summarize automation health and recent run activity for this PwrAgent Agent thread.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1 },
        since: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  list_automation_runs: {
    description:
      "List recent automation runs for this Agent thread or one attached automation.",
    inputSchema: {
      type: "object",
      properties: {
        automationId: { type: "string" },
        limit: { type: "number", minimum: 1 },
        since: { type: "number" },
        statuses: {
          type: "array",
          items: { type: "string" },
        },
      },
      additionalProperties: false,
    },
  },
  get_automation_run: {
    description:
      "Inspect one automation run's status, timing, trigger, output summary, and error metadata.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  get_automation_run_artifact: {
    description:
      "Fetch one automation run's stored output artifact, card decision, and bounded transcript events.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        eventLimit: { type: "number", minimum: 1 },
        textLimitChars: { type: "number", minimum: 1 },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
};

export function buildAutomationInspectionDynamicToolSpecs(): DynamicToolSpec[] {
  return AUTOMATION_INSPECTION_OPERATION_NAMES.map((name) => {
    const spec = OPERATION_SPECS[name];
    return {
      namespace: AUTOMATION_INSPECTION_TOOL_NAMESPACE,
      name,
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
