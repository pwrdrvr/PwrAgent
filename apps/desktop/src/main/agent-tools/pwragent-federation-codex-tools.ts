import type {
  AppServerBackendKind,
  PwrAgentFederationOperationName,
} from "@pwragent/shared";
import {
  PWRAGENT_FEDERATION_OPERATION_NAMES,
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
  buildPwrAgentFederationToolRouter,
  type PwrAgentFederationHandler,
} from "./pwragent-federation-agent-tools.js";

export function isPwrAgentFederationDynamicToolCall(
  call: Pick<DynamicToolCallParams, "namespace" | "tool">,
): call is DynamicToolCallParams & {
  namespace: typeof PWRAGENT_TOOL_NAMESPACE;
  tool: PwrAgentFederationOperationName;
} {
  return (
    call.namespace === PWRAGENT_TOOL_NAMESPACE &&
    PWRAGENT_FEDERATION_OPERATION_NAMES.includes(
      call.tool as PwrAgentFederationOperationName,
    )
  );
}

export async function handlePwrAgentFederationDynamicToolCall(params: {
  backend: AppServerBackendKind;
  call: DynamicToolCallParams;
  handler: PwrAgentFederationHandler | undefined;
}): Promise<DynamicToolCallResponse> {
  return await buildPwrAgentFederationToolRouter(
    params.handler,
  ).handleDynamicToolCall({
    backend: params.backend,
    call: params.call,
  });
}

export function buildPwrAgentFederationDynamicToolErrorResponse(params: {
  code: "forbidden" | "internal_error";
  message: string;
}): DynamicToolCallResponse {
  return toDynamicToolResponse({
    ok: false,
    code: params.code,
    message: params.message,
  });
}

export function readPwrAgentFederationDynamicToolCall(request: {
  method: string;
  params: Record<string, unknown>;
}): DynamicToolCallParams | undefined {
  return readAgentDynamicToolCall(request);
}
