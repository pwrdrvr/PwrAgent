export const PWRAGENT_TOOL_NAMESPACE = "pwragent";

export const AGENT_TOOL_CATALOG_IDS = [
  "automation_inspection",
  "app_management",
  "thread_inspection",
  "messaging_context",
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
