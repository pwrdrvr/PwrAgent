import type { AppServerBackendKind } from "@pwragnt/shared";

export function formatBackendLabel(backend: AppServerBackendKind): string {
  return backend === "grok" ? "Grok" : "OpenAI";
}
