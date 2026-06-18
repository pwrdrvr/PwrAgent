import type {
  AppServerBackendKind,
  PwrAgentMessagingOperationName,
} from "@pwragent/shared";
import {
  PWRAGENT_MESSAGING_CALLABLE_OPERATION_NAMES,
  PWRAGENT_MESSAGING_TOOL_NAMESPACE,
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
  buildPwrAgentMessagingToolRouter,
  type PwrAgentMessagingHandler,
} from "./pwragent-messaging-agent-tools.js";

export function isPwrAgentMessagingDynamicToolCall(
  call: Pick<DynamicToolCallParams, "namespace" | "tool">,
): call is DynamicToolCallParams & {
  namespace: typeof PWRAGENT_MESSAGING_TOOL_NAMESPACE;
  tool: PwrAgentMessagingOperationName;
} {
  return (
    call.namespace === PWRAGENT_MESSAGING_TOOL_NAMESPACE &&
    PWRAGENT_MESSAGING_CALLABLE_OPERATION_NAMES.includes(
      call.tool as PwrAgentMessagingOperationName,
    )
  );
}

export async function handlePwrAgentMessagingDynamicToolCall(params: {
  backend: AppServerBackendKind;
  call: DynamicToolCallParams;
  handler: PwrAgentMessagingHandler | undefined;
}): Promise<DynamicToolCallResponse> {
  return await buildPwrAgentMessagingToolRouter(params.handler).handleDynamicToolCall({
    backend: params.backend,
    call: params.call,
  });
}

export function buildPwrAgentMessagingDynamicToolErrorResponse(params: {
  code:
    | "ambiguous_location"
    | "forbidden"
    | "internal_error"
    | "unsupported_operation";
  message: string;
}): DynamicToolCallResponse {
  return toDynamicToolResponse({
    ok: false,
    code: params.code,
    message: params.message,
  });
}

export function readPwrAgentMessagingDynamicToolCall(request: {
  method: string;
  params: Record<string, unknown>;
}): DynamicToolCallParams | undefined {
  return readAgentDynamicToolCall(request);
}
