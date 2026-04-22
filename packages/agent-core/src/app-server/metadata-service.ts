import type {
  AccountSummary,
  ExperimentalFeatureSummary,
  McpServerSummary,
  ModelSummary,
  RateLimitSummary,
  SkillSummary,
} from "./internal-contract.js";

const DEFAULT_MODELS: ModelSummary[] = [
  {
    id: "grok-4.20-reasoning",
    label: "Grok 4.20 Reasoning",
    description: "Default Grok 4.20 reasoning model for higher-accuracy turns.",
    current: true,
    supportsReasoning: false,
    supportsFast: false,
    provider: "xai",
  },
  {
    id: "grok-4.20-non-reasoning",
    label: "Grok 4.20 Non-Reasoning",
    description: "Grok 4.20 model for lower-latency direct responses.",
    current: false,
    supportsReasoning: false,
    supportsFast: false,
    provider: "xai",
  },
  {
    id: "grok-4-1-fast-reasoning",
    label: "Grok 4.1 Fast Reasoning",
    description: "Fast Grok 4.1 model for tool-heavy reasoning turns.",
    current: false,
    supportsReasoning: false,
    supportsFast: true,
    provider: "xai",
  },
  {
    id: "grok-4-1-fast-non-reasoning",
    label: "Grok 4.1 Fast Non-Reasoning",
    description: "Fast Grok 4.1 model for low-latency direct responses.",
    current: false,
    supportsReasoning: false,
    supportsFast: true,
    provider: "xai",
  },
  {
    id: "grok-4-fast-reasoning",
    label: "Grok 4 Fast Reasoning",
    description: "Grok 4 Fast reasoning model.",
    current: false,
    supportsReasoning: false,
    supportsFast: true,
    provider: "xai",
  },
  {
    id: "grok-4-fast-non-reasoning",
    label: "Grok 4 Fast Non-Reasoning",
    description: "Grok 4 Fast non-reasoning model.",
    current: false,
    supportsReasoning: false,
    supportsFast: true,
    provider: "xai",
  },
];

const DEFAULT_EXPERIMENTAL_FEATURES: ExperimentalFeatureSummary[] = [
  {
    name: "grok-responses",
    stage: "beta",
    displayName: "Grok Responses",
    description: "Routes Codex-style turns through the xAI Responses API.",
    enabled: true,
    defaultEnabled: true,
  },
];

const DEFAULT_ACCOUNT: AccountSummary = {
  account: {
    type: "apiKey",
    planType: "local-dev",
  },
  requiresOpenaiAuth: false,
};

export class AppServerMetadataService {
  listModels(): { data: ModelSummary[] } {
    return {
      data: DEFAULT_MODELS.map((model) => ({ ...model })),
    };
  }

  listSkills(params?: { cwd?: string; cwds?: string[] }): { data: Array<{ cwd?: string; skills: SkillSummary[] }> } {
    const cwds = normalizeCwds(params);
    if (cwds.length === 0) {
      return { data: [] };
    }
    return {
      data: cwds.map((cwd) => ({ cwd, skills: [] })),
    };
  }

  listExperimentalFeatures(): { data: ExperimentalFeatureSummary[] } {
    return {
      data: DEFAULT_EXPERIMENTAL_FEATURES.map((feature) => ({ ...feature })),
    };
  }

  listMcpServerStatus(): { data: McpServerSummary[] } {
    return { data: [] };
  }

  readRateLimits(): { data: RateLimitSummary[] } {
    return { data: [] };
  }

  readAccount(): AccountSummary {
    return {
      account: { ...DEFAULT_ACCOUNT.account },
      requiresOpenaiAuth: DEFAULT_ACCOUNT.requiresOpenaiAuth,
    };
  }
}

function normalizeCwds(params?: { cwd?: string; cwds?: string[] }): string[] {
  const values = [
    ...(Array.isArray(params?.cwds) ? params.cwds : []),
    params?.cwd,
  ];
  return values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}
