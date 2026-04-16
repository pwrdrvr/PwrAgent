import type {
  AccountSummary,
  ExperimentalFeatureSummary,
  McpServerSummary,
  ModelSummary,
  RateLimitSummary,
  SkillSummary,
} from "./protocol.js";

const DEFAULT_MODELS: ModelSummary[] = [
  {
    id: "grok-4.20-reasoning",
    label: "Grok 4.20 Reasoning",
    description: "Default Grok reasoning model for the app-server provider.",
    current: true,
    supportsReasoning: true,
    supportsFast: false,
    provider: "xai",
  },
  {
    id: "grok-4.20-fast",
    label: "Grok 4.20 Fast",
    description: "Lower-latency Grok model for shorter turns.",
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
