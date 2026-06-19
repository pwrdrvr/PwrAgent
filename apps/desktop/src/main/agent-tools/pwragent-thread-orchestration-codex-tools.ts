import type {
  AppServerBackendKind,
  PwrAgentThreadOrchestrationOperationName,
} from "@pwragent/shared";
import {
  PWRAGENT_THREAD_ORCHESTRATION_OPERATION_NAMES,
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
  buildPwrAgentThreadOrchestrationToolRouter,
  type PwrAgentThreadOrchestrationHandler,
} from "./pwragent-thread-orchestration-agent-tools.js";

export function isPwrAgentThreadOrchestrationDynamicToolCall(
  call: Pick<DynamicToolCallParams, "namespace" | "tool">,
): call is DynamicToolCallParams & {
  namespace: typeof PWRAGENT_TOOL_NAMESPACE;
  tool: PwrAgentThreadOrchestrationOperationName;
} {
  return (
    call.namespace === PWRAGENT_TOOL_NAMESPACE &&
    PWRAGENT_THREAD_ORCHESTRATION_OPERATION_NAMES.includes(
      call.tool as PwrAgentThreadOrchestrationOperationName,
    )
  );
}

export async function handlePwrAgentThreadOrchestrationDynamicToolCall(params: {
  backend: AppServerBackendKind;
  call: DynamicToolCallParams;
  handler: PwrAgentThreadOrchestrationHandler | undefined;
}): Promise<DynamicToolCallResponse> {
  return await buildPwrAgentThreadOrchestrationToolRouter(
    params.handler,
  ).handleDynamicToolCall({
    backend: params.backend,
    call: params.call,
  });
}

export function buildPwrAgentThreadOrchestrationDynamicToolErrorResponse(params: {
  code:
    | "forbidden"
    | "internal_error"
    | "unsupported_backend"
    | "unsupported_operation";
  message: string;
}): DynamicToolCallResponse {
  return toDynamicToolResponse({
    ok: false,
    code: params.code,
    message: params.message,
  });
}

export function readPwrAgentThreadOrchestrationDynamicToolCall(request: {
  method: string;
  params: Record<string, unknown>;
}): DynamicToolCallParams | undefined {
  return readAgentDynamicToolCall(request);
}
