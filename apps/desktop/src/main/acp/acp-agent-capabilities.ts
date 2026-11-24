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
  antigravity: {
    conversationRewind: false,
    liveWorkspaceHandoff: false,
    managedReview: true,
    steerTurn: false,
  },
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

const ANTIGRAVITY_PROMPT_STEERING_MIN_VERSION = [1, 5, 0] as const;

/**
 * Antigravity (`agy acp`) 1.5.0+ steers a running turn via a concurrent
 * `session/prompt`; 1.4.x queues concurrent prompts instead.
 */
export function isAntigravitySteerableVersion(
  version: string | undefined,
): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? "");
  if (!match) return false;
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let index = 0; index < ANTIGRAVITY_PROMPT_STEERING_MIN_VERSION.length; index += 1) {
    const diff = parsed[index]! - ANTIGRAVITY_PROMPT_STEERING_MIN_VERSION[index]!;
    if (diff !== 0) return diff > 0;
  }
  return true;
}

export function isPwrAgentGrokBuildVersion(version: string | undefined): boolean {
  return /^\d+\.\d+\.\d+-pwragent\.\d+(?:[.+-].*)?$/.test(version ?? "");
}
