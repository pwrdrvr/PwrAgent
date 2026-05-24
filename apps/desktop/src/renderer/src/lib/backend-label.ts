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
    return registryId;
  }
  return backend;
}
