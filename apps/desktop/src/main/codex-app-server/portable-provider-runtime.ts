import { LOCAL_CODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS, type CodexModelProviderSettings } from "@pwragent/shared";
import { Readable } from "node:stream";
import { postUpstream, providerRequestHeaders } from "./local-responses-bridge.mjs";
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
      send: async (body, signal, incomingHeaders) => {
        if (options.maxRequests !== undefined && ++requests > options.maxRequests) throw new Error("Portable discovery request budget exhausted.");
        const url = `${upstream.replace(/\/+$/, "")}/responses`;
        const headers = providerRequestHeaders(incomingHeaders);
        if (apiKey) headers.authorization = `Bearer ${apiKey}`;
        const payload = JSON.stringify(body);
        if (options.fetch) return options.fetch(url, { method: "POST", redirect: "error", headers, body: payload, signal });
        // Node's socket inactivity timer also allows prefills beyond fetch's 300 s header timeout.
        const response = await postUpstream(url, headers, payload, signal, LOCAL_CODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS);
        const status = response.statusCode ?? 502;
        return new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, {
          status,
          headers: { "Content-Type": response.headers["content-type"] ?? "application/json" },
        });
      },
      idleTimeoutMs: LOCAL_CODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS,
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
      ],
      close,
    };
  } catch (error) { await close(); throw error; }
}
