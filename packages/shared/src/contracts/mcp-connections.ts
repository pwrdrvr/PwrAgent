import type { AppServerBackendKind } from "./normalized-app-server";
import type { FederationRemoteTarget } from "./federation";

export const PWRSNAP_MCP_CONNECTION_ID = "pwrsnap" as const;

export type McpConnectionId = string;

export type McpConnectionAuthMode = "oauth";

export type McpConnectionKind = "remote" | "pwrsnap";

export type McpConnectionRecord = {
  id: McpConnectionId;
  displayName: string;
  serverUrl: string;
  authMode: McpConnectionAuthMode;
  kind: McpConnectionKind;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type McpConnectionRuntimeState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "refreshing"
  | "reauthorization_required"
  | "temporarily_unavailable";

export type McpConnectionStatus = McpConnectionRecord & {
  state: McpConnectionRuntimeState;
  configured: boolean;
  detail?: string;
};

export type ListMcpConnectionsResponse = {
  connections: McpConnectionStatus[];
};

export type CreateMcpConnectionRequest = {
  displayName: string;
  serverUrl: string;
};

export type CreateMcpConnectionResponse = {
  connection: McpConnectionStatus;
};

export type AuthorizeMcpConnectionRequest = {
  connectionId: McpConnectionId;
};

export type AuthorizeMcpConnectionResponse = {
  connection: McpConnectionStatus;
};

export type DisconnectMcpConnectionRequest = {
  connectionId: McpConnectionId;
};

/**
 * Whether a connection may be offered to threads at all.
 *
 * This is the profile-wide availability switch, not a per-thread selection.
 * A connection can be authorized and healthy yet withheld from every thread,
 * which is how an operator parks a connection without discarding its
 * credentials.
 */
export type SetMcpConnectionEnabledRequest = {
  connectionId: McpConnectionId;
  enabled: boolean;
};

export type RemoveMcpConnectionRequest = {
  connectionId: McpConnectionId;
};

export type MutateMcpConnectionResponse = {
  connectionId: McpConnectionId;
  removed?: true;
  connection?: McpConnectionStatus;
};

export type PwrSnapConnectionAvailability =
  | "not_installed"
  | "installed"
  | "running";

export type PwrSnapConnectionStatus = {
  connectionId: typeof PWRSNAP_MCP_CONNECTION_ID;
  displayName: "PwrSnap";
  availability: PwrSnapConnectionAvailability;
  configured: boolean;
  detail?: string;
};

export type ReadPwrSnapConnectionStatusRequest = {
  federationTarget?: FederationRemoteTarget;
};

export type ConnectPwrSnapResponse = {
  status: PwrSnapConnectionStatus;
  outcome: "connected" | "needs_local_agent_access";
};

export type OpenPwrSnapResponse = {
  opened: boolean;
  error?: string;
};

/**
 * A thread's MCP selection, editable for the life of the thread.
 *
 * `providerServersEnabled` controls whether the backend's own configured MCP
 * servers stay available alongside the selected connections. Only Codex can
 * honor `false`: its per-thread config accepts `{ enabled: false }` overrides
 * for inherited servers, while ACP gives PwrAgent no way to suppress servers
 * the agent loads for itself. Callers must not offer the control for backends
 * that cannot enforce it.
 */
export type SetThreadMcpConnectionsRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  connectionIds: McpConnectionId[];
  providerServersEnabled?: boolean;
};

export type ReadThreadMcpConnectionsRequest = {
  backend: AppServerBackendKind;
  threadId: string;
};

export type SetThreadMcpConnectionsResponse = {
  connectionIds: McpConnectionId[];
  providerServersEnabled: boolean;
};

/**
 * When a change to a thread's MCP selection actually reaches the agent.
 *
 * Codex re-reads the thread overlay while starting each turn, so a change
 * lands on the next message. ACP resolves MCP servers only during
 * `session/new` and `session/load`, so a change lands when the thread's
 * session is next loaded. Telling the operator "saved" without saying which
 * of these applies would be a lie in the common case.
 */
export type McpSelectionApplyTiming = "next_turn" | "next_session_load";

export function mcpSelectionApplyTiming(
  backend: AppServerBackendKind,
): McpSelectionApplyTiming {
  return backend === "codex" ? "next_turn" : "next_session_load";
}

/**
 * Whether a backend can suppress the MCP servers it loads for itself.
 *
 * Only the Codex path can: it writes a per-thread config that disables each
 * inherited server by name. An ACP agent resolves its own servers internally
 * and takes no such instruction, so a stored "off" there would be a promise
 * nothing keeps. Both the renderer control and the main-process writer read
 * this, so a thread cannot end up holding a flag its backend ignores.
 */
export function canIsolateMcpProviderServers(
  backend: AppServerBackendKind,
): boolean {
  return backend === "codex";
}
