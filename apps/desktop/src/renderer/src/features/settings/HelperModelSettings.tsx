import type { ReactNode } from "react";
import {
  HELPER_MODEL_AUTOMATIC_ORDER,
  HELPER_MODEL_DEFINITIONS,
  helperChoiceBackend,
  isHelperModelId,
  resolveHelperModel,
  type BackendModelOption,
  type BackendSummary,
  type DesktopHelperModelSettings,
  type HelperModelResolution,
} from "@pwragent/shared";
import { Select } from "../../components/Select";
import { SettingsField, SettingsSection } from "./SettingsLayout";

/** The closed pickers draw as the AI Providers page's chip pills. */
const PICKER_CLASS = "settings-select settings-select--chip";

type BackendState =
  | { kind: "loading"; label: string }
  | { kind: "unavailable"; label: string }
  | { kind: "ready"; label: string; models: BackendModelOption[]; reasoningEfforts?: string[] };

function backendState(
  backendKind: string,
  backends: readonly BackendSummary[],
  catalogReading: boolean,
): BackendState {
  const summary = backends.find((backend) => backend.kind === backendKind);
  const label = summary?.label ?? (backendKind === "codex" ? "Codex" : backendKind);
  if (summary?.discoveryPending || (!summary && catalogReading)) {
    return { kind: "loading", label };
  }
  if (!summary?.available) {
    return { kind: "unavailable", label };
  }
  return {
    kind: "ready",
    label,
    models: summary.launchpadOptions?.models ?? [],
    reasoningEfforts: summary.launchpadOptions?.reasoningEfforts,
  };
}

function modelLabel(id: string | undefined, models: readonly BackendModelOption[]): string {
  if (!id) return "";
  return models.find((model) => model.id === id)?.label ?? id;
}

/**
 * What the Helper model row runs. Thread titles stands in for every Codex
 * helper: with no per-helper row they differ only in built-in effort.
 */
function resolveDefault(
  settings: DesktopHelperModelSettings,
  codex: BackendState,
): HelperModelResolution | undefined {
  if (codex.kind !== "ready") return undefined;
  return resolveHelperModel({
    helper: "thread_titles",
    settings: { ...settings, helpers: {} },
    backend: "codex",
    models: codex.models.map((model) => ({
      ...model,
      reasoningEfforts: model.reasoningEfforts ?? codex.reasoningEfforts,
    })),
    catalogRead: true,
  });
}

function withDefaults(
  settings: DesktopHelperModelSettings,
  next: { defaultModel?: string; defaultReasoningEffort?: string },
): DesktopHelperModelSettings {
  const { defaultModel: _model, defaultReasoningEffort: _effort, ...rest } = settings;
  return {
    ...rest,
    ...(next.defaultModel ? { defaultModel: next.defaultModel } : {}),
    ...(next.defaultReasoningEffort
      ? { defaultReasoningEffort: next.defaultReasoningEffort }
      : {}),
  };
}

function Line(props: { warn?: boolean; children: ReactNode }) {
  return (
    <span
      className={
        props.warn
          ? "settings-helper-model__line settings-field__value--warn"
          : "settings-helper-model__line"
      }
    >
      {props.children}
    </span>
  );
}

/**
 * Per-helper rows exist only as hand edits of `config.toml`. Settings has no
 * editor for them, but never hides one: each is listed under the row with a
 * way to clear them all.
 */
function HelperOverrides(props: {
  settings: DesktopHelperModelSettings;
  backends: readonly BackendSummary[];
  catalogReading: boolean;
  disabled: boolean;
  onClear: () => void;
}) {
  const entries = Object.entries(props.settings.helpers)
    .filter(([, choice]) => choice.model || choice.reasoningEffort);
  if (entries.length === 0) return null;
  const order = (id: string) => {
    const index = HELPER_MODEL_DEFINITIONS.findIndex((entry) => entry.id === id);
    return index < 0 ? HELPER_MODEL_DEFINITIONS.length : index;
  };
  entries.sort(([left], [right]) => order(left) - order(right));

  return (
    <>
      <Line>
        {entries.length === 1
          ? "1 helper sets its own model in config.toml:"
          : `${entries.length} helpers set their own model in config.toml:`}
      </Line>
      {entries.map(([helper, choice]) => {
        const known = isHelperModelId(helper);
        const label = known
          ? HELPER_MODEL_DEFINITIONS.find((entry) => entry.id === helper)?.label ?? helper
          : helper;
        const state = backendState(
          known ? helperChoiceBackend(helper, choice) : choice.backend ?? "codex",
          props.backends,
          props.catalogReading,
        );
        const model = choice.model
          ? modelLabel(choice.model, state.kind === "ready" ? state.models : [])
          : "Helper model";
        return (
          <Line key={helper}>
            <strong>{label}</strong> · {model}
            {choice.reasoningEffort ? `, ${choice.reasoningEffort}` : ""}
          </Line>
        );
      })}
      <span className="settings-helper-model__actions">
        <button
          className="button button--secondary"
          disabled={props.disabled}
          type="button"
          onClick={props.onClear}
        >
          Clear overrides
        </button>
      </span>
    </>
  );
}

/**
 * Settings → AI Providers → Helpers: the one model and effort PwrAgent uses
 * for model turns it starts on its own. Main resolves every helper through
 * the same `resolveHelperModel`, so the line under the row names what the
 * next helper turn uses.
 */
