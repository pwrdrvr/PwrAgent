import type {
  AppServerBackendKind,
  PwrAgentThreadInspectionOperationName,
} from "@pwragent/shared";
import {
  PWRAGENT_THREAD_INSPECTION_OPERATION_NAMES,
  PWRAGENT_THREAD_TOOL_NAMESPACE,
} from "@pwragent/shared";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import {
  readAgentDynamicToolCall,
  toDynamicToolResponse,
} from "./agent-tool-router.js";
import {
  buildPwrAgentThreadToolRouter,
  type PwrAgentThreadInspectionHandler,
} from "./pwragent-thread-agent-tools.js";

export function isPwrAgentThreadDynamicToolCall(
  call: Pick<DynamicToolCallParams, "namespace" | "tool">,
): call is DynamicToolCallParams & {
  namespace: typeof PWRAGENT_THREAD_TOOL_NAMESPACE;
  tool: PwrAgentThreadInspectionOperationName;
} {
  return (
    call.namespace === PWRAGENT_THREAD_TOOL_NAMESPACE &&
    PWRAGENT_THREAD_INSPECTION_OPERATION_NAMES.includes(
      call.tool as PwrAgentThreadInspectionOperationName,
    )
  );
}

export async function handlePwrAgentThreadDynamicToolCall(params: {
  backend: AppServerBackendKind;
  call: DynamicToolCallParams;
  handler: PwrAgentThreadInspectionHandler | undefined;
}): Promise<DynamicToolCallResponse> {
  return await buildPwrAgentThreadToolRouter(params.handler).handleDynamicToolCall({
    backend: params.backend,
    call: params.call,
  });
}

export function buildPwrAgentThreadDynamicToolErrorResponse(params: {
  code: "forbidden" | "internal_error" | "unsupported_operation";
  message: string;
}): DynamicToolCallResponse {
  return toDynamicToolResponse({
    ok: false,
    code: params.code,
    message: params.message,
  });
}

export function readPwrAgentThreadDynamicToolCall(request: {
  method: string;
  params: Record<string, unknown>;
}): DynamicToolCallParams | undefined {
  return readAgentDynamicToolCall(request);
}
