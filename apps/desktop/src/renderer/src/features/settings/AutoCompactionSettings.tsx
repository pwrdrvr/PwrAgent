import { useState } from "react";
import {
  AUTO_COMPACTION_ALL,
  DEFAULT_AUTO_COMPACTION_PERCENT,
  MAX_AUTO_COMPACTION_PERCENT,
  MAX_AUTO_COMPACTION_WINDOW_TOKENS,
  MIN_AUTO_COMPACTION_PERCENT,
  MIN_AUTO_COMPACTION_WINDOW_TOKENS,
  autoCompactionRuleKey,
  describeAutoCompactionModelPattern,
  effectiveAutoCompactionRules,
  type DesktopAutoCompactionRule,
  type EffectiveAutoCompactionRule,
} from "@pwragent/shared/auto-compaction";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import { SegmentedField, SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";
import { useSettingsDraft } from "./useSettingsDraft";
import { useUnsavedSettingsChanges } from "./UnsavedSettingsChanges";

/** Providers that take a steered `/compact` into a running turn. */
const STEERING_PROVIDERS = new Set(["acp:antigravity"]);

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** The rules that apply on this provider's page, most general first. */
export function autoCompactionRulesForProvider(
  saved: readonly DesktopAutoCompactionRule[],
  backendId: string,
): EffectiveAutoCompactionRule[] {
  const rules = effectiveAutoCompactionRules(saved)
    .filter((rule) => rule.provider === AUTO_COMPACTION_ALL || rule.provider === backendId);
  // A provider's own rule hides the every-provider rule with the same model.
  const own = new Set(rules.filter((rule) => rule.provider === backendId).map((rule) => rule.model));
  return rules.filter((rule) => rule.provider === backendId || !own.has(rule.model));
}

type EditorTarget = { model: string; adding: boolean };

/**
 * One provider page's Auto-compaction section: when PwrAgent compacts this
 * provider's threads. Built-in defaults apply to every provider; editing one
 * here saves an override for this provider alone, and Reset removes it.
 */
export function AutoCompactionSettings(props: {
  /** Backend id the rules are keyed by: "codex", "claude" or "acp:<id>". */
  backendId: string;
  providerLabel: string;
  backends: readonly BackendSummary[];
  saved: readonly DesktopAutoCompactionRule[];
  saving: boolean;
  /** Resolves false when the write failed. */
  onSave: (rules: DesktopAutoCompactionRule[]) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<EditorTarget>();
  const rules = autoCompactionRulesForProvider(props.saved, props.backendId);
  const models = props.backends.find((backend) => backend.kind === props.backendId)?.launchpadOptions?.models ?? [];
  const labelOf = (pattern: string): string =>
    models.find((model) => model.id === pattern)?.label ?? describeAutoCompactionModelPattern(pattern);
  const canSteer = STEERING_PROVIDERS.has(props.backendId);
  const turnNote = props.backendId === "codex"
    ? "Codex compacts between turns. A threshold passed mid-turn waits for the turn to end."
    : canSteer
      ? undefined
      : `${props.providerLabel} compacts between turns. A threshold passed mid-turn waits for the turn to end.`;

  const save = async (next: DesktopAutoCompactionRule[]): Promise<boolean> => {
    try {
      return await props.onSave(next);
    } catch {
      return false;
    }
  };
  // Removing this provider's rule falls back to an every-provider one, if any.
  const general = effectiveAutoCompactionRules(props.saved).filter((rule) => rule.provider === AUTO_COMPACTION_ALL);
  const hasGeneralRule = (model: string) => general.some((rule) => rule.model === model);
  const withoutOwn = (model: string) => props.saved.filter((rule) =>
    autoCompactionRuleKey(rule) !== autoCompactionRuleKey({ provider: props.backendId, model }));

  return (
    <SettingsSection
      eyebrow="Defaults"
      title="Auto-compaction"
      sectionId="auto-compaction"
      description={`PwrAgent compacts ${props.providerLabel} threads when their context passes a share of the model's budget.`}
    >
      <div className="settings-fields">
        {rules.map((rule) => {
          const key = autoCompactionRuleKey(rule);
          const isEditing = Boolean(editing && !editing.adding && editing.model === rule.model);
          return (
            <div key={key}>
              <SettingsField
                label={labelOf(rule.model)}
                sub={describeRule(rule, props.backendId)}
                control={
                  <span className="settings-inline-actions">
                    <span className="auto-compaction-rule__summary">{summarizeRule(rule)}</span>
                    <button
                      aria-expanded={isEditing}
                      aria-label={`Edit ${labelOf(rule.model)} auto-compaction`}
                      className="button button--ghost"
                      // One editor at a time: switching rows would drop an
                      // unsaved draft without asking.
                      disabled={props.saving || Boolean(editing && !isEditing)}
                      type="button"
                      onClick={() => setEditing(isEditing ? undefined : { model: rule.model, adding: false })}
                    >
                      Edit
                    </button>
                  </span>
                }
              />
              {isEditing ? (
                <AutoCompactionRuleEditor
                  key={`edit:${key}`}
                  backendId={props.backendId}
                  canSteer={canSteer}
                  rule={rule}
                  saving={props.saving}
                  onCancel={() => setEditing(undefined)}
                  onRemove={rule.provider === props.backendId
                    ? async () => {
                        if (await save(withoutOwn(rule.model))) setEditing(undefined);
                      }
                    : undefined}
                  removeLabel={hasGeneralRule(rule.model) ? "Reset to default" : "Remove rule"}
                  onSave={async (next) => {
                    const ok = await save([...withoutOwn(rule.model), next]);
                    if (ok) setEditing(undefined);
                    return ok;
                  }}
                />
              ) : null}
            </div>
          );
        })}
        {turnNote ? <p className="settings-field__sub">{turnNote}</p> : null}
        {editing?.adding ? (
          <AutoCompactionRuleEditor
            key="add"
            adding
            backendId={props.backendId}
            canSteer={canSteer}
            rule={{
              provider: props.backendId,
              model: "",
              enabled: true,
              compactAtPercent: DEFAULT_AUTO_COMPACTION_PERCENT,
              source: "settings",
            }}
            saving={props.saving}
            onCancel={() => setEditing(undefined)}
            onSave={async (next) => {
              const ok = await save([...withoutOwn(next.model), next]);
              if (ok) setEditing(undefined);
              return ok;
            }}
          />
        ) : editing ? null : (
          <div className="settings-inline-actions auto-compaction-rule__add">
            <button
              className="button button--secondary"
              disabled={props.saving}
              type="button"
              onClick={() => setEditing({ model: "", adding: true })}
            >
              Add a rule
            </button>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

function describeRule(rule: EffectiveAutoCompactionRule, backendId: string): string {
  const scope = rule.provider === backendId ? "this provider" : "all providers";
  const origin = rule.source === "builtin" ? "Default" : rule.overridesBuiltin ? "Changed from default" : "Saved";
  return `${rule.model} · ${scope} · ${origin}`;
}

function summarizeRule(rule: DesktopAutoCompactionRule): string {
  if (!rule.enabled) return "Off";
  const percent = rule.compactAtPercent ?? DEFAULT_AUTO_COMPACTION_PERCENT;
  if (rule.contextWindowTokens === undefined) return `${percent}% of the model window`;
  const trigger = Math.floor((rule.contextWindowTokens * percent) / 100);
  return `${formatTokens(rule.contextWindowTokens)} budget · ${percent}% · ${formatTokens(trigger)}`;
}

type RuleDraft = {
  model: string;
  enabled: boolean;
  budget: string;
  percent: string;
  duringTurn: "steer" | "wait";
};

function parseWhole(value: string): number | undefined {
  const trimmed = value.replace(/[,_\s]/gu, "");
  return /^\d+$/u.test(trimmed) ? Number(trimmed) : undefined;
}

/** The problem with a draft, worded for the field it belongs to. */
export function autoCompactionDraftProblem(draft: RuleDraft): string | undefined {
  if (!draft.model.trim()) return "Name a model id, or a family ending in *, such as gemini-*.";
  if (draft.budget.trim()) {
    const budget = parseWhole(draft.budget);
    if (budget === undefined || budget < MIN_AUTO_COMPACTION_WINDOW_TOKENS || budget > MAX_AUTO_COMPACTION_WINDOW_TOKENS) {
      return `Budget must be a whole number from ${MIN_AUTO_COMPACTION_WINDOW_TOKENS.toLocaleString("en-US")} to ${MAX_AUTO_COMPACTION_WINDOW_TOKENS.toLocaleString("en-US")} tokens, or blank for the model's window.`;
    }
  }
  const percent = parseWhole(draft.percent);
  if (percent === undefined || percent < MIN_AUTO_COMPACTION_PERCENT || percent > MAX_AUTO_COMPACTION_PERCENT) {
    return `Compact at must be a whole percent from ${MIN_AUTO_COMPACTION_PERCENT} to ${MAX_AUTO_COMPACTION_PERCENT}.`;
  }
  return undefined;
}

function AutoCompactionRuleEditor(props: {
  adding?: boolean;
  backendId: string;
  canSteer: boolean;
  rule: EffectiveAutoCompactionRule;
  saving: boolean;
  removeLabel?: string;
  onCancel: () => void;
  onRemove?: () => Promise<void>;
  onSave: (rule: DesktopAutoCompactionRule) => Promise<boolean>;
}) {
  const draft = useSettingsDraft<RuleDraft>({
    model: props.rule.model,
    enabled: props.rule.enabled,
    budget: props.rule.contextWindowTokens?.toLocaleString("en-US") ?? "",
    percent: String(props.rule.compactAtPercent ?? DEFAULT_AUTO_COMPACTION_PERCENT),
    duringTurn: props.rule.duringTurn ?? "steer",
  });
  const [attempted, setAttempted] = useState(false);
  const problem = autoCompactionDraftProblem(draft.values);
  const budget = parseWhole(draft.values.budget);
  const percent = parseWhole(draft.values.percent);
  const trigger = budget !== undefined && percent !== undefined ? Math.floor((budget * percent) / 100) : undefined;

  const submit = async (): Promise<boolean> => {
    setAttempted(true);
    if (problem) return false;
    const ok = await props.onSave({
      provider: props.backendId,
      model: draft.values.model.trim(),
      enabled: draft.values.enabled,
      ...(budget !== undefined && draft.values.budget.trim() ? { contextWindowTokens: budget } : {}),
      ...(percent !== undefined ? { compactAtPercent: percent } : {}),
      ...(props.canSteer && draft.values.duringTurn === "wait" ? { duringTurn: "wait" as const } : {}),
    });
    if (ok) draft.discard();
    return ok;
  };
  useUnsavedSettingsChanges(draft.dirty || props.adding
    ? { label: "Auto-compaction", save: submit, discard: () => { draft.discard(); props.onCancel(); } }
    : undefined);

  return (
    <div className="auto-compaction-editor">
      <SettingsField
        label="Model"
        sub="An exact model id, or a family ending in *, such as gemini-*."
        control={
          <input
            aria-label="Model"
            className="settings-input"
            disabled={props.saving || !props.adding}
            placeholder="gemini-*"
            value={draft.values.model}
            onChange={(event) => draft.set("model", event.currentTarget.value)}
          />
        }
      />
      <SettingsField
        label="Auto-compaction"
        sub="Off leaves compaction to the agent."
        control={
          <SettingsSwitch
            checked={draft.values.enabled}
            disabled={props.saving}
            label="Auto-compaction"
            onChange={(next) => draft.set("enabled", next)}
          />
        }
      />
      {draft.values.enabled ? (
        <>
          <SettingsField
            label="Context budget (tokens)"
            sub="The smaller of this and the model's reported window. Blank uses the model's window."
            control={
              <input
                aria-label="Context budget (tokens)"
                className="settings-input"
                disabled={props.saving}
                inputMode="numeric"
                placeholder="Model window"
                value={draft.values.budget}
                onChange={(event) => draft.set("budget", event.currentTarget.value)}
              />
            }
          />
          <SettingsField
            label="Compact at (%)"
            sub={trigger !== undefined
              ? `Compacts at ${trigger.toLocaleString("en-US")} tokens.`
              : "Percent of the context budget."}
            control={
              <input
                aria-label="Compact at (%)"
                className="settings-input"
                disabled={props.saving}
                inputMode="numeric"
                value={draft.values.percent}
                onChange={(event) => draft.set("percent", event.currentTarget.value)}
              />
            }
          />
          {props.canSteer ? (
            <SegmentedField
              label="During a turn"
              sub="Steering sends /compact into the running turn, then asks the agent to continue."
              disabled={props.saving}
              options={[
                { label: "Steer now", value: "steer" },
                { label: "Wait for the turn", value: "wait" },
              ]}
              value={draft.values.duringTurn}
              onChange={async (value) => { draft.set("duringTurn", value); }}
            />
          ) : null}
        </>
      ) : null}
      {attempted && problem ? <p className="settings-error" role="alert">{problem}</p> : null}
      <div className="settings-inline-actions auto-compaction-editor__actions">
        {props.onRemove ? (
          <button
            className="button button--ghost"
            disabled={props.saving}
            type="button"
            onClick={() => { void props.onRemove?.(); }}
          >
            {props.removeLabel ?? "Remove rule"}
          </button>
        ) : null}
        <button
          className="button button--ghost"
          disabled={props.saving}
          type="button"
          onClick={() => { draft.discard(); props.onCancel(); }}
        >
          Cancel
        </button>
        <button
          className="button button--primary"
          disabled={props.saving}
          type="button"
          onClick={() => { void submit(); }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
