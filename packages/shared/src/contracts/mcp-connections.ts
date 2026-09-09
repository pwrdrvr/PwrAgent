import type { FederationRemoteTarget } from "./federation";

export const PWRSNAP_MCP_CONNECTION_ID = "pwrsnap" as const;
export const PWRGIT_MCP_CONNECTION_ID = "pwrgit" as const;

/**
 * Shown on the New thread PwrSnap band next to the Connect to PwrSnap button
 * after PwrSnap rejected the stored session.
 */
export const PWRSNAP_SESSION_REVOKED_DETAIL =
  "PwrSnap revoked this connection. Choose Connect to PwrSnap to connect again.";

export const MCP_CONNECTION_IDS = [
  PWRSNAP_MCP_CONNECTION_ID,
  PWRGIT_MCP_CONNECTION_ID,
] as const;

export type McpConnectionId = (typeof MCP_CONNECTION_IDS)[number];

export function isMcpConnectionId(value: string): value is McpConnectionId {
  return (MCP_CONNECTION_IDS as readonly string[]).includes(value);
}

/** Product names for copy that has to name the app behind a connection id. */
export const MCP_CONNECTION_DISPLAY_NAMES: Record<McpConnectionId, string> = {
  [PWRSNAP_MCP_CONNECTION_ID]: "PwrSnap",
  [PWRGIT_MCP_CONNECTION_ID]: "PwrGit",
};

/**
 * A thread's enabled connections are stored as one list, so a toggle for one
 * app must not clobber another's entry. Every surface that flips a single
 * connection composes through this rather than replacing the array.
 */
export function withMcpConnection(
  current: readonly string[] | undefined,
  connectionId: McpConnectionId,
  enabled: boolean,
): string[] {
  const others = (current ?? []).filter((id) => id !== connectionId);
  return enabled ? [...others, connectionId] : others;
}

/** Shared by every PwrSuite MCP connection card. */
export type McpConnectionAvailability =
  | "not_installed"
  | "installed"
  | "running";

export type PwrSnapConnectionAvailability = McpConnectionAvailability;

export type PwrSnapConnectionStatus = {
  connectionId: typeof PWRSNAP_MCP_CONNECTION_ID;
  displayName: "PwrSnap";
  availability: PwrSnapConnectionAvailability;
  configured: boolean;
  detail?: string;
};

export type PwrGitConnectionStatus = {
  connectionId: typeof PWRGIT_MCP_CONNECTION_ID;
  displayName: "PwrGit";
  availability: McpConnectionAvailability;
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

export type ConnectPwrGitResponse = {
  status: PwrGitConnectionStatus;
  outcome:
    | "connected"
    | "needs_local_agent_access"
    /**
     * PwrGit answered but pairing could not finish: its MCP server was not
     * found beside the app, it stopped answering, or the approved credential
     * could not be stored.
     */
    | "unavailable"
    | "declined"
    | "timed_out";
  /**
   * What to show for a non-connected outcome. Absent when `status.detail`
   * already says everything there is to say, so the card does not stack the
   * same sentence twice.
   */
  detail?: string;
};

export type OpenPwrSnapResponse = {
  opened: boolean;
  error?: string;
};

export type OpenPwrGitResponse = OpenPwrSnapResponse;
