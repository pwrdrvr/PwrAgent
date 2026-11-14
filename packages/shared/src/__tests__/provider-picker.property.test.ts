import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatCodexProviderModelId } from "../codex-model-providers";
import type { BackendModelOption, CodexModelProviderCatalogState } from "../contracts/backend";
import {
  buildProviderPickerEntries,
  codexModelProviderCatalogNote,
  describeCodexModelProviderEntry,
  findCodexModelProviderLabel,
  parseProviderPickerValue,
  providerPickerValue,
  type ProviderPickerBackend,
} from "../provider-picker";

/**
 * The model: an owner has Codex's own catalog plus N registered Codex model
 * providers, several of which serve the same upstream model ids. The rule
 * the picker must keep:
 *
 * - every catalog model is offered by exactly one entry, the entry of the
 *   provider that serves it, never merged with a same-named model elsewhere;
 * - a provider's entry carries the operator's name for it;
 * - a provider that offers no model still has an entry, and that entry
 *   cannot be chosen;
 * - the value a thread's backend and model map to names that same entry.
 */
const UPSTREAM_IDS = ["gpt-oss-120b", "qwen3-coder", "deepseek-v4.1", "mathos-coder-large", "gpt-6-sol"];
const PROVIDER_IDS = ["mathos", "refuseless", "openrouter", "acme"];
const NAMES = ["MathOS", "Refuseless", "OpenRouter", "Acme Lab", "OpenAI-compatible box"];

const provider = fc.record({
  id: fc.constantFrom(...PROVIDER_IDS),
  name: fc.constantFrom(...NAMES),
  models: fc.uniqueArray(fc.constantFrom(...UPSTREAM_IDS), { maxLength: UPSTREAM_IDS.length }),
  status: fc.constantFrom<CodexModelProviderCatalogState["status"]>("ready", "unavailable", "off", "pending"),
  reportsState: fc.boolean(),
});

const owner = fc.record({
  codexModels: fc.uniqueArray(fc.constantFrom(...UPSTREAM_IDS), { maxLength: UPSTREAM_IDS.length }),
  providers: fc.uniqueArray(provider, { selector: (entry) => entry.id, maxLength: PROVIDER_IDS.length }),
  others: fc.subarray(["claude", "acp:gemini"] as const),
});

type Owner = typeof owner extends fc.Arbitrary<infer T> ? T : never;

function toBackends(input: Owner): ProviderPickerBackend[] {
  const models: BackendModelOption[] = [
    ...input.codexModels.map((id) => ({ id, label: id })),
    ...input.providers.flatMap((entry) => entry.models.map((model) => ({
      id: formatCodexProviderModelId(entry.id, model),
      label: model,
      providerId: entry.id,
      providerLabel: entry.name,
    }))),
  ];
  const states = input.providers.filter((entry) => entry.reportsState).map((entry) => ({
    id: entry.id,
    name: entry.name,
    status: entry.status,
    listedCount: entry.models.length,
    ...(entry.status === "unavailable" ? { error: "HTTP 401" } : {}),
  }));
  return [
    { kind: "codex", launchpadOptions: { models }, ...(states.length ? { codexModelProviders: states } : {}) },
    ...input.others.map((kind) => ({ kind, launchpadOptions: { models: [{ id: `${kind}-model` }] } })),
  ];
}

