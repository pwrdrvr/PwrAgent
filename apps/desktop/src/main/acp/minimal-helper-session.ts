export type MinimalGrokHelperSessionPolicy = {
  mcpServers: "none";
  reasoningEffort: "low";
  sessionMeta: Record<string, unknown>;
};

export function buildMinimalGrokHelperSessionPolicy(params: {
  description: string;
  name: string;
  systemPrompt: string;
}): MinimalGrokHelperSessionPolicy {
  return {
    mcpServers: "none",
    reasoningEffort: "low",
    sessionMeta: {
      agentProfile: {
        agentsMd: false,
        description: params.description,
        discoverSkills: false,
        inheritSkills: false,
        injectDefaultTools: false,
        mcpInheritance: "none",
        name: params.name,
        permissionMode: "dontAsk",
        skills: [],
        tools: ["read_file"],
      },
      systemPromptOverride: params.systemPrompt,
    },
  };
}
