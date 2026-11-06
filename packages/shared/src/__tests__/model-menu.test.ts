import { describe, expect, it } from "vitest";
import { buildModelMenu, splitModelMenuOptions } from "../model-menu";

describe("model menu options", () => {
  it.each(["gpt-6.1-sol", "gpt-6.1-terra"])("moves GPT-6-Sol under Other when %s is available", (id) => {
    const models = [{ id: "gpt-6-sol", current: true }, { id }];
    const result = splitModelMenuOptions("codex", models);
    expect(result.primary).toEqual([models[1]]);
    expect(result.other).toEqual([models[0]]);
    expect(models).toHaveLength(2);
  });

  it("keeps GPT-6-Sol primary when no replacement is offered", () => {
    const models = [{ id: "gpt-6-astra" }, { id: "gpt-6-sol" }, { id: "gpt-6-luna" }, { id: "gpt-5.6-sol" }];
    expect(splitModelMenuOptions("codex", models)).toEqual({ primary: models.slice(0, 3), other: models.slice(3) });
  });

  it("keeps old catalogs and unknown models available", () => {
    const models = [{ id: "gpt-5.6-sol" }, { id: "gpt-5.5" }, { id: "future-model" }];
    expect(splitModelMenuOptions("codex", models)).toEqual({ primary: models, other: [] });
  });

  // Shrunk from the picker properties, which found the review card and the
  // automation editor listing GPT-5.5-Codex beside GPT-6-Astra.
  it("moves a GPT-5.5 variant under Other once a GPT-6 model is offered", () => {
    const models = [{ id: "gpt-6-astra" }, { id: "gpt-5.5-codex" }];
    expect(splitModelMenuOptions("codex", models)).toEqual({ primary: [models[0]], other: [models[1]] });
  });

  it("does not apply Codex grouping to custom providers or ACP models", () => {
    const models = [{ id: "gpt-6.1-terra", providerId: "local" }, { id: "gpt-6-sol", providerId: "local" }];
    expect(splitModelMenuOptions("codex", models)).toEqual({ primary: models, other: [] });
    const acpModels = [{ id: "gpt-6.1-terra" }, { id: "gpt-6-sol" }, { id: "gpt-5.6-sol" }];
    expect(splitModelMenuOptions("acp:test", acpModels)).toEqual({ primary: acpModels, other: [] });
  });

  it("uses the Claude catalog's Other flags", () => {
    const models = [{ id: "opus" }, { id: "old-opus", other: true }];
    expect(splitModelMenuOptions("claude", models)).toEqual({ primary: [models[0]], other: [models[1]] });
  });

  const catalog = [
    { id: "gpt-6-astra" },
    { id: "gpt-6.1-sol" },
    { id: "gpt-6-sol" },
    { id: "gpt-5.6-terra" },
    { id: "@bonsai/ternary", providerId: "bonsai", providerLabel: "PrismML Bonsai" },
    { id: "@llama/qwen", providerId: "llama" },
    { id: "@bonsai/ternary-small", providerId: "bonsai", providerLabel: "PrismML Bonsai" },
  ];

  it("titles each Codex model provider's models in a group of their own", () => {
    expect(buildModelMenu({ kind: "codex", models: catalog })).toEqual({
      primary: [catalog[0], catalog[1]],
      other: [catalog[2], catalog[3]],
      providerGroups: [
        { providerId: "bonsai", label: "PrismML Bonsai", models: [catalog[4], catalog[6]] },
        { providerId: "llama", label: "llama", models: [catalog[5]] },
      ],
    });
  });

  it("offers an existing Codex thread only its own provider's models", () => {
    expect(buildModelMenu({ kind: "codex", models: catalog, thread: { model: "gpt-6.1-sol" } }))
      .toEqual({ primary: [catalog[0], catalog[1]], other: [catalog[2], catalog[3]], providerGroups: [] });
    expect(buildModelMenu({ kind: "codex", models: catalog, thread: { model: "@bonsai/ternary" } }))
      .toEqual({ primary: [catalog[4], catalog[6]], other: [], providerGroups: [] });
  });

  it("keeps every model of providers that fix nothing per thread", () => {
    const models = [{ id: "opus" }, { id: "old-opus", other: true }];
    expect(buildModelMenu({ kind: "claude", models, thread: { model: "opus" } }))
      .toEqual({ primary: [models[0]], other: [models[1]], providerGroups: [] });
  });
});
