import type { FederationRemoteTarget } from "./federation";

export const PWRSNAP_MCP_CONNECTION_ID = "pwrsnap" as const;
export const PWRGIT_MCP_CONNECTION_ID = "pwrgit" as const;

export const MCP_CONNECTION_IDS = [
  PWRSNAP_MCP_CONNECTION_ID,
  PWRGIT_MCP_CONNECTION_ID,
] as const;

export type McpConnectionId = (typeof MCP_CONNECTION_IDS)[number];

export function isMcpConnectionId(value: string): value is McpConnectionId {
  return (MCP_CONNECTION_IDS as readonly string[]).includes(value);
}

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

export type PwrSnapConnectionAvailability =
  | "not_installed"
  | "installed"
  | "running";

/** Shared by every PwrSuite MCP connection card. */
export type McpConnectionAvailability = PwrSnapConnectionAvailability;

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
  /**
   * True when PwrGit answers on its loopback port but the operator has not
   * turned Local agent access on. The card can then say what to switch on
   * rather than offering a pairing that will time out.
   */
  agentAccessDisabled?: boolean;
};

export type ReadPwrSnapConnectionStatusRequest = {
  federationTarget?: FederationRemoteTarget;
};

export type ReadPwrGitConnectionStatusRequest =
  ReadPwrSnapConnectionStatusRequest;

export type ConnectPwrSnapResponse = {
  status: PwrSnapConnectionStatus;
  outcome: "connected" | "needs_local_agent_access";
};

export type ConnectPwrGitResponse = {
  status: PwrGitConnectionStatus;
  outcome:
    | "connected"
    | "needs_local_agent_access"
    | "declined"
    | "timed_out";
  /** Set when the operator never answered or said no, for the card to show. */
  detail?: string;
};

export type OpenPwrSnapResponse = {
  opened: boolean;
  error?: string;
};

export type OpenPwrGitResponse = OpenPwrSnapResponse;
