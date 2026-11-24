import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BackendLaunchpadOptions, BackendModelOption } from "../contracts/backend";
import {
  defaultModelOption,
  defaultReasoningEffort,
  displayedReasoningEffort,
  modelOptionFor,
  offeredReasoningEffort,
} from "../model-defaults";

// The owner starts threads by these rules, and the composer, queued sends and
// messaging show them. Each property states a rule literally.

const MODEL_IDS = ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-5.6", "@refuseless/gpt-6.1-terra", "k3", "grok-4.7"];
const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

const modelArb: fc.Arbitrary<BackendModelOption> = fc.record({
  id: fc.constantFrom(...MODEL_IDS),
  current: fc.option(fc.boolean(), { nil: undefined }),
  supportsReasoning: fc.option(fc.boolean(), { nil: undefined }),
  reasoningEfforts: fc.option(fc.uniqueArray(fc.constantFrom(...EFFORTS), { minLength: 1, maxLength: 4 }), { nil: undefined }),
  defaultReasoningEffort: fc.option(fc.constantFrom(...EFFORTS), { nil: undefined }),
}).map((model) => Object.fromEntries(Object.entries(model).filter(([, value]) => value !== undefined)) as unknown as BackendModelOption);

const optionsArb: fc.Arbitrary<BackendLaunchpadOptions> = fc.record({
  models: fc.uniqueArray(modelArb, { selector: (model) => model.id, maxLength: 5 }),
  reasoningEfforts: fc.option(fc.uniqueArray(fc.constantFrom(...EFFORTS), { minLength: 1, maxLength: 4 }), { nil: undefined }),
}).map((options) => Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as unknown as BackendLaunchpadOptions);

const backendArb = fc.constantFrom("codex", "claude", "acp:kimi", "acp:grok", undefined);
const effortCandidatesArb = fc.array(fc.option(fc.constantFrom(...EFFORTS), { nil: undefined }), { maxLength: 3 });

/** A model's efforts: its own list, else the backend's. */
const effortsOf = (options: BackendLaunchpadOptions | undefined, model: BackendModelOption | undefined) =>
  model?.reasoningEfforts ?? options?.reasoningEfforts ?? [];

describe("model defaults", () => {
  it("starts on the current model, else the backend's preferred one, else a reasoning model, else the first", () => {
    fc.assert(fc.property(backendArb, optionsArb, (backend, options) => {
      const models = options.models ?? [];
      // Codex prefers its own 6.1 coding models; a registered provider's
      // qualified model id never stands in for them.
      const own = models.filter((model) => !model.id.startsWith("@"));
      const preferred = backend === "codex"
        ? ["gpt-6.1-terra", "gpt-6.1-sol"].find((id) => own.some((model) => model.id === id))
          ?? own.find((model) => model.current)?.id ?? own[0]?.id
        : models.find((model) => model.current)?.id ?? models[0]?.id;
      const expected = models.find((model) => model.current)
        ?? models.find((model) => model.id === preferred)
        ?? models.find((model) => model.supportsReasoning)
        ?? models[0];
      expect(defaultModelOption(backend, options)).toEqual(expected);
    }), { numRuns: 500 });
  });

  it("uses the first named model the catalog lists, else the default", () => {
    fc.assert(fc.property(backendArb, optionsArb, fc.array(fc.option(fc.constantFrom(...MODEL_IDS, "retired"), { nil: undefined }), { maxLength: 3 }), (backend, options, candidates) => {
      const named = candidates.find((id) => id !== undefined && (options.models ?? []).some((model) => model.id === id));
      expect(modelOptionFor(backend, options, candidates)).toEqual(
        named ? options.models!.find((model) => model.id === named) : defaultModelOption(backend, options),
      );
    }), { numRuns: 500 });
  });

  it("defaults the effort to the model's own default, else Medium, else the first it offers", () => {
    fc.assert(fc.property(optionsArb, fc.nat(), (options, index) => {
      const models = options.models ?? [];
      const model = models.length > 0 ? models[index % models.length] : undefined;
      const efforts = effortsOf(options, model);
      const expected = model?.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort)
        ? model.defaultReasoningEffort
        : efforts.includes("medium") ? "medium" : efforts[0];
      expect(defaultReasoningEffort(options, model)).toBe(expected);
    }), { numRuns: 500 });
  });

  it("keeps the first saved effort the model offers, else defaults, and keeps it unchecked with no catalog", () => {
    fc.assert(fc.property(fc.option(optionsArb, { nil: undefined }), fc.nat(), fc.boolean(), effortCandidatesArb, (options, index, withModel, candidates) => {
      const models = options?.models ?? [];
      const model = withModel && models.length > 0 ? models[index % models.length] : undefined;
      const efforts = effortsOf(options, model);
      const offered = candidates.find((effort) => effort !== undefined && efforts.includes(effort))
        ?? defaultReasoningEffort(options, model);
      expect(offeredReasoningEffort(options, model, candidates)).toBe(offered);
      expect(displayedReasoningEffort(options, model, candidates)).toBe(
        !options && !model ? candidates.find((effort) => effort !== undefined) : offered,
      );
    }), { numRuns: 500 });
  });
});
