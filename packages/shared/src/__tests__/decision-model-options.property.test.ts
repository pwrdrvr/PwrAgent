import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DECISION_JEV_DEFAULT_MODEL,
  DECISION_KNOWN_MODELS,
  DECISION_LOCAL_DEFAULT_MODEL,
  decisionModelOptions,
  type DecisionModelInfo,
  type DecisionProviderId,
} from "../decision-models";

/**
 * The rule: the Model picker always holds the model Settings would run, so
 * the closed picker never shows a blank or a model that is not in effect;
 * it offers every model the provider listed and every model PwrAgent knows,
 * each once; and the default leads.
 */

const provider = fc.constantFrom<DecisionProviderId>("local", "jev");
const knownIds = [...DECISION_KNOWN_MODELS.local, ...DECISION_KNOWN_MODELS.jev].map((model) => model.id);
const modelId = fc.oneof(
  fc.constantFrom(...knownIds),
  fc.string({ minLength: 1, maxLength: 12 }),
  fc.string({ maxLength: 4 }).map((id) => ` ${id} `),
);
const listed = fc.array(
  fc.record({ id: modelId, description: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }) }),
  { maxLength: 8 },
).map((models) => models.map(({ id, description }): DecisionModelInfo => (description === undefined ? { id } : { id, description })));
const saved = fc.option(modelId.filter((id) => id.trim().length > 0).map((id) => id.trim()), { nil: undefined });

const defaultFor = (id: DecisionProviderId) => (id === "local" ? DECISION_LOCAL_DEFAULT_MODEL : DECISION_JEV_DEFAULT_MODEL);

describe("decision Model picker choices", () => {
  it("always offers the model in effect, and each id once", () => {
    fc.assert(fc.property(provider, saved, fc.option(listed, { nil: undefined }), (id, savedModel, listedModels) => {
      const options = decisionModelOptions({ provider: id, saved: savedModel, listed: listedModels });
      const ids = options.map((option) => option.id);
      expect(ids).toContain(savedModel ?? defaultFor(id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((option) => option === option.trim() && option.length > 0)).toBe(true);
    }), { numRuns: 500 });
  });

  it("offers every listed and every known model, listed ones first", () => {
    fc.assert(fc.property(provider, saved, listed, (id, savedModel, listedModels) => {
      const options = decisionModelOptions({ provider: id, saved: savedModel, listed: listedModels });
      const ids = options.map((option) => option.id);
      for (const model of listedModels) {
        if (model.id.trim()) expect(options.find((option) => option.id === model.id.trim())?.source).toBe("listed");
      }
      for (const model of DECISION_KNOWN_MODELS[id]) expect(ids).toContain(model.id);
      const sources = options.map((option) => option.source);
      const order = { listed: 0, known: 1, saved: 2 } as const;
      expect(sources.map((source) => order[source])).toEqual([...sources.map((source) => order[source])].sort());
    }), { numRuns: 500 });
  });

  it("puts the default first in whichever group holds it", () => {
    fc.assert(fc.property(provider, saved, listed, (id, savedModel, listedModels) => {
      const options = decisionModelOptions({ provider: id, saved: savedModel, listed: listedModels });
      const fallback = options.find((option) => option.id === defaultFor(id))!;
      expect(options.find((option) => option.source === fallback.source)).toBe(fallback);
    }), { numRuns: 500 });
  });

  it("describes a listed model by the provider's words, else PwrAgent's", () => {
    expect(decisionModelOptions({ provider: "jev", listed: [{ id: "jev-preview" }, { id: "jev-latest", description: "From TypeSafe" }] }).slice(0, 2))
      .toEqual([
        { id: "jev-latest", description: "From TypeSafe", source: "listed" },
        { id: "jev-preview", description: "Jev's preview build, when there is one", source: "listed" },
      ]);
  });
});