describe("provider picker", () => {
  it("offers every model from exactly its own provider's entry", () => {
    fc.assert(fc.property(owner, (input) => {
      const backends = toBackends(input);
      const entries = buildProviderPickerEntries(backends);
      const offered = entries.flatMap((entry) => entry.models.map((model) => ({ entry, model })));
      const catalog = backends.flatMap((backend) => backend.launchpadOptions?.models ?? []);
      // Exactly once each, and nothing invented.
      expect(offered.map(({ model }) => model.id).sort()).toEqual(catalog.map((model) => model.id).sort());
      for (const { entry, model } of offered) {
        expect(entry.codexModelProviderId).toBe(model.providerId);
        expect(entry.value).toBe(providerPickerValue(entry.backend, model.id));
        expect(parseProviderPickerValue(entry.value)).toEqual({
          backend: entry.backend,
          ...(entry.codexModelProviderId ? { codexModelProviderId: entry.codexModelProviderId } : {}),
        });
      }
    }));
  });

  it("names each provider the way the operator did and keeps one that offers nothing", () => {
    fc.assert(fc.property(owner, (input) => {
      const backends = toBackends(input);
      const entries = buildProviderPickerEntries(backends);
      for (const registered of input.providers) {
        const entry = entries.find((candidate) => candidate.codexModelProviderId === registered.id);
        const visible = registered.reportsState || registered.models.length > 0;
        if (!visible) {
          expect(entry).toBeUndefined();
          continue;
        }
        expect(entry?.label).toBe(registered.name);
        expect(entry?.backend).toBe("codex");
        expect(findCodexModelProviderLabel(backends, registered.id)).toBe(registered.name);
        expect(describeCodexModelProviderEntry(entry!).disabled).toBe(registered.models.length === 0);
      }
      // Codex's own entry is still there, and still offers only its own models.
      const codex = entries.find((entry) => entry.value === "codex");
      expect(codex?.models.map((model) => model.id)).toEqual(input.codexModels);
    }));
  });
});

describe("provider picker examples", () => {
  const backends: ProviderPickerBackend[] = [{
    kind: "codex",
    launchpadOptions: {
      models: [
        { id: "gpt-oss-120b" },
        { id: "@mathos/gpt-oss-120b", providerId: "mathos", providerLabel: "MathOS" },
        { id: "@refuseless/gpt-oss-120b", providerId: "refuseless", providerLabel: "Refuseless" },
      ],
    },
    codexModelProviders: [
      { id: "mathos", name: "MathOS", status: "ready", listedCount: 0, discoveredCount: 1 },
      { id: "refuseless", name: "Refuseless", status: "unavailable", listedCount: 1, error: "HTTP 503" },
      { id: "acme", name: "Acme Lab", status: "unavailable", listedCount: 0, error: "HTTP 401" },
    ],
  }];

  it("keeps one model id served by three providers as three choices", () => {
    const entries = buildProviderPickerEntries(backends);
    expect(entries.map((entry) => [entry.value, entry.label, entry.models.map((model) => model.id)])).toEqual([
      ["codex", undefined, ["gpt-oss-120b"]],
      ["codex-provider:mathos", "MathOS", ["@mathos/gpt-oss-120b"]],
      ["codex-provider:refuseless", "Refuseless", ["@refuseless/gpt-oss-120b"]],
      ["codex-provider:acme", "Acme Lab", []],
    ]);
  });

  it("says why a provider offers less than its catalog", () => {
    const entries = buildProviderPickerEntries(backends);
    expect(entries.slice(1).map(describeCodexModelProviderEntry)).toEqual([
      { description: "Runs on Codex · 1 model", disabled: false },
      { description: "Runs on Codex · 1 model · catalog unavailable", disabled: false },
      { description: "No models. Catalog unavailable: HTTP 401", disabled: true },
    ]);
    expect(codexModelProviderCatalogNote(entries[2].catalog))
      .toBe("Catalog unavailable: HTTP 503. Showing the models listed in Settings.");
    expect(codexModelProviderCatalogNote({
      id: "mathos", name: "MathOS", status: "ready", listedCount: 0, discoveredCount: 2000, truncated: true,
    })).toBe("MathOS lists more models than PwrAgent loads. Showing the first 2,000 models.");
  });

  it("files a qualified id reported without providerId under its own provider", () => {
    const entries = buildProviderPickerEntries([{
      kind: "codex",
      launchpadOptions: { models: [{ id: "gpt-6-sol" }, { id: "@mathos/gpt-oss-120b" }] },
    }]);
    expect(entries.map((entry) => [entry.value, entry.models.map((model) => model.id)])).toEqual([
      ["codex", ["gpt-6-sol"]],
      ["codex-provider:mathos", ["@mathos/gpt-oss-120b"]],
    ]);
  });

  it("maps a provider thread back to its provider's entry, and an OpenAI thread to Codex", () => {
    expect(providerPickerValue("codex", "@mathos/gpt-oss-120b")).toBe("codex-provider:mathos");
    expect(providerPickerValue("codex", "gpt-oss-120b")).toBe("codex");
    expect(providerPickerValue("claude", "@mathos/x")).toBe("claude");
  });
});
