import fc from "fast-check";
import { expect, it } from "vitest";
import { parseCodexProviderCatalogModel } from "@pwragent/shared";
import { CodexModelProviderCatalog } from "../app-server/codex-model-provider-catalog";
import { readFile, stat } from "node:fs/promises";
import { prepareProviderModelRuntime } from "../codex-app-server/provider-model-runtime";

it("keeps a provider's declared context window without inventing native discovery support", () => {
  fc.assert(fc.property(fc.integer({ min: 1024, max: 2_000_000 }), (contextWindow) => {
    expect(parseCodexProviderCatalogModel({ id: "kimi", context_length: contextWindow, supports_search_tool: true }))
      .toEqual({ id: "kimi", contextWindow });
  }), { numRuns: 30 });
});

it("keeps configured effort metadata consistent with execution when model-list discovery is off", async () => {
  const provider = { id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1", discoverModels: false, models: ["kimi"],
    modelMetadata: [{ id: "kimi", reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" }, { id: "hidden", reasoningEfforts: ["high"] }] };
  const catalog = new CodexModelProviderCatalog({ resolveProviders: () => [provider], resolveKeys: async () => ({}) });
  const models = await catalog.listModelOptions();
  expect(catalog.knownCatalog().models).toEqual(models);
  expect(models).toEqual([expect.objectContaining({
    id: "@mathos/kimi", reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low", supportsReasoning: true,
  })]);
});

it("materializes metadata per model in a private disposable catalog without disabling integrations", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 1024, max: 2_000_000 }), async (supported, contextWindow) => {
    const runtime = await prepareProviderModelRuntime({ id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1",
      models: ["unknown"], modelMetadata: [{ id: "kimi", contextWindow, supportsSearchTool: supported, supportsImage: true,
        reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" }] });
    const catalogArg = runtime.overrides.find((value) => value.startsWith("model_catalog_json="))!;
    const file = JSON.parse(catalogArg.slice("model_catalog_json=".length)) as string;
    try {
      const catalog = JSON.parse(await readFile(file, "utf8"));
      expect(catalog.models).toEqual([
        expect.objectContaining({ slug: "unknown", supports_search_tool: false }),
        expect.objectContaining({ slug: "kimi", context_window: contextWindow, max_context_window: contextWindow, supports_search_tool: supported,
          input_modalities: ["text", "image"], default_reasoning_level: "low" }),
      ]);
      expect(catalog.models[0].context_window).toBe(272000);
      expect(catalog.models[0].truncation_policy).toEqual({ mode: "bytes", limit: 10000 });
      expect(runtime.overrides).toEqual(['model_provider="mathos"', 'model="unknown"', catalogArg,
        `model_context_window=${Math.max(272000, contextWindow)}`,
        `model_auto_compact_token_limit=${Math.floor(Math.min(272000, contextWindow) * 0.75)}`,
      ]);
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally { await runtime.close(); }
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  }), { numRuns: 20 });
});

it("verifies discovery only after the provider accepts schemas, invokes the selected fixture, and returns its marker", async () => {
  const requests: Record<string, unknown>[] = [];
  let marker: string | undefined;
  const response = (output: unknown[]) => new Response(JSON.stringify({ status: "completed", output }));
  const provider = { id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1", models: ["kimi"] };
  const catalog = new CodexModelProviderCatalog({
    resolveProviders: () => [provider], resolveKeys: async () => ({}),
    fetch: async (url, init) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi", context_window: 262144 }] }));
      const request = JSON.parse(init?.body as string) as Record<string, unknown>;
      requests.push(request);
      if (requests.length === 1) return response([{ type: "message", content: [{ type: "output_text", text: "OK" }] }]);
      if (requests.length === 2) return response([{ type: "tool_search_call", execution: "client", call_id: "search", arguments: { query: "marker" } }]);
      const input = request.input as Array<Record<string, unknown>>;
      if (requests.length === 3) {
        expect(input.some((item) => item.type === "tool_search_output" && item.call_id === "search")).toBe(true);
        return response([{ type: "function_call", namespace: "pwragent_probe", name: "read_marker", call_id: "read", arguments: "{}" }]);
      }
      const output = input.find((item) => item.type === "function_call_output" && item.call_id === "read");
      marker = output?.output as string;
      return response([{ type: "message", content: [{ type: "output_text", text: marker }] }]);
    },
  });
  const result = await catalog.test(provider, "fixture-key");
  expect(result).toMatchObject({ discovery: { ok: true, model: "kimi", requests: 3 } });
  expect(marker).toMatch(/^PWRAGENT_DISCOVERY_/u);
  expect(requests).toHaveLength(4);
});

it("never promotes partial discovery, wrong tool calls, or a fabricated marker to a verified capability", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("no-search", "rejected-result", "wrong-tool", "wrong-arguments", "wrong-marker"), async (failure) => {
    let requests = 0;
    const response = (output: unknown[]) => new Response(JSON.stringify({ status: "completed", output }));
    const catalog = new CodexModelProviderCatalog({ resolveProviders: () => [], resolveKeys: async () => ({}),
      fetch: async (url) => {
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi", supports_search_tool: true }] }));
        requests += 1;
        if (requests === 1 || (requests === 2 && failure === "no-search")) return response([{ type: "message", content: [{ type: "output_text", text: "OK" }] }]);
        if (requests === 2) return response([{ type: "tool_search_call", execution: "client", call_id: "search", arguments: { query: "marker" } }]);
        if (requests === 3) {
          if (failure === "rejected-result") return new Response('{"error":{"message":"fixture-secret rejected"}}', { status: 400 });
          return response([{ type: "function_call", namespace: "pwragent_probe", name: failure === "wrong-tool" ? "other" : "read_marker",
            call_id: "read", arguments: failure === "wrong-arguments" ? '{"extra":1}' : "{}" }]);
        }
        return response([{ type: "message", content: [{ type: "output_text", text: "invented" }] }]);
      },
    });
    const result = await catalog.test({ id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1", models: ["kimi"] }, "fixture-secret");
    expect(result.responses.ok).toBe(true);
    expect(result.discovery?.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(requests).toBeLessThanOrEqual(4);
  }), { numRuns: 20 });
});
