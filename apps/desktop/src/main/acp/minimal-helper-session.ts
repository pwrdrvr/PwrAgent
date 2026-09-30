export type MinimalGrokHelperSessionPolicy = {
  mcpServers: "none";
  reasoningEffort: "low";
  sessionMeta: Record<string, unknown>;
};

/**
 * Grok's extension that forgets a closed session. After `session/close`
 * Grok still lists the session and keeps its history on disk; after this it
 * does neither. Captured against Grok 1.0.44.
 */
export const GROK_DISCARD_SESSION_METHOD = "_x.ai/session/delete";

// A Grok agent profile with no tools at all. Captured against Grok 1.0.44:
// - `tools: []` is no restriction; the session gets the default 17 tools.
// - An allowlist naming no real tool also falls back to the full set, so it
//   names one and `disallowedTools` removes it.
// - `search_tool` and `use_tool` are the MCP meta-tools. They survive any
//   allowlist and `mcpInheritance: "none"`, and reach the MCP servers in the
//   operator's own Grok config, which Grok starts even when `session/new`
//   passes none.
// - Read-only tools run without a permission request in every mode,
//   including `dontAsk`, so denying requests cannot stand in for this.
const NO_TOOLS = {
  tools: ["read_file"],
  disallowedTools: ["read_file", "search_tool", "use_tool"],
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
        ...NO_TOOLS,
      },
      systemPromptOverride: params.systemPrompt,
    },
  };
}
