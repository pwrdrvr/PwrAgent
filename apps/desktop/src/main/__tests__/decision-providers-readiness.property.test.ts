import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decisionProvidersReadiness,
  type DesktopDecisionModelSettings,
} from "@pwragent/shared/decision-models";
import {
  resolveDefaultDecisionProvider,
  type DecisionSettingsReader,
} from "../openai-decisions/decision-provider-targets";

/**
 * The rule: the thread's Decisions tab tells the operator the same thing
 * the owner does. The tab computes readiness from the renderer's Settings
 * snapshot; the owner picks a default by reading Settings and keys. For
 * every combination of switches, keys and chosen model, both name the same
 * default provider, and the tab never calls a provider ready that the
 * owner could not run (off, or missing its key).
 */

const arbitrarySettings = fc.record({
  on: fc.record({ openai: fc.boolean(), jev: fc.boolean(), local: fc.boolean() }),
  keys: fc.record({ openai: fc.boolean(), jev: fc.boolean() }),
  chosen: fc.constantFrom("local", "jev", "off", undefined),
  // Absent sections and absent `enabled` keys mean on.
  writeLocal: fc.boolean(),
  writeJev: fc.boolean(),
});
type Arbitrary = typeof arbitrarySettings extends fc.Arbitrary<infer T> ? T : never;

function decisionSettings(value: Arbitrary): DesktopDecisionModelSettings {
  return {
    ...(value.chosen ? { model: value.chosen } : {}),
    ...(value.writeLocal || !value.on.local ? { local: { enabled: value.on.local } } : {}),
    ...(value.writeJev || !value.on.jev ? { jev: { enabled: value.on.jev } } : {}),
  };
}

function reader(value: Arbitrary): DecisionSettingsReader {
  return {
    resolveOpenAIDecisionsApiKey: async () => value.keys.openai ? "sk-test-openai" : undefined,
    resolveDecisionModelSettings: () => decisionSettings(value),
    resolveDecisionApiKey: async (provider) => provider === "jev" && value.keys.jev ? "sk-test-jev" : undefined,
    hasOpenAIDecisionsApiKey: async () => value.keys.openai,
    hasDecisionApiKey: async (provider) => provider === "jev" && value.keys.jev,
    resolveOpenAIDecisionsSettings: () => ({ enabled: value.on.openai }),
  };
}

function readiness(value: Arbitrary) {
  return decisionProvidersReadiness({
    decisionModels: decisionSettings(value),
    openaiEnabled: value.on.openai,
    openaiKey: value.keys.openai,
    jevKey: value.keys.jev,
  });
}

describe("the Decisions tab and the owner agree on providers", () => {
  it("names the provider the owner picks by default", async () => {
    await fc.assert(fc.asyncProperty(arbitrarySettings, async (value) => {
      const owner = await resolveDefaultDecisionProvider(reader(value));
      expect(readiness(value).defaultProvider).toBe(owner);
    }), { numRuns: 500 });
  });

  it("calls a provider ready only when it is on and has what a run needs", () => {
    fc.assert(fc.property(arbitrarySettings, (value) => {
      for (const entry of readiness(value).providers) {
        if (!entry.ready) continue;
        expect(value.on[entry.provider]).toBe(true);
        if (entry.provider === "openai" || entry.provider === "jev") expect(value.keys[entry.provider]).toBe(true);
        else expect(value.chosen).toBe("local");
      }
    }), { numRuns: 500 });
  });

  it("runs the default on a ready provider whenever any provider is ready", async () => {
    await fc.assert(fc.asyncProperty(arbitrarySettings, async (value) => {
      const { providers, defaultProvider } = readiness(value);
      if (!providers.some((entry) => entry.ready)) return;
      expect(providers.find((entry) => entry.provider === defaultProvider)?.ready).toBe(true);
    }), { numRuns: 500 });
  });
});
