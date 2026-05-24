export type AcpAgentCapabilities = {
  liveWorkspaceHandoff: boolean;
};

const DEFAULT_ACP_AGENT_CAPABILITIES: AcpAgentCapabilities = {
  liveWorkspaceHandoff: false,
};

const ACP_AGENT_CAPABILITY_CATALOG: Record<string, AcpAgentCapabilities> = {
  gemini: {
    liveWorkspaceHandoff: false,
  },
  kimi: {
    liveWorkspaceHandoff: false,
  },
};

export function acpAgentCapabilitiesForRegistryId(
  registryId: string,
): AcpAgentCapabilities {
  return (
    ACP_AGENT_CAPABILITY_CATALOG[registryId] ?? DEFAULT_ACP_AGENT_CAPABILITIES
  );
}
