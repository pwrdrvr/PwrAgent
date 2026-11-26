/**
 * Auto-compaction rules: when PwrAgent compacts a thread for a model.
 *
 * A rule names a provider (a backend id such as `acp:antigravity`, or `*` for
 * every provider) and a model (an exact id, a family such as `gemini-*`, or
 * `*`). It gives a context budget and the percent of that budget where
 * PwrAgent compacts. The effective window is the smaller of the budget and the
 * window the model reports, so a budget never raises a model's own limit.
 *
 * Built-in rules ship enabled. A saved rule with the same provider and model
 * replaces a built-in one, which is how the operator edits or turns off a
 * default. Settings store saved rules only, as `[[models.auto_compaction]]`.
 */

export type AutoCompactionDuringTurn = "steer" | "wait";

export type DesktopAutoCompactionRule = {
  /** A backend id (`codex`, `claude`, `acp:<id>`) or `*` for every provider. */
  provider: string;
  /** An exact model id, a prefix ending in `*` (`gemini-*`), or `*`. */
  model: string;
  /** False keeps PwrAgent from compacting models this rule matches. */
  enabled: boolean;
  /** Effective window budget. Absent uses the window the model reports. */
  contextWindowTokens?: number;
  /** Percent of the effective window where PwrAgent compacts. */
  compactAtPercent?: number;
  /**
   * When the threshold is passed while a turn runs: steer `/compact` into it
   * (on a provider that can), or wait for the turn to end. Absent is steer.
   */
  duringTurn?: AutoCompactionDuringTurn;
};

export type AutoCompactionRuleSource = "builtin" | "settings";

export type EffectiveAutoCompactionRule = DesktopAutoCompactionRule & {
  source: AutoCompactionRuleSource;
  /** A saved rule that replaces a built-in one with the same key. */
  overridesBuiltin?: boolean;
};

export const AUTO_COMPACTION_ALL = "*";
export const MIN_AUTO_COMPACTION_WINDOW_TOKENS = 16_384;
export const MAX_AUTO_COMPACTION_WINDOW_TOKENS = 2_000_000;
export const MIN_AUTO_COMPACTION_PERCENT = 50;
export const MAX_AUTO_COMPACTION_PERCENT = 95;
export const DEFAULT_AUTO_COMPACTION_PERCENT = 80;
/**
 * A held thread re-arms once its fill falls below this share of the trigger,
 * so a compaction that leaves the context just under the trigger cannot
 * start another one on the next report.
 */
export const AUTO_COMPACTION_REARM_RATIO = 0.9;

/**
 * Gemini models: a 512k budget, compacting at 80% (409,600 tokens).
 * Antigravity reports a 1,048,576-token window for Gemini 4 Neon and has no
 * setting for when it compacts; answers degrade well before that.
 */
export const BUILTIN_AUTO_COMPACTION_RULES: readonly DesktopAutoCompactionRule[] = [
  {
    provider: AUTO_COMPACTION_ALL,
    model: "gemini-*",
    enabled: true,
    contextWindowTokens: 512_000,
    compactAtPercent: DEFAULT_AUTO_COMPACTION_PERCENT,
  },
];

