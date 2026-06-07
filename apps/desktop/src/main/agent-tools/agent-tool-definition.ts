import type { AppServerBackendKind, ThreadIdentifier } from "@pwragent/shared";
import type { DynamicToolCallResponse } from "@pwrdrvr/codex-app-server-protocol/v2";

export type AgentToolTransport = "codex_dynamic_tool" | "acp_mcp";

export type AgentToolCallContext = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId?: string;
  transport: AgentToolTransport;
};

export type AgentToolCallContentItems = NonNullable<
  DynamicToolCallResponse["contentItems"]
>;

export type AgentToolDispatchSuccess = {
  ok: true;
  data: unknown;
  contentItems?: AgentToolCallContentItems;
};

export type AgentToolDispatchFailure = {
  ok: false;
  code: string;
  message: string;
  data?: unknown;
  contentItems?: AgentToolCallContentItems;
};

export type AgentToolDispatchResult =
  | AgentToolDispatchSuccess
  | AgentToolDispatchFailure;

export type AgentToolDefinition<TName extends string = string> = {
  namespace: string;
  name: TName;
  description: string;
  inputSchema: Record<string, unknown>;
  deferLoading?: boolean;
  dispatch: (
    args: Record<string, unknown>,
    context: AgentToolCallContext,
  ) => AgentToolDispatchResult | Promise<AgentToolDispatchResult>;
};

export function agentToolSuccess(
  data: unknown,
  options: { contentItems?: AgentToolCallContentItems } = {},
): AgentToolDispatchSuccess {
  return {
    ok: true,
    data,
    contentItems: options.contentItems,
  };
}

export function agentToolFailure(params: {
  code: string;
  message: string;
  data?: unknown;
  contentItems?: AgentToolCallContentItems;
}): AgentToolDispatchFailure {
  return {
    ok: false,
    code: params.code,
    message: params.message,
    data: params.data,
    contentItems: params.contentItems,
  };
}
