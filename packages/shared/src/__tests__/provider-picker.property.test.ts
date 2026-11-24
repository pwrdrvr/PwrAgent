import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatCodexProviderModelId } from "../codex-model-providers";
import type { BackendModelOption, CodexModelProviderCatalogState } from "../contracts/backend";
import {
  buildProviderPickerEntries,
  codexModelProviderCatalogNote,
  codexModelProviderOffline,
  describeCodexModelProviderEntry,
  findCodexModelProviderLabel,
  parseProviderPickerValue,
  partitionProviderPickerEntries,
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
/** Reads whose endpoint never answered: a local model server that is stopped. */
const UNREACHABLE_ERRORS = [
  "fetch failed",
  "The endpoint did not answer within 8 seconds.",
  "connect ECONNREFUSED 127.0.0.1:8080",
  "getaddrinfo ENOTFOUND flint.local",
];
/** Reads the endpoint answered with an error: a misconfigured provider. */
const ANSWERED_ERRORS = ["HTTP 401", "HTTP 503: model is loading", "The response was larger than 8 MiB."];

const provider = fc.record({
  id: fc.constantFrom(...PROVIDER_IDS),
  name: fc.constantFrom(...NAMES),
  models: fc.uniqueArray(fc.constantFrom(...UPSTREAM_IDS), { maxLength: UPSTREAM_IDS.length }),
  status: fc.constantFrom<CodexModelProviderCatalogState["status"]>("ready", "unavailable", "off", "pending"),
  error: fc.constantFrom(...UNREACHABLE_ERRORS, ...ANSWERED_ERRORS),
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
    ...(entry.status === "unavailable" ? { error: entry.error } : {}),
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

describe("an offline provider", () => {
  /**
   * The rule: a provider whose endpoint did not answer is offline, the
   * ordinary state of a local model server that is not started. Its picker
   * row reads "offline" in the same shape whether or not it lists models,
   * and never quotes the error; the error moves to the tooltip. An endpoint
   * that answered with an error is misconfigured and keeps its reason.
   */
  it("reads offline in one shape, and keeps an answered error's reason", () => {
    fc.assert(fc.property(owner, (input) => {
      const entries = buildProviderPickerEntries(toBackends(input));
      for (const registered of input.providers) {
        if (!registered.reportsState || registered.status !== "unavailable") continue;
        const entry = entries.find((candidate) => candidate.codexModelProviderId === registered.id)!;
        const described = describeCodexModelProviderEntry(entry);
        const note = codexModelProviderCatalogNote(entry.catalog);
        const count = registered.models.length;
        const offline = UNREACHABLE_ERRORS.includes(registered.error);
        expect(codexModelProviderOffline(entry.catalog)).toBe(offline);
        expect(described.disabled).toBe(count === 0);
        if (offline) {
          expect(described.description).toBe(count === 0
            ? "Runs on Codex · offline"
            : `Runs on Codex · ${count} ${count === 1 ? "model" : "models"} · offline`);
          expect(described.tooltip).toContain(registered.error.replace(/\.$/u, ""));
          expect(note).toBe(`${registered.name} is offline. Showing the models listed in Settings.`);
        } else {
          expect(described.description).toContain(count === 0 ? registered.error : "catalog unavailable");
          expect(described.tooltip).toBeUndefined();
          expect(note).toContain(registered.error);
        }
      }
    }));
  });
});

describe("the Unavailable submenu", () => {
  /**
   * The rule: the main list holds what can be used now. A Codex model
   * provider whose last catalog read failed, or that offers no model, moves
   * to the submenu. Every entry still appears exactly once, each side keeps
   * the picker's order, and a backend never moves.
   */
  it("moves each unusable provider down one level, and nothing else", () => {
    fc.assert(fc.property(owner, (input) => {
      const entries = buildProviderPickerEntries(toBackends(input));
      const { available, unavailable } = partitionProviderPickerEntries(entries);
      expect([...available, ...unavailable].sort((a, b) => a.value.localeCompare(b.value)))
        .toEqual([...entries].sort((a, b) => a.value.localeCompare(b.value)));
      expect(available).toEqual(entries.filter((entry) => available.includes(entry)));
      expect(unavailable).toEqual(entries.filter((entry) => unavailable.includes(entry)));
      for (const entry of entries) {
        const registered = input.providers.find((candidate) => candidate.id === entry.codexModelProviderId);
        const unusable = Boolean(registered)
          && ((registered!.reportsState && registered!.status === "unavailable") || entry.models.length === 0);
        expect(unavailable.includes(entry)).toBe(unusable);
      }
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

  it("reads two stopped local servers the same, listed model or not", () => {
    const entries = buildProviderPickerEntries([{
      kind: "codex",
      launchpadOptions: {
        models: [{ id: "@bonsai/bonsai-27b", providerId: "bonsai", providerLabel: "Bonsai (local)" }],
      },
      codexModelProviders: [
        { id: "bonsai", name: "Bonsai (local)", status: "unavailable", listedCount: 1, error: "fetch failed" },
        { id: "flint", name: "Flint", status: "unavailable", listedCount: 0, error: "fetch failed" },
      ],
    }]);
    expect(entries.slice(1).map(describeCodexModelProviderEntry)).toEqual([
      {
        description: "Runs on Codex · 1 model · offline",
        disabled: false,
        tooltip: "Bonsai (local) did not answer (fetch failed). Its models listed in Settings are still offered.",
      },
      {
        description: "Runs on Codex · offline",
        disabled: true,
        tooltip: "Flint did not answer (fetch failed). Start it, or list a model in Settings.",
      },
    ]);
    expect(codexModelProviderCatalogNote(entries[1].catalog))
      .toBe("Bonsai (local) is offline. Showing the models listed in Settings.");
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
