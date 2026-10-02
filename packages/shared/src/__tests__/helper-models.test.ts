import { describe, expect, it } from "vitest";
import {
  HELPER_MODEL_DEFINITIONS,
  HELPER_MODEL_GROUPS,
  HELPER_MODEL_IDS,
  helperChoiceBackend,
  resolveHelperModel,
  type HelperModelCatalogEntry,
} from "../helper-models";

const EFFORTS = ["low", "medium", "high"];
const catalog = (...ids: string[]): HelperModelCatalogEntry[] =>
  ids.map((id) => ({ id, reasoningEfforts: EFFORTS }));

describe("resolveHelperModel", () => {
  it("picks GPT-6-Luna automatically, then GPT-5.6-Luna", () => {
    expect(resolveHelperModel({
      helper: "thread_titles",
      models: catalog("gpt-5.5", "gpt-5.6-luna", "gpt-6-luna"),
    })).toEqual({
      model: "gpt-6-luna",
      reasoningEffort: "low",
      source: "automatic",
      verified: true,
    });
    expect(resolveHelperModel({
      helper: "task_monitors",
      models: catalog("gpt-5.5", "gpt-5.6-luna"),
    })).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      source: "automatic",
    });
  });

  it("prefers a mini model, then the current model, when no Luna is offered", () => {
    expect(resolveHelperModel({
      helper: "thread_titles",
      models: catalog("gpt-5.5", "gpt-5.4-mini"),
    })).toMatchObject({ model: "gpt-5.4-mini", source: "automatic" });
    expect(resolveHelperModel({
      helper: "thread_titles",
      models: [
        { id: "gpt-5.5", reasoningEfforts: EFFORTS },
        { id: "gpt-6", current: true, reasoningEfforts: EFFORTS },
      ],
    })).toMatchObject({ model: "gpt-6", source: "backend_current" });
  });

  it("orders request, row, Helper default, then Automatic", () => {
    const settings = {
      defaultModel: "gpt-5.5",
      helpers: { diff_condensation: { model: "gpt-5.6-luna" } },
    };
    const models = catalog("gpt-6-luna", "gpt-5.6-luna", "gpt-5.5", "gpt-6");
    expect(resolveHelperModel({
      helper: "diff_condensation",
      settings,
      models,
      requestedModel: "gpt-6",
    })).toMatchObject({ model: "gpt-6", source: "requested" });
    expect(resolveHelperModel({ helper: "diff_condensation", settings, models }))
      .toMatchObject({ model: "gpt-5.6-luna", source: "helper" });
    expect(resolveHelperModel({ helper: "thread_titles", settings, models }))
      .toMatchObject({ model: "gpt-5.5", source: "helper_default" });
  });

  it("keeps a saved model that is not offered and runs the next rung", () => {
    const resolution = resolveHelperModel({
      helper: "thread_titles",
      settings: {
        defaultModel: "gpt-6.1-luna",
        helpers: { thread_titles: { model: "gpt-5.6-luna-preview" } },
      },
      models: catalog("gpt-6-luna"),
    });
    expect(resolution).toEqual({
      model: "gpt-6-luna",
      reasoningEffort: "low",
      source: "automatic",
      verified: true,
      unavailableHelperModel: "gpt-5.6-luna-preview",
      unavailableDefaultModel: "gpt-6.1-luna",
    });
  });

  it("resolves effort from the row, then the helper default, within the model's efforts", () => {
    const models: HelperModelCatalogEntry[] = [
      { id: "gpt-6-luna", reasoningEfforts: ["medium", "high"], defaultReasoningEffort: "high" },
    ];
    expect(resolveHelperModel({
      helper: "thread_titles",
      settings: { helpers: { thread_titles: { reasoningEffort: "high" } } },
      models,
    })).toMatchObject({ reasoningEffort: "high" });
    // "low" is the title default but this model does not offer it.
    expect(resolveHelperModel({ helper: "thread_titles", models }))
      .toMatchObject({ reasoningEffort: "high" });
    expect(resolveHelperModel({
      helper: "thread_titles",
      models: [{ id: "gpt-6-luna", supportsReasoning: false }],
    })).toMatchObject({ model: "gpt-6-luna", reasoningEffort: undefined });
  });

  it("returns the first configured rung unverified before the catalog is read", () => {
    expect(resolveHelperModel({
      helper: "thread_titles",
      settings: { helpers: { thread_titles: { model: "gpt-5.5" } } },
      models: [],
    })).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "low",
      source: "helper",
      verified: false,
    });
  });

  it("invents no model when a completed read offered none", () => {
    expect(resolveHelperModel({
      helper: "thread_titles",
      models: [],
      catalogRead: true,
    })).toEqual({ source: "backend_current", verified: true });
  });

  it("applies Codex defaults only to Codex, and a row only to its own backend", () => {
    const settings = {
      defaultModel: "gpt-5.5",
      helpers: { usage_analysis: { backend: "acp:grok", model: "grok-fast" } },
    };
    expect(helperChoiceBackend("usage_analysis", settings.helpers.usage_analysis))
      .toBe("acp:grok");
    expect(resolveHelperModel({
      helper: "usage_analysis",
      settings,
      backend: "acp:grok",
      models: [{ id: "grok" }, { id: "grok-fast" }],
    })).toMatchObject({ model: "grok-fast", source: "helper" });
    expect(resolveHelperModel({
      helper: "usage_analysis",
      settings,
      backend: "codex",
      models: catalog("gpt-5.5", "gpt-6-luna"),
    })).toMatchObject({ model: "gpt-5.5", source: "helper_default" });
    // A row naming a backend the helper cannot use falls back to its first.
    expect(helperChoiceBackend("thread_titles", { backend: "acp:grok" })).toBe("codex");
  });
});

describe("helper model catalog", () => {
  it("defines every helper once, in a known group", () => {
    expect(HELPER_MODEL_DEFINITIONS.map((definition) => definition.id))
      .toEqual([...HELPER_MODEL_IDS]);
    const groups = new Set(HELPER_MODEL_GROUPS.map((group) => group.id));
    for (const definition of HELPER_MODEL_DEFINITIONS) {
      expect(groups.has(definition.group)).toBe(true);
      expect(definition.backends[0]).toBe("codex");
    }
  });
});
