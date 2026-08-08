export type AcpAgentCapabilities = {
  liveWorkspaceHandoff: boolean;
  managedReview: boolean;
};

const DEFAULT_ACP_AGENT_CAPABILITIES: AcpAgentCapabilities = {
  liveWorkspaceHandoff: false,
  managedReview: false,
};

const ACP_AGENT_CAPABILITY_CATALOG: Record<string, AcpAgentCapabilities> = {
  gemini: {
    liveWorkspaceHandoff: false,
    managedReview: false,
  },
  kimi: {
    liveWorkspaceHandoff: false,
    managedReview: true,
  },
  grok: {
    liveWorkspaceHandoff: false,
    managedReview: true,
  },
  qwen: {
    liveWorkspaceHandoff: false,
    managedReview: false,
  },
};

export function acpAgentCapabilitiesForRegistryId(
  registryId: string,
): AcpAgentCapabilities {
  return (
    ACP_AGENT_CAPABILITY_CATALOG[registryId] ?? DEFAULT_ACP_AGENT_CAPABILITIES
  );
}
