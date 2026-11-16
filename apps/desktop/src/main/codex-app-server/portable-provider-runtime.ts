import { LOCAL_CODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS, type CodexModelProviderSettings } from "@pwragent/shared";
import { prepareBonsaiRuntime } from "./bonsai-runtime";
import { prepareProviderModelRuntime } from "./provider-model-runtime";
import { startPortableCodeModeTransport, type PortableDiagnostic } from "./portable-code-mode-transport.mjs";

/** Called by the owning instance with its scoped provider credential. */
export async function preparePortableProviderRuntime(
  provider: CodexModelProviderSettings,
  apiKey?: string,
  options: {
    fetch?: typeof fetch;
    onDiagnostic?: (event: PortableDiagnostic) => void;
    maxRequests?: number;
  } = {},
): Promise<{ overrides: string[]; baseUrl: string; close: () => Promise<void> }> {
  const base = provider.compatibility === "bonsai"
    ? await prepareBonsaiRuntime(provider, apiKey)
    : await prepareProviderModelRuntime(provider);
  let transport: Awaited<ReturnType<typeof startPortableCodeModeTransport>> | undefined;
  const close = async () => {
    try {
      if (transport) {
        const current = transport;
        transport = undefined;
        current.closeAllConnections();
        await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
      }
    } finally { await base.close(); }
  };
  try {
    let requests = 0;
    const upstream = "baseUrl" in base && typeof base.baseUrl === "string" ? base.baseUrl : provider.baseUrl;
    transport = await startPortableCodeModeTransport({
      send: (body, signal) => {
        if (options.maxRequests !== undefined && ++requests > options.maxRequests) throw new Error("Portable discovery request budget exhausted.");
        return (options.fetch ?? fetch)(`${upstream.replace(/\/+$/, "")}/responses`, {
          method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", ...(apiKey && provider.compatibility !== "bonsai" ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(LOCAL_CODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS)]),
        });
      },
      onDiagnostic: options.onDiagnostic,
      clientApiKey: apiKey,
      requireNestedDiscovery: true,
    });
    const address = transport.address();
    if (!address || typeof address === "string") throw new Error("Portable discovery has no local transport address.");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    return {
      baseUrl,
      overrides: [...base.overrides,
        `model_providers.${provider.id}.base_url=${JSON.stringify(baseUrl)}`,
        `model_providers.${provider.id}.supports_websockets=false`,
        "features.code_mode=true", "features.code_mode_only=true", "features.code_mode_tool_search=true",
        'web_search="disabled"',
        'web_search="disabled"',
      ],
      close,
    };
  } catch (error) { await close(); throw error; }
}
