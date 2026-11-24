import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BackendLaunchpadOptions, BackendModelOption } from "@pwragent/shared/contracts/backend";
import { modelOptionFor, reasoningEffortsForModel } from "@pwragent/shared/model-defaults";
import { resolveThreadTodoModel } from "../thread-todos/thread-todo-models";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const modelArb: fc.Arbitrary<BackendModelOption> = fc.record({
  id: fc.constantFrom("gpt-6.1-terra", "gpt-6.1-sol", "gpt-5.6", "k3"),
  current: fc.option(fc.boolean(), { nil: undefined }),
  supportsReasoning: fc.option(fc.boolean(), { nil: undefined }),
  reasoningEfforts: fc.option(fc.uniqueArray(fc.constantFrom(...EFFORTS), { minLength: 1, maxLength: 4 }), { nil: undefined }),
}).map((model) => Object.fromEntries(Object.entries(model).filter(([, value]) => value !== undefined)) as unknown as BackendModelOption);

const optionsArb: fc.Arbitrary<BackendLaunchpadOptions> = fc.record({
  models: fc.uniqueArray(modelArb, { selector: (model) => model.id, minLength: 1, maxLength: 4 }),
});

describe("resolveThreadTodoModel", () => {
  it("checks a card's effort against the model the owner starts the thread on", () => {
    fc.assert(fc.property(
      fc.constantFrom("codex", "acp:kimi"),
      optionsArb,
      fc.constantFrom(...EFFORTS),
      fc.option(fc.constantFrom("gpt-6.1-terra", "gpt-5.6", "retired"), { nil: undefined }),
      (backend, options, reasoningEffort, threadModel) => {
        const resolved = resolveThreadTodoModel(options, { reasoningEffort }, threadModel, { backend });
        // The owner starts on the thread's model when the catalog lists it,
        // else its default, and checks the effort against that model.
        const startsOn = modelOptionFor(backend, options, [threadModel])!;
        // A model that reports no efforts keeps the card's effort unchecked.
        const efforts = reasoningEffortsForModel(options, startsOn);
        const offered = startsOn.supportsReasoning !== false
          && (efforts.length === 0 || efforts.includes(reasoningEffort));
        expect(resolved.ok).toBe(offered);
      },
    ), { numRuns: 500 });
  });
});
