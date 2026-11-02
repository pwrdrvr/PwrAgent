import { describe, expect, it } from "vitest";
import { splitModelMenuOptions } from "../model-menu-options";

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
});
