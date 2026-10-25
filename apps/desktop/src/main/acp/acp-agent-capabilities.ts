export type AcpAgentCapabilities = {
  /** Grok's `_x.ai/rewind` extension: conversation only, no undo. */
  conversationRewind: boolean;
  liveWorkspaceHandoff: boolean;
  managedReview: boolean;
  steerTurn: boolean;
};

const DEFAULT_ACP_AGENT_CAPABILITIES: AcpAgentCapabilities = {
  conversationRewind: false,
  liveWorkspaceHandoff: false,
  managedReview: false,
  steerTurn: false,
};

const ACP_AGENT_CAPABILITY_CATALOG: Record<string, AcpAgentCapabilities> = {
  gemini: {
    conversationRewind: false,
    liveWorkspaceHandoff: false,
    managedReview: false,
    steerTurn: false,
  },
  kimi: {
    conversationRewind: false,
    liveWorkspaceHandoff: false,
    managedReview: true,
    steerTurn: false,
  },
  grok: {
    conversationRewind: true,
    liveWorkspaceHandoff: false,
    managedReview: true,
    steerTurn: false,
  },
  qwen: {
    conversationRewind: false,
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
