import fc from "fast-check";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { prepareProviderModelRuntime } from "../codex-app-server/provider-model-runtime";
import { CodexModelProviderCatalog } from "../app-server/codex-model-provider-catalog";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";
import { buildCodexClientArgs } from "../app-server/codex-thread-config";

it("uses 65536 context and 49152 compaction on a local provider with no discovery metadata", async () => {
  const runtime = await prepareProviderModelRuntime({ id: "flint", name: "Flint", baseUrl: "http://localhost:8080/v1", models: ["flint"] });
  try {
    expect(runtime.overrides).toContain("model_context_window=65536");
    expect(runtime.overrides).toContain("model_auto_compact_token_limit=49152");
  } finally { await runtime.close(); }
});

it("bounds local execution by the active serving limit and the provider budget, preserving source metadata", async () => {
  await fc.assert(fc.asyncProperty(
    fc.option(fc.integer({ min: 1024, max: 2_000_000 }), { nil: undefined }),
    fc.option(fc.integer({ min: 1024, max: 2_000_000 }), { nil: undefined }),
    async (active, cap) => {
      const provider = { id: "flint", name: "Flint", baseUrl: "http://localhost:8080/v1", models: ["flint"],
        contextWindowCap: cap, modelMetadata: [{ id: "flint", contextWindow: active }] };
      const source = JSON.stringify(provider);
      const budget = Math.min(active ?? Infinity, cap ?? 65536);
      const runtime = await prepareProviderModelRuntime(provider);
      try {
        const file = JSON.parse(runtime.overrides.find((arg) => arg.startsWith("model_catalog_json="))!.split("=").slice(1).join("="));
        const model = JSON.parse(await readFile(file, "utf8")).models[0];
        expect(model).toMatchObject({ context_window: budget, max_context_window: budget, auto_compact_token_limit: Math.floor(budget * 0.75) });
        expect(runtime.overrides).toContain(`model_context_window=${budget}`);
        expect(runtime.overrides).toContain(`model_auto_compact_token_limit=${Math.floor(budget * 0.75)}`);
        expect(JSON.stringify(provider)).toBe(source);
      } finally { await runtime.close(); }
    },
  ), { numRuns: 25, examples: [[262144, undefined], [undefined, undefined], [32768, 65536]] });
});

it("uses current endpoint context for execution even without a saved connection test, retaining verified capabilities", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1024, max: 2_000_000 }), async (contextWindow) => {
    const provider = { id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1", models: ["kimi"],
      modelMetadata: [{ id: "kimi", contextWindow: 272000, supportsSearchTool: true }] };
    const catalog = new CodexModelProviderCatalog({ resolveProviders: () => [provider], resolveKeys: async () => ({}),
      fetch: async () => new Response(JSON.stringify({ data: [{ id: "kimi", context_window: contextWindow }] })) });
    const effective = await catalog.resolveRuntimeProvider(provider);
    expect(effective.modelMetadata).toEqual([{ id: "kimi", contextWindow, supportsSearchTool: true }]);
    const neverTested = await catalog.resolveRuntimeProvider({ ...provider, modelMetadata: undefined });
    expect(neverTested.modelMetadata).toEqual([{ id: "kimi", contextWindow }]);
    expect(provider.modelMetadata[0].contextWindow).toBe(272000);
  }), { numRuns: 25 });
});

