import type { AppServerBackendKind, BackendSummary } from "@pwragent/shared";

export function formatBackendLabel(
  backend: AppServerBackendKind,
  summaries: BackendSummary[] = [],
): string {
  const summary = summaries.find((candidate) => candidate.kind === backend);
  if (summary?.label) {
    return summary.label;
  }
  if (backend === "codex") {
    return "OpenAI";
  }
  if (backend === "grok") {
    return "Grok";
  }
  if (backend.startsWith("acp:")) {
    const registryId = backend.slice("acp:".length);
    if (registryId === "gemini") {
      return "Gemini";
    }
    if (registryId === "kimi") {
      return "Kimi";
    }
    return registryId;
  }
  return backend;
}
