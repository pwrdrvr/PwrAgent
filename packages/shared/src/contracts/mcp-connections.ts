import type { FederationRemoteTarget } from "./federation";

export const PWRSNAP_MCP_CONNECTION_ID = "pwrsnap" as const;

/**
 * Shown on the New thread PwrSnap band next to the Connect to PwrSnap button
 * after PwrSnap rejected the stored session.
 */
export const PWRSNAP_SESSION_REVOKED_DETAIL =
  "PwrSnap revoked this connection. Choose Connect to PwrSnap to connect again.";

export type McpConnectionId = typeof PWRSNAP_MCP_CONNECTION_ID;

export type PwrSnapConnectionAvailability =
  | "not_installed"
  | "installed"
  | "running";

export type PwrSnapConnectionStatus = {
  connectionId: McpConnectionId;
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