export function HelperModelSettings(props: {
  backends: readonly BackendSummary[];
  settings: DesktopHelperModelSettings;
  catalogReading: boolean;
  saving: boolean;
  onSave: (next: DesktopHelperModelSettings) => Promise<unknown>;
}) {
  const { settings } = props;
  const codex = backendState("codex", props.backends, props.catalogReading);
  const models = codex.kind === "ready" ? codex.models : [];
  const save = (next: DesktopHelperModelSettings): void => {
    void props.onSave(next);
  };

  const savedModel = settings.defaultModel;
  const savedEffort = settings.defaultReasoningEffort;
  const resolution = resolveDefault(settings, codex);
  const automatic = resolveDefault({ helpers: {} }, codex);
  const automaticLabel = modelLabel(automatic?.model, models);
  // Only a catalog that was read can say a model is not offered.
  const modelOffered = savedModel && codex.kind === "ready"
    ? models.some((model) => model.id === savedModel)
    : true;
  const runningModel = models.find((model) => model.id === resolution?.model);
  // Undefined means the catalog names no efforts, and the resolver then runs
  // the saved one as is, so only a listed set can rule an effort out.
  const advertisedEfforts = runningModel?.supportsReasoning === false
    ? []
    : runningModel?.reasoningEfforts
      ?? (codex.kind === "ready" ? codex.reasoningEfforts : undefined);
  const efforts = advertisedEfforts ?? [];
  const effortOffered =
    savedEffort && codex.kind === "ready" && runningModel && advertisedEfforts
      ? advertisedEfforts.includes(savedEffort)
      : true;

  const lines: ReactNode[] = [];
  if (codex.kind === "loading") {
    lines.push(<Line key="state">Checking Codex models…</Line>);
  } else if (codex.kind === "unavailable") {
    lines.push(
      <Line key="state" warn>
        Codex is not connected. Helpers that run on Codex are skipped.
      </Line>,
    );
  } else if (!resolution?.model) {
    lines.push(<Line key="state" warn>Codex offers no models.</Line>);
  } else if (!modelOffered) {
    lines.push(
      <Line key="state" warn>
        Codex does not offer this model. Running{" "}
        <strong>{modelLabel(resolution.model, models)}</strong> (automatic)
        until it does.
      </Line>,
    );
  } else {
    lines.push(
      <Line key="state">
        Runs <strong>{modelLabel(resolution.model, models)}</strong>
        {savedEffort && effortOffered ? `, ${savedEffort}` : ""}.
        {savedModel
          ? ""
          : ` Automatic prefers ${HELPER_MODEL_AUTOMATIC_ORDER
            .map((id) => modelLabel(id, models))
            .join(", then ")}.`}
      </Line>,
    );
  }
  if (codex.kind === "ready" && savedEffort && !effortOffered) {
    lines.push(
      <Line key="effort" warn>
        {modelLabel(resolution?.model, models)} does not offer {savedEffort}{" "}
        reasoning. Each helper uses its own.
      </Line>,
    );
  }

  return (
    <SettingsSection
      eyebrow="Defaults"
      title="Helpers"
      sectionId="helper-model"
      description="PwrAgent uses this model for work it starts on its own, such as thread titles, task monitors and automation prompts. It does not change the model of any thread."
    >
      <div className="settings-fields">
        <SettingsField
          label="Helper model"
          sub="Runs on Codex."
          control={
            <div className="settings-provider-defaults__selectors">
              <Select
                aria-label="Helper model"
                className={PICKER_CLASS}
                disabled={props.saving}
                value={savedModel ?? ""}
                options={[
                  {
                    value: "",
                    label: automaticLabel ? `Automatic (${automaticLabel})` : "Automatic",
                  },
                  ...(savedModel && !models.some((model) => model.id === savedModel)
                    ? [{
                        value: savedModel,
                        label: modelOffered ? savedModel : `${savedModel} (not offered)`,
                      }]
                    : []),
                  ...models.map((model) => ({
                    value: model.id,
                    label: model.label ?? model.id,
                  })),
                ]}
                onChange={(model) => {
                  const next = models.find((entry) => entry.id === model);
                  const nextEfforts = next?.reasoningEfforts
                    ?? (codex.kind === "ready" ? codex.reasoningEfforts : undefined);
                  // An effort the new model does not offer would silently
                  // fall back, so the choice goes with the old model.
                  const keepEffort =
                    savedEffort
                    && next?.supportsReasoning !== false
                    && (!nextEfforts || nextEfforts.includes(savedEffort));
                  save(withDefaults(settings, {
                    defaultModel: model || undefined,
                    defaultReasoningEffort: keepEffort ? savedEffort : undefined,
                  }));
                }}
              />
              {efforts.length > 0 || savedEffort ? (
                <Select
                  aria-label="Helper reasoning"
                  className={PICKER_CLASS}
                  disabled={props.saving}
                  value={savedEffort ?? ""}
                  options={[
                    { value: "", label: "Per helper" },
                    ...(savedEffort && !efforts.includes(savedEffort)
                      ? [{
                          value: savedEffort,
                          label: effortOffered
                            ? savedEffort
                            : `${savedEffort} (not offered)`,
                        }]
                      : []),
                    ...efforts.map((effort) => ({ value: effort, label: effort })),
                  ]}
                  onChange={(effort) => {
                    save(withDefaults(settings, {
                      defaultModel: savedModel,
                      defaultReasoningEffort: effort || undefined,
                    }));
                  }}
                />
              ) : null}
            </div>
          }
          help={
            <>
              {lines}
              <HelperOverrides
                settings={settings}
                backends={props.backends}
                catalogReading={props.catalogReading}
                disabled={props.saving}
                onClear={() => save({ ...settings, helpers: {} })}
              />
            </>
          }
        />
      </div>
    </SettingsSection>
  );
}
