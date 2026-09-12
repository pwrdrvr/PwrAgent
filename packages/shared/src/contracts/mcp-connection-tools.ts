import type { AppServerBackendKind } from "./normalized-app-server";
import type {
  DescribeThreadMcpConnectionsResponse,
  McpConnectionAuthMode,
  McpConnectionId,
  McpConnectionKind,
  McpConnectionRuntimeState,
  McpConnectionSetupState,
} from "./mcp-connections";

export const PWRAGENT_MCP_CONNECTION_OPERATION_NAMES = [
  "manage_mcp_connections",
] as const;

export type PwrAgentMcpConnectionOperationName =
  (typeof PWRAGENT_MCP_CONNECTION_OPERATION_NAMES)[number];

/**
 * What an agent may do to this profile's MCP registry.
 *
 * An agent proposes and inspects; a person authorizes and enables.
 * `create` writes an inert record and nothing else — it reaches no network,
 * mints no bridge grant, and cannot be selected by a thread until someone
 * completes the OAuth consent in Settings. `authorize`, `set_enabled` and
 * `remove` are deliberately absent: the first inherently needs a browser
 * consent the agent cannot give, and the other two are exactly the controls
 * an instruction injected through tool output would reach for.
 */
export const PWRAGENT_MCP_CONNECTION_ACTIONS = [
  "list",
  "create",
  "describe_thread",
] as const;

export type PwrAgentMcpConnectionAction =
  (typeof PWRAGENT_MCP_CONNECTION_ACTIONS)[number];

export const PWRAGENT_MCP_CONNECTION_ERROR_CODES = [
  "invalid_arguments",
  "duplicate_connection",
  "forbidden",
  "unsupported_operation",
  "not_found",
  "internal_error",
] as const;

export type PwrAgentMcpConnectionErrorCode =
  (typeof PWRAGENT_MCP_CONNECTION_ERROR_CODES)[number];

export type PwrAgentMcpConnectionContext = {
  backend: AppServerBackendKind;
  threadId?: string;
};

export type CreateMcpConnectionToolArgs = {
  displayName: string;
  serverUrl: string;
};

export type DescribeThreadMcpConnectionsToolArgs = {
  /** Defaults to the calling thread. */
  threadId?: string;
};

export type PwrAgentMcpConnectionToolArgs =
  | { action: "list" }
  | ({ action: "create" } & CreateMcpConnectionToolArgs)
  | ({ action: "describe_thread" } & DescribeThreadMcpConnectionsToolArgs);

export type PwrAgentMcpConnectionListEntry = {
  id: McpConnectionId;
  displayName: string;
  serverUrl: string;
  kind: McpConnectionKind;
  authMode: McpConnectionAuthMode;
  state: McpConnectionRuntimeState;
  setupState: McpConnectionSetupState;
  /** The same sentence the Settings row shows, so both agree. */
  setupDetail: string;
  configured: boolean;
  enabled: boolean;
  /** Whether a thread that selects this can actually reach it today. */
  threadSelectable: boolean;
};

export type PwrAgentMcpConnectionListData = {
  action: "list";
  gatewayEnabled: boolean;
  connections: PwrAgentMcpConnectionListEntry[];
};

export type PwrAgentMcpConnectionCreateData = {
  action: "create";
  id: McpConnectionId;
  displayName: string;
  serverUrl: string;
  setupState: McpConnectionSetupState;
  /**
   * Always states that a person has to finish this. The agent cannot
   * complete an OAuth consent, and a record it created is inert until
   * someone does.
   */
  nextStep: string;
};

export type PwrAgentMcpConnectionDescribeThreadData = {
  action: "describe_thread";
} & DescribeThreadMcpConnectionsResponse;

export type PwrAgentMcpConnectionData =
  | PwrAgentMcpConnectionListData
  | PwrAgentMcpConnectionCreateData
  | PwrAgentMcpConnectionDescribeThreadData;

export type PwrAgentMcpConnectionRequest = {
  operation: PwrAgentMcpConnectionOperationName;
  context: PwrAgentMcpConnectionContext;
  args: PwrAgentMcpConnectionToolArgs;
};

export type PwrAgentMcpConnectionResponse =
  | { ok: true; data: PwrAgentMcpConnectionData }
  | {
      ok: false;
      error: {
        code: PwrAgentMcpConnectionErrorCode;
        message: string;
      };
    };

export function isPwrAgentMcpConnectionAction(
  value: unknown,
): value is PwrAgentMcpConnectionAction {
  return (
    typeof value === "string"
    && (PWRAGENT_MCP_CONNECTION_ACTIONS as readonly string[]).includes(value)
  );
}
