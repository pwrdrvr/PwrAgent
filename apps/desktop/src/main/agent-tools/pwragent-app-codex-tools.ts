import type {
  AppServerBackendKind,
  PwrAgentAppOperationName,
} from "@pwragent/shared";
import {
  PWRAGENT_APP_OPERATION_NAMES,
  PWRAGENT_APP_TOOL_NAMESPACE,
  PWRAGENT_TOOL_NAMESPACE,
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
  buildPwrAgentAppToolRouter,
  type PwrAgentAppManagementHandler,
} from "./pwragent-app-agent-tools.js";

export function isPwrAgentAppDynamicToolCall(
  call: Pick<DynamicToolCallParams, "namespace" | "tool">,
): call is DynamicToolCallParams & {
  namespace: typeof PWRAGENT_APP_TOOL_NAMESPACE | typeof PWRAGENT_TOOL_NAMESPACE;
  tool: PwrAgentAppOperationName;
} {
  return (
    call.namespace === PWRAGENT_APP_TOOL_NAMESPACE ||
    (call.namespace === PWRAGENT_TOOL_NAMESPACE &&
      PWRAGENT_APP_OPERATION_NAMES.includes(
        call.tool as PwrAgentAppOperationName,
      ))
  );
}

export async function handlePwrAgentAppDynamicToolCall(params: {
  backend: AppServerBackendKind;
  call: DynamicToolCallParams;
  handler: PwrAgentAppManagementHandler | undefined;
}): Promise<DynamicToolCallResponse> {
  const call = isPwrAgentAppDynamicToolCall(params.call)
    ? { ...params.call, namespace: PWRAGENT_TOOL_NAMESPACE }
    : params.call;
  return await buildPwrAgentAppToolRouter(params.handler).handleDynamicToolCall({
    backend: params.backend,
    call,
  });
}

export function buildPwrAgentAppDynamicToolErrorResponse(params: {
  code: "forbidden" | "internal_error" | "unsupported_operation";
  message: string;
}): DynamicToolCallResponse {
  return toDynamicToolResponse({
    ok: false,
    code: params.code,
    message: params.message,
  });
}

export function readPwrAgentAppDynamicToolCall(request: {
  method: string;
  params: Record<string, unknown>;
}): DynamicToolCallParams | undefined {
  return readAgentDynamicToolCall(request);
}