export function autoCompactionRuleKey(rule: Pick<DesktopAutoCompactionRule, "provider" | "model">): string {
  return JSON.stringify([rule.provider, rule.model]);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readWholeNumberInRange(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

/**
 * A saved rule as the config or a patch holds it, or undefined when it names
 * no provider or model. An out-of-range budget or percent is dropped, so the
 * rule falls back to the model's window or the default percent.
 */
export function normalizeAutoCompactionRule(
  value: Partial<Record<keyof DesktopAutoCompactionRule, unknown>> | undefined,
): DesktopAutoCompactionRule | undefined {
  const provider = readTrimmedString(value?.provider);
  const model = readTrimmedString(value?.model);
  if (!provider || !model) return undefined;
  const contextWindowTokens = readWholeNumberInRange(
    value?.contextWindowTokens,
    MIN_AUTO_COMPACTION_WINDOW_TOKENS,
    MAX_AUTO_COMPACTION_WINDOW_TOKENS,
  );
  const compactAtPercent = readWholeNumberInRange(
    value?.compactAtPercent,
    MIN_AUTO_COMPACTION_PERCENT,
    MAX_AUTO_COMPACTION_PERCENT,
  );
  const duringTurn = value?.duringTurn === "wait" || value?.duringTurn === "steer"
    ? value.duringTurn
    : undefined;
  return {
    provider,
    model,
    enabled: value?.enabled !== false,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(compactAtPercent !== undefined ? { compactAtPercent } : {}),
    ...(duringTurn ? { duringTurn } : {}),
  };
}

/** Saved rules, normalized, with the last of any duplicate key kept. */
export function normalizeAutoCompactionRules(
  values: readonly Partial<Record<keyof DesktopAutoCompactionRule, unknown>>[] | undefined,
): DesktopAutoCompactionRule[] {
  const byKey = new Map<string, DesktopAutoCompactionRule>();
  for (const value of values ?? []) {
    const rule = normalizeAutoCompactionRule(value);
    if (!rule) continue;
    const key = autoCompactionRuleKey(rule);
    byKey.delete(key);
    byKey.set(key, rule);
  }
  return [...byKey.values()];
}

/**
 * Built-in rules followed by saved ones. A saved rule with a built-in rule's
 * key takes that rule's place and is marked as its override.
 */
export function effectiveAutoCompactionRules(
  saved: readonly DesktopAutoCompactionRule[] | undefined,
): EffectiveAutoCompactionRule[] {
  const savedByKey = new Map(
    normalizeAutoCompactionRules(saved).map((rule) => [autoCompactionRuleKey(rule), rule]),
  );
  const result: EffectiveAutoCompactionRule[] = [];
  for (const builtin of BUILTIN_AUTO_COMPACTION_RULES) {
    const key = autoCompactionRuleKey(builtin);
    const override = savedByKey.get(key);
    if (override) {
      result.push({ ...override, source: "settings", overridesBuiltin: true });
      savedByKey.delete(key);
    } else {
      result.push({ ...builtin, source: "builtin" });
    }
  }
  for (const rule of savedByKey.values()) {
    result.push({ ...rule, source: "settings" });
  }
  return result;
}

/**
 * How closely a pattern matches a value: -1 for no match, otherwise higher is
 * more specific. An exact match beats every prefix, a longer prefix beats a
 * shorter one, and `*` matches everything least specifically.
 */
export function autoCompactionPatternScore(pattern: string, value: string): number {
  const normalizedPattern = pattern.toLowerCase();
  const normalizedValue = value.toLowerCase();
  if (normalizedPattern === AUTO_COMPACTION_ALL) return 0;
  if (normalizedPattern.endsWith("*")) {
    const prefix = normalizedPattern.slice(0, -1);
    return normalizedValue.startsWith(prefix) ? 1 + prefix.length : -1;
  }
  return normalizedPattern === normalizedValue ? Number.MAX_SAFE_INTEGER : -1;
}

/**
 * The rule for one provider's model, or undefined when none matches. A rule
 * naming the provider beats one for every provider; within that, the more
 * specific model pattern wins, then the later rule.
 */
export function matchAutoCompactionRule<T extends DesktopAutoCompactionRule>(
  rules: readonly T[],
  target: { backend: string; model?: string },
): T | undefined {
  const model = target.model?.trim();
  if (!model) return undefined;
  let best: { rule: T; providerScore: number; modelScore: number } | undefined;
  for (const rule of rules) {
    const providerScore = rule.provider === AUTO_COMPACTION_ALL
      ? 0
      : rule.provider === target.backend ? 1 : -1;
    if (providerScore < 0) continue;
    const modelScore = autoCompactionPatternScore(rule.model, model);
    if (modelScore < 0) continue;
    if (
      !best
      || providerScore > best.providerScore
      || (providerScore === best.providerScore && modelScore >= best.modelScore)
    ) {
      best = { rule, providerScore, modelScore };
    }
  }
  return best?.rule;
}

export type AutoCompactionThreshold = {
  /** The smaller of the rule's budget and the reported window. */
  effectiveContextWindow: number;
  /** The window the provider reported. */
  reportedContextWindow: number;
  /** The rule's budget, when it sets one. */
  budgetTokens?: number;
  compactAtPercent: number;
  /** Fill at or above this compacts. */
  triggerTokens: number;
  /** A held thread re-arms below this fill. */
  rearmTokens: number;
  duringTurn: AutoCompactionDuringTurn;
  rule: EffectiveAutoCompactionRule;
};

/**
 * The threshold for one thread's model, or undefined when no enabled rule
 * matches it or the reported window is not a positive number.
 */
export function resolveAutoCompactionThreshold(params: {
  rules: readonly EffectiveAutoCompactionRule[];
  backend: string;
  model?: string;
  reportedContextWindow: number;
}): AutoCompactionThreshold | undefined {
  const reported = params.reportedContextWindow;
  if (!Number.isFinite(reported) || reported <= 0) return undefined;
  const rule = matchAutoCompactionRule(params.rules, params);
  if (!rule?.enabled) return undefined;
  const budgetTokens = rule.contextWindowTokens;
  const effectiveContextWindow = Math.min(budgetTokens ?? reported, reported);
  const compactAtPercent = rule.compactAtPercent ?? DEFAULT_AUTO_COMPACTION_PERCENT;
  const triggerTokens = Math.floor((effectiveContextWindow * compactAtPercent) / 100);
  return {
    effectiveContextWindow,
    reportedContextWindow: reported,
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    compactAtPercent,
    triggerTokens,
    rearmTokens: Math.floor(triggerTokens * AUTO_COMPACTION_REARM_RATIO),
    duringTurn: rule.duringTurn ?? "steer",
    rule,
  };
}

/** `gemini-*` reads "Gemini models"; an exact id reads as itself. */
export function describeAutoCompactionModelPattern(model: string): string {
  if (model === AUTO_COMPACTION_ALL) return "All models";
  if (!model.endsWith("*")) return model;
  const family = model.slice(0, -1).replace(/[-_.\s]+$/u, "");
  if (!family) return "All models";
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} models`;
}
