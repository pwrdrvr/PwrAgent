import { canSeedNewThreadMcpConnection, type McpConnectionStatus } from "./mcp-connections.js";

/** Editable starting values copied into a new Agent thread. */
export type AgentPresetDefaults = {
  name: string;
  instructions?: string;
  /** PwrAgent connection IDs from this profile. An empty selection is explicit. */
  mcpConnectionIds: string[];
  /** Operator opt-in for actors allowed to create threads through messaging. */
  availableInMessaging?: true;
};

export type AgentPreset = AgentPresetDefaults & { id: string };

export type SaveAgentPresetRequest = AgentPresetDefaults & { id?: string };

export type ManageAgentPresetsRequest =
  | { action: "list" }
  | { action: "save"; preset: SaveAgentPresetRequest }
  | { action: "delete"; id: string };

export function resolveAgentPresetConnections(
  ids: readonly string[],
  connections: ReadonlyArray<Pick<McpConnectionStatus, "id" | "enabled" | "configured" | "state">>,
): { selected: string[]; skipped: string[] } {
  const ready = new Set(connections.filter(canSeedNewThreadMcpConnection).map(({ id }) => id));
  const selected: string[] = [];
  const skipped: string[] = [];
  for (const id of new Set(ids)) {
    (ready.has(id) ? selected : skipped).push(id);
  }
  return { selected, skipped };
}
