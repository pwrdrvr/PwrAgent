import type { ResearchHarnessConfig } from "@pwragent/shared/research-harness";
import type { ResearchModelTransport } from "@pwragent/owner-core/research-model-adapter";

export function selectHarnessModel(config: ResearchHarnessConfig, mode: "import" | "execute") {
  if (mode === "import" || !config.model || !config.endpoint) return undefined;
  const complete = createHarnessModelTransport(config);
  return { model: config.model, endpointOrigin: new URL(config.endpoint).origin, complete };
}

/** Explicit endpoint/model only. Never list models, infer tools, or forward credentials to the process. */
export function createHarnessModelTransport(config: ResearchHarnessConfig): ResearchModelTransport {
  if (!config.endpoint || !config.model) throw new Error("Configure an explicit research model and Chat Completions endpoint before execution");
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))) throw new Error("Research model endpoints require HTTPS or loopback HTTP");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Do not put model credentials in the endpoint URL");
  return async (request, signal) => {
    const key = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
    if (config.apiKeyEnv && !key) throw new Error("Research model credential is unavailable");
    const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(request) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Research model returned HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Research model returned no response body");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 512_000) throw new Error("Research model response exceeds its bound");
        chunks.push(result.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel(); }
  };
}
