import type { AppServerBackendKind } from "@pwragent/shared";

export function formatBackendLabel(backend: AppServerBackendKind): string {
  return backend === "grok" ? "Grok" : "OpenAI";
}
