import type { AppServerBackendKind, BackendSummary } from "@pwragent/shared";

export function formatBackendLabel(
  backend: AppServerBackendKind,
  summaries: BackendSummary[] = [],
): string {
  if (backend === "acp:gemini") {
    return "Gemini";
  }
  if (backend === "acp:kimi") {
    return "Kimi";
  }
  // The "Grok" chip is reserved for the Grok CLI ACP backend. The
  // legacy direct-xAI agent-core backend is rendered as
  // "AgentCore - Grok" in its own branch below — see
  // `feat(desktop): add Grok CLI ACP backend` (PR #579) and
  // backend-registry.ts:disabledAgentCoreGrokSummary for the
  // experimental-flag policy.
  if (backend === "acp:grok") {
    return "Grok";
  }
  const summary = summaries.find((candidate) => candidate.kind === backend);
  if (summary?.label) {
    return summary.label;
  }
  if (backend === "codex") {
    return "OpenAI";
  }
  if (backend === "grok") {
    return "AgentCore - Grok";
  }
  if (backend.startsWith("acp:")) {
    const registryId = backend.slice("acp:".length);
    return registryId;
  }
  return backend;
}
