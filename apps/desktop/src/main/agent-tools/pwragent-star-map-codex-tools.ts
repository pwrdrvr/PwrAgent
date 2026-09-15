import type {
  AppServerBackendKind,
  PwrAgentStarMapOperationName,
} from "@pwragent/shared";
import {
  PWRAGENT_STAR_MAP_OPERATION_NAMES,
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
  buildPwrAgentStarMapToolRouter,
  type PwrAgentStarMapHandler,
} from "./pwragent-star-map-agent-tools.js";

export function isPwrAgentStarMapDynamicToolCall(
  call: Pick<DynamicToolCallParams, "namespace" | "tool">,
): call is DynamicToolCallParams & {
  namespace: typeof PWRAGENT_TOOL_NAMESPACE;
  tool: PwrAgentStarMapOperationName;
} {
  return (
    call.namespace === PWRAGENT_TOOL_NAMESPACE &&
    PWRAGENT_STAR_MAP_OPERATION_NAMES.includes(
      call.tool as PwrAgentStarMapOperationName,
    )
  );
}

export async function handlePwrAgentStarMapDynamicToolCall(params: {
  backend: AppServerBackendKind;
  call: DynamicToolCallParams;
  handler: PwrAgentStarMapHandler | undefined;
}): Promise<DynamicToolCallResponse> {
  return await buildPwrAgentStarMapToolRouter(
    params.handler,
  ).handleDynamicToolCall({
    backend: params.backend,
    call: params.call,
  });
}

export function buildPwrAgentStarMapDynamicToolErrorResponse(params: {
  code: "forbidden" | "internal_error";
  message: string;
}): DynamicToolCallResponse {
  return toDynamicToolResponse({
    ok: false,
    code: params.code,
    message: params.message,
  });
}

export function readPwrAgentStarMapDynamicToolCall(request: {
  method: string;
  params: Record<string, unknown>;
}): DynamicToolCallParams | undefined {
  return readAgentDynamicToolCall(request);
}
