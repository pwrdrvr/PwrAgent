export const PWRSNAP_MCP_CONNECTION_ID = "pwrsnap" as const;

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

export type ConnectPwrSnapResponse = {
  status: PwrSnapConnectionStatus;
  outcome: "connected" | "needs_local_agent_access";
};

export type OpenPwrSnapResponse = {
  opened: boolean;
  error?: string;
};
