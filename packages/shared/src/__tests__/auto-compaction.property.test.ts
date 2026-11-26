import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  describeAutoCompactionModelPattern,
  effectiveAutoCompactionRules,
  matchAutoCompactionRule,
  normalizeAutoCompactionRule,
  resolveAutoCompactionThreshold,
  type DesktopAutoCompactionRule,
} from "../auto-compaction";

describe("auto-compaction rules", () => {
  it("gives Gemini 4 Neon on Antigravity a 512k budget that compacts at 409,600 tokens", () => {
    const threshold = resolveAutoCompactionThreshold({
      rules: effectiveAutoCompactionRules(undefined),
      backend: "acp:antigravity",
      model: "gemini-4-neon-high",
      reportedContextWindow: 1_048_576,
    });
    expect(threshold).toMatchObject({
      effectiveContextWindow: 512_000,
      reportedContextWindow: 1_048_576,
      compactAtPercent: 80,
      triggerTokens: 409_600,
      duringTurn: "steer",
    });
  });

  it("leaves models no rule names alone", () => {
    expect(resolveAutoCompactionThreshold({
      rules: effectiveAutoCompactionRules(undefined),
      backend: "acp:antigravity",
      model: "claude-sonnet-5-5",
      reportedContextWindow: 1_000_000,
    })).toBeUndefined();
  });

  it("lets a saved rule with the default's key turn the default off", () => {
    const rules = effectiveAutoCompactionRules([{ provider: "*", model: "gemini-*", enabled: false }]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ source: "settings", overridesBuiltin: true, enabled: false });
    expect(resolveAutoCompactionThreshold({
      rules, backend: "acp:gemini", model: "gemini-3-pro", reportedContextWindow: 1_000_000,
    })).toBeUndefined();
  });

  it("prefers a rule for this provider over one for every provider", () => {
    const rules = effectiveAutoCompactionRules([
      { provider: "acp:antigravity", model: "gemini-*", enabled: true, contextWindowTokens: 300_000 },
    ]);
    expect(resolveAutoCompactionThreshold({
      rules, backend: "acp:antigravity", model: "gemini-4-neon", reportedContextWindow: 1_048_576,
    })?.effectiveContextWindow).toBe(300_000);
    expect(resolveAutoCompactionThreshold({
      rules, backend: "acp:gemini", model: "gemini-4-neon", reportedContextWindow: 1_048_576,
    })?.effectiveContextWindow).toBe(512_000);
  });

  it("drops out-of-range numbers instead of keeping a rule that cannot work", () => {
    expect(normalizeAutoCompactionRule({
      provider: "codex", model: "gpt-5", enabled: true, contextWindowTokens: 12, compactAtPercent: 99,
    })).toEqual({ provider: "codex", model: "gpt-5", enabled: true });
    expect(normalizeAutoCompactionRule({ provider: " ", model: "gpt-5" })).toBeUndefined();
  });

  it.each([
    ["gemini-*", "Gemini models"],
    ["claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["*", "All models"],
  ])("names %s as %s", (pattern, label) => {
    expect(describeAutoCompactionModelPattern(pattern)).toBe(label);
  });

  const ruleArb: fc.Arbitrary<DesktopAutoCompactionRule> = fc.record({
    provider: fc.constantFrom("*", "codex", "claude", "acp:antigravity", "acp:gemini"),
    model: fc.constantFrom("*", "gemini-*", "gemini-4-*", "gemini-4-neon", "gpt-*", "gpt-5"),
    enabled: fc.boolean(),
    contextWindowTokens: fc.option(fc.integer({ min: 16_384, max: 2_000_000 }), { nil: undefined }),
    compactAtPercent: fc.option(fc.integer({ min: 50, max: 95 }), { nil: undefined }),
  }).map((rule) => normalizeAutoCompactionRule(rule)!);

  it("never raises a model's own window, and compacts inside the effective window", () => {
    fc.assert(fc.property(
      fc.array(ruleArb, { maxLength: 8 }),
      fc.constantFrom("codex", "claude", "acp:antigravity", "acp:gemini"),
      fc.constantFrom("gemini-4-neon", "gemini-3-pro", "gpt-5", "claude-sonnet-5-5"),
      fc.integer({ min: 1, max: 4_000_000 }),
      (saved, backend, model, reportedContextWindow) => {
        const threshold = resolveAutoCompactionThreshold({
          rules: effectiveAutoCompactionRules(saved), backend, model, reportedContextWindow,
        });
        if (!threshold) return;
        expect(threshold.effectiveContextWindow).toBeLessThanOrEqual(reportedContextWindow);
        expect(threshold.triggerTokens).toBeLessThanOrEqual(threshold.effectiveContextWindow);
        expect(threshold.rearmTokens).toBeLessThanOrEqual(threshold.triggerTokens);
      },
    ));
  });

  it("matches the same rule whatever order the saved rules come in, when their keys differ", () => {
    fc.assert(fc.property(
      fc.uniqueArray(ruleArb, { maxLength: 8, selector: (rule) => `${rule.provider}|${rule.model}` }),
      fc.constantFrom("codex", "acp:antigravity", "acp:gemini"),
      fc.constantFrom("gemini-4-neon", "gpt-5"),
      (saved, backend, model) => {
        const forward = matchAutoCompactionRule(effectiveAutoCompactionRules(saved), { backend, model });
        const backward = matchAutoCompactionRule(effectiveAutoCompactionRules([...saved].reverse()), { backend, model });
        expect(backward && { provider: backward.provider, model: backward.model })
          .toEqual(forward && { provider: forward.provider, model: forward.model });
      },
    ));
  });
});
