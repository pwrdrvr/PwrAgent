type ClaudeAgentSdk = typeof import("@anthropic-ai/claude-agent-sdk");

let loading: Promise<ClaudeAgentSdk> | undefined;

/**
 * Load the Claude Agent SDK on first use. A static import put its cold load
 * (~40 ms) on every headless owner start, including owners that never run a
 * Claude session. A failed load is not cached, so the next call retries.
 */
export function loadClaudeAgentSdk(): Promise<ClaudeAgentSdk> {
  loading ??= import("@anthropic-ai/claude-agent-sdk").catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
