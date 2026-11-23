export const PWRAGENT_TOOL_NAMESPACE = "pwragent";

/** The full JSON-RPC body on the local HTTP MCP transport. */
export const PWRAGENT_MCP_HTTP_MAX_REQUEST_BYTES = 1024 * 1024;

export const AGENT_TOOL_CATALOG_IDS = [
  "automation_inspection",
  "app_management",
  "thread_inspection",
  "forge",
  "messaging_context",
  "thread_orchestration",
  "federation",
  "mcp_connections",
  "token_miser",
  "star_map",
  "thread_todos",
  "openai_decisions",
] as const;

export type AgentToolCatalogId = (typeof AGENT_TOOL_CATALOG_IDS)[number];

export type AgentToolCatalogSummary = {
  id: AgentToolCatalogId;
  namespace: string;
  enabled: boolean;
  toolCount: number;
  unavailableReason?: string;
  fingerprint?: string;
};

export function isAgentToolCatalogId(value: unknown): value is AgentToolCatalogId {
  return (
    typeof value === "string" &&
    AGENT_TOOL_CATALOG_IDS.includes(value as AgentToolCatalogId)
  );
}

export function normalizeAgentToolCatalogIds(
  value: unknown,
  options: { defaultValue?: AgentToolCatalogId[] } = {},
): AgentToolCatalogId[] {
  const defaultValue = options.defaultValue ?? [];
  if (!Array.isArray(value)) {
    return [...defaultValue];
  }

  const seen = new Set<AgentToolCatalogId>();
  for (const item of value) {
    if (isAgentToolCatalogId(item)) {
      seen.add(item);
    }
  }
  return [...seen];
}
