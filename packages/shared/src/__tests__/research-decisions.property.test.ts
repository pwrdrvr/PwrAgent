import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decisionProvidersReadiness,
  decisionRunProviderName,
  readyDecisionProviders,
  type DecisionModelChoice,
  type DecisionRunProvider,
} from "../decision-models";
import { parseOpenAIDecisionRegistration } from "../openai-decisions";
import {
  extractDecisionBatchIds,
  researchDecisionsPromptGuidance,
  type ResearchDecisionsPromptRole,
} from "../research";

const roles: readonly ResearchDecisionsPromptRole[] = ["coordinator", "worker", "resume", "item"];
const providers: readonly DecisionRunProvider[] = ["openai", "jev", "local"];

describe("Research Decisions shared rules", () => {
  it("surfaces prompt guidance iff at least one decision provider is enabled and ready", () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.constantFrom<DecisionModelChoice>("off", "local", "jev"),
      fc.constantFrom(...roles),
      fc.stringMatching(/^[a-z0-9-]{3,24}$/),
      (openaiEnabled, openaiKey, jevEnabled, jevKey, localEnabled, chosenModel, role, runId) => {
        const readiness = decisionProvidersReadiness({
          openaiEnabled,
          openaiKey,
          jevKey,
          decisionModels: {
            model: chosenModel,
            local: { enabled: localEnabled },
            jev: { enabled: jevEnabled },
          },
        });
        const ready = readyDecisionProviders(readiness);
        const guidance = researchDecisionsPromptGuidance(ready, role, runId);

        if (ready.length === 0) {
          expect(guidance).toBeUndefined();
          return;
        }
        expect(guidance).toBeDefined();
        for (const provider of providers) {
          const label = decisionRunProviderName(provider);
          if (ready.includes(provider)) {
            expect(guidance).toContain(label);
          } else {
            expect(guidance).not.toContain(label);
          }
        }
        expect(guidance).toContain("decisions_list");
        if (role !== "coordinator") {
          expect(guidance).toContain(`researchRunId=${runId}`);
        } else {
          expect(guidance).toContain("research_run");
        }
      },
    ));
  });

  it("validates research_run scope and researchRunId consistently", () => {
    const base = {
      name: "grade_claim",
      instructions: "Is this claim supported?",
      question: { type: "predicate" },
      inputSchema: { type: "string" },
    };

    const inferred = parseOpenAIDecisionRegistration({ ...base, researchRunId: "run-123" });
    expect(inferred.ok).toBe(true);
    if (inferred.ok) {
      expect(inferred.value.scope).toBe("research_run");
      expect(inferred.value.researchRunId).toBe("run-123");
    }

    const explicitNoId = parseOpenAIDecisionRegistration({ ...base, scope: "research_run" });
    expect(explicitNoId.ok).toBe(true);
    if (explicitNoId.ok) {
      expect(explicitNoId.value.scope).toBe("research_run");
      expect(explicitNoId.value.researchRunId).toBeUndefined();
    }

    const mismatched = parseOpenAIDecisionRegistration({ ...base, scope: "profile", researchRunId: "run-123" });
    expect(mismatched.ok).toBe(false);

    const badWhitespace = parseOpenAIDecisionRegistration({ ...base, scope: "research_run", researchRunId: "run 123" });
    expect(badWhitespace.ok).toBe(false);
  });

  it("extracts unique decision batch IDs in first-seen order across text and paths", () => {
    fc.assert(fc.property(
      fc.array(fc.stringMatching(/^[A-Za-z0-9-]{4,24}$/), { minLength: 1, maxLength: 6 }),
      (suffixes) => {
        const expected = [...new Set(suffixes.map((suffix) => `batch_${suffix}`))];
        const text = `Evaluated ${expected.join(" and repeated ")} plus ${expected[0]} and invalid batch_!`;
        const paths = expected.map((id) => `out/${id}.jsonl`);
        expect(extractDecisionBatchIds(text, paths)).toEqual(expected);
      },
    ));
  });
});