it("round trips manual caps without changing discovery metadata or neighboring provider policy", () => {
  fc.assert(fc.property(fc.integer({ min: 1024, max: 2_000_000 }), (contextWindowCap) => {
    const providers = [{ id: "flint", name: "Flint", baseUrl: "http://localhost:8080/v1", contextWindowCap,
      modelMetadata: [{ id: "flint", contextWindow: 262144 }] },
    { id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1" }];
    const source = '# Preserve\n[models.codex]\nprofile = "work"\n';
    const written = applyTomlEdits(source, desktopSettingsPatchToEdits({ models: { codex: { providers } } }, parseTomlTables(source, "test.toml")));
    expect(parseDesktopSettingsToml(written, "test.toml").models?.codex?.providers).toEqual(providers);
    expect(written).toContain("# Preserve");
  }));
});

it("honors MathOS serving capacities per model and overrides inherited limits only inside each provider runtime", async () => {
  // Authenticated GET https://os.openmathmodel.org/v1/models, 2026-11-15:
  // six models advertise 1048576; Inkling 2 Small and Nemotron 3 Super 262144.
  await fc.assert(fc.asyncProperty(fc.option(fc.integer({ min: 1024, max: 2_000_000 }), { nil: undefined }), async (contextWindowCap) => {
    const provider = { id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1", contextWindowCap,
      modelMetadata: [{ id: "large", contextWindow: 1048576 }, { id: "small", contextWindow: 262144 }] };
    const local = await prepareProviderModelRuntime({ id: "flint", name: "Flint", baseUrl: "http://localhost:8080/v1", models: ["flint"] });
    const remote = await prepareProviderModelRuntime(provider);
    try {
      const primaryArgs = buildCodexClientArgs({}, ["model_context_window=8192", "model_auto_compact_token_limit=4096"]);
      const inherited = primaryArgs.filter((_arg, index) => primaryArgs[index - 1] === "-c");
      // Registry wiring appends only this runtime's overrides after shared args.
      const overrides = Object.fromEntries([...inherited, ...remote.overrides]
        .filter((arg) => /^(model_context_window|model_auto_compact_token_limit|model_catalog_json)=/u.test(arg))
        .map((arg) => {
          const index = arg.indexOf("=");
          return [arg.slice(0, index), JSON.parse(arg.slice(index + 1))];
        }));
      const catalog = JSON.parse(await readFile(overrides.model_catalog_json, "utf8"));
      const expected = [1048576, 262144].map((serving) => Math.min(serving, contextWindowCap ?? Infinity));
      // Oracle: Codex models-manager with_config_overrides clamps a process
      // context override to max_context_window. Its auto_compact_token_limit
      // accessor clamps the process compaction override to 90% of that model.
      for (let i = 0; i < catalog.models.length; i += 1) {
        const model = catalog.models[i];
        expect(model.context_window).toBe(expected[i]);
        expect(Math.min(overrides.model_context_window, model.max_context_window)).toBe(expected[i]);
        expect(Math.min(overrides.model_auto_compact_token_limit, Math.floor(expected[i] * 0.9)))
          .toBe(Math.floor(Math.min(...expected) * 0.75));
      }
      expect(remote.overrides[0]).toBe('model_provider="mathos"');
      expect(inherited).toContain("model_context_window=8192");
      expect(inherited).toContain("model_auto_compact_token_limit=4096");
      expect(local.overrides).toContain("model_context_window=65536");
      expect(local.overrides).toContain("model_auto_compact_token_limit=49152");
      expect(remote.overrides.find((arg) => arg.startsWith("model_catalog_json=")))
        .not.toBe(local.overrides.find((arg) => arg.startsWith("model_catalog_json=")));
    } finally { await Promise.all([local.close(), remote.close()]); }
  }), { numRuns: 25, examples: [[undefined], [65536]] });
});

it("does not fetch when discovery is disabled and keeps saved serving limits when discovery fails", async () => {
  let calls = 0;
  const provider = { id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1", models: ["kimi"],
    modelMetadata: [{ id: "kimi", contextWindow: 1048576, supportsSearchTool: true }] };
  const catalog = new CodexModelProviderCatalog({ resolveProviders: () => [provider], resolveKeys: async () => ({}),
    fetch: async () => { calls += 1; throw new Error("Offline"); } });
  expect((await catalog.resolveRuntimeProvider({ ...provider, discoverModels: false })).modelMetadata).toEqual(provider.modelMetadata);
  expect(calls).toBe(0);
  expect((await catalog.resolveRuntimeProvider(provider)).modelMetadata).toEqual(provider.modelMetadata);
  expect(calls).toBe(1);
});

it("keeps the picker and runtime consistent when saved capabilities accompany a stale context observation", async () => {
  const provider = { id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1", models: ["kimi"],
    modelMetadata: [{ id: "kimi", contextWindow: 272000, reasoningEfforts: ["low", "high"], supportsImage: true, supportsSearchTool: true }] };
  const catalog = new CodexModelProviderCatalog({ resolveProviders: () => [provider], resolveKeys: async () => ({}),
    fetch: async () => new Response(JSON.stringify({ data: [{ id: "kimi", context_window: 1048576,
      supported_reasoning_efforts: ["minimal"], input_modalities: ["text"] }] })) });
  const [option] = await catalog.listModelOptions();
  const [runtime] = (await catalog.resolveRuntimeProvider(provider)).modelMetadata!;
  expect(runtime.contextWindow).toBe(1048576);
  expect(option.contextWindow).toBe(runtime.contextWindow);
  expect(option.reasoningEfforts).toEqual(runtime.reasoningEfforts);
  expect(option.supportsImage).toBe(runtime.supportsImage);
  expect(runtime.supportsSearchTool).toBe(true);
});
