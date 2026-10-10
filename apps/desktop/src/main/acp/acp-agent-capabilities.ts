export type AcpAgentCapabilities = {
  liveWorkspaceHandoff: boolean;
  managedReview: boolean;
  steerTurn: boolean;
};

const DEFAULT_ACP_AGENT_CAPABILITIES: AcpAgentCapabilities = {
  liveWorkspaceHandoff: false,
  managedReview: false,
  steerTurn: false,
};

const ACP_AGENT_CAPABILITY_CATALOG: Record<string, AcpAgentCapabilities> = {
  gemini: {
    liveWorkspaceHandoff: false,
    managedReview: false,
    steerTurn: false,
  },
  kimi: {
    liveWorkspaceHandoff: false,
    managedReview: true,
    steerTurn: false,
  },
  grok: {
    liveWorkspaceHandoff: false,
    managedReview: true,
    steerTurn: false,
  },
  qwen: {
    liveWorkspaceHandoff: false,
    managedReview: false,
    steerTurn: false,
  },
};

export function acpAgentCapabilitiesForRegistryId(
  registryId: string,
): AcpAgentCapabilities {
  return (
    ACP_AGENT_CAPABILITY_CATALOG[registryId] ?? DEFAULT_ACP_AGENT_CAPABILITIES
  );
}

export function isPwrAgentGrokBuildVersion(version: string | undefined): boolean {
  return /^\d+\.\d+\.\d+-pwragent\.\d+(?:[.+-].*)?$/.test(version ?? "");
}
