import type { ReactNode } from "react";
import {
  HELPER_MODEL_AUTOMATIC_ORDER,
  HELPER_MODEL_DEFINITIONS,
  HELPER_MODEL_GROUPS,
  helperChoiceBackend,
  resolveHelperModel,
  type BackendModelOption,
  type BackendSummary,
  type DesktopHelperModelChoice,
  type DesktopHelperModelSettings,
  type HelperModelDefinition,
  type HelperModelId,
  type HelperModelResolution,
} from "@pwragent/shared";
import { Select, type SelectOption } from "../../components/Select";
import {
  ProviderCatalogRefreshControl,
  type ProviderCatalogRefreshController,
} from "./ProviderCatalogRefresh";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";

/** AI Providers sub-route for this page. */
export const DEFAULT_MODELS_FOCUS = "default-models";

/** The closed pickers draw as the AI Providers page's chip pills. */
const PICKER_CLASS = "settings-select settings-select--chip";

/** Extra lines a row states under its resolution. */
const HELPER_NOTES: Partial<Record<HelperModelId, { suffix?: string; note?: string }>> = {
  thread_titles: {
    suffix: " on Codex threads",
    note: "ACP threads use the thread’s own model.",
  },
  task_monitors: {
    suffix: " on Codex threads",
    note: "The agent can still ask for a model. ACP threads use the agent’s lightest model.",
  },
};

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

function sourceLabel(resolution: HelperModelResolution, backendLabel: string): string {
  switch (resolution.source) {
    case "helper_default":
      return "helper default";
    case "automatic":
      return "automatic";
    case "backend_current":
      return `${backendLabel} default`;
    default:
      return "your choice";
  }
}

function resolveRow(
  helper: HelperModelId,
  settings: DesktopHelperModelSettings,
  backend: string,
  state: BackendState,
): HelperModelResolution | undefined {
  if (state.kind !== "ready") return undefined;
  return resolveHelperModel({
    helper,
    settings,
    backend,
    models: state.models.map((model) => ({
      ...model,
      reasoningEfforts: model.reasoningEfforts ?? state.reasoningEfforts,
    })),
    catalogRead: true,
  });
}

function withHelperChoice(
  settings: DesktopHelperModelSettings,
  helper: HelperModelId,
  next: DesktopHelperModelChoice | undefined,
): DesktopHelperModelSettings {
  const helpers = { ...settings.helpers };
  if (next && (next.model || next.reasoningEffort)) {
    helpers[helper] = next;
  } else {
    delete helpers[helper];
  }
  return { ...settings, helpers };
}

function ResolutionLines(props: {
  lines: readonly { text: ReactNode; warn?: boolean }[];
}) {
  return (
    <>
      {props.lines.map((line, index) => (
        <span
          key={index}
          className={
            line.warn
              ? "settings-default-models__line settings-field__value--warn"
              : "settings-default-models__line"
          }
        >
          {line.text}
        </span>
      ))}
    </>
  );
}

function HelperDefaultField(props: {
  settings: DesktopHelperModelSettings;
  codex: BackendState;
  disabled: boolean;
  onSave: (next: DesktopHelperModelSettings) => void;
}) {
  const saved = props.settings.defaultModel;
  const models = props.codex.kind === "ready" ? props.codex.models : [];
  const automatic = resolveRow(
    "thread_titles",
    { helpers: {} },
    "codex",
    props.codex,
  );
  // Only a catalog that was read can say a model is not offered.
  const offered = saved && props.codex.kind === "ready"
    ? models.some((model) => model.id === saved)
    : true;
  const automaticLabel = modelLabel(automatic?.model, models);
  const lines: { text: ReactNode; warn?: boolean }[] = [];
  if (props.codex.kind === "loading") {
    lines.push({ text: "Checking Codex models…" });
  } else if (props.codex.kind === "unavailable") {
    lines.push({
      warn: true,
      text: "Codex is not connected. Helpers that run on Codex are skipped.",
    });
  } else if (!offered) {
    lines.push({
      warn: true,
      text: (
        <>
          Codex does not offer {saved}. Helpers on Helper default run{" "}
          <strong>{automaticLabel}</strong> (automatic).
        </>
      ),
    });
  } else if (saved) {
    lines.push({ text: <>Runs <strong>{modelLabel(saved, models)}</strong></> });
  } else if (automatic?.model) {
    lines.push({
      text: (
        <>
          Runs <strong>{automaticLabel}</strong>. Automatic prefers{" "}
          {HELPER_MODEL_AUTOMATIC_ORDER.map((id) => modelLabel(id, models)).join(", then ")}
          {" "}when Codex offers them.
        </>
      ),
    });
  }

  return (
    <SettingsField
      label="Helper default"
      sub="Picked automatically unless you choose a model."
      control={
        <div className="settings-provider-defaults__selectors">
          <Select
            aria-label="Helper default model"
            className={PICKER_CLASS}
            disabled={props.disabled}
            value={saved ?? ""}
            options={[
              {
                value: "",
                label: automaticLabel ? `Automatic (${automaticLabel})` : "Automatic",
              },
              ...(saved && !models.some((model) => model.id === saved)
                ? [{ value: saved, label: offered ? saved : `${saved} (not offered)` }]
                : []),
              ...models.map((model) => ({ value: model.id, label: model.label ?? model.id })),
            ]}
            onChange={(model) => {
              props.onSave({
                ...props.settings,
                ...(model ? { defaultModel: model } : { defaultModel: undefined }),
              });
            }}
          />
        </div>
      }
      help={<ResolutionLines lines={lines} />}
    />
  );
}

function HelperModelField(props: {
  definition: HelperModelDefinition;
  settings: DesktopHelperModelSettings;
  backends: readonly BackendSummary[];
  catalogReading: boolean;
  disabled: boolean;
  onSave: (next: DesktopHelperModelSettings) => void;
}) {
  const { definition, settings } = props;
  const helper = definition.id;
  const choice = settings.helpers[helper];
  const backend = helperChoiceBackend(helper, choice);
  const states = definition.backends.map((kind) =>
    backendState(kind, props.backends, props.catalogReading),
  );
  const state = states[definition.backends.indexOf(backend)] ?? states[0];
  const models = state.kind === "ready" ? state.models : [];
  const resolution = resolveRow(helper, settings, backend, state);
  const inherited = resolveRow(
    helper,
    withHelperChoice(settings, helper, undefined),
    definition.backends[0],
    states[0],
  );
  const effortDefault = resolveRow(
    helper,
    withHelperChoice(
      settings,
      helper,
      choice ? { ...choice, reasoningEffort: undefined } : undefined,
    ),
    backend,
    state,
  );
  const savedModel = choice?.model;
  const savedOffered = savedModel && state.kind === "ready"
    ? models.some((model) => model.id === savedModel)
    : true;
  const resolvedModel = models.find((model) => model.id === resolution?.model);
  const efforts = resolvedModel?.supportsReasoning === false
    ? []
    : resolvedModel?.reasoningEfforts
      ?? (state.kind === "ready" ? state.reasoningEfforts : undefined)
      ?? [];
  const savedEffort = choice?.reasoningEffort;
  const inheritedLabel = modelLabel(
    inherited?.model,
    states[0].kind === "ready" ? states[0].models : [],
  );
  const optionValue = (index: number, id: string) => `${index}:${id}`;
  const notes = HELPER_NOTES[helper];

  const lines: { text: ReactNode; warn?: boolean }[] = [];
  if (state.kind === "loading") {
    lines.push({ text: `Checking ${state.label} models…` });
  } else if (state.kind === "unavailable") {
    lines.push({
      warn: true,
      text: `${state.label} is not connected. Helpers that run on ${state.label} are skipped.`,
    });
  } else if (resolution?.unavailableHelperModel) {
    lines.push({
      warn: true,
      text: (
        <>
          {state.label} does not offer this model. Running{" "}
          <strong>{modelLabel(resolution.model, models)}</strong> (
          {sourceLabel(resolution, state.label)}) until it does.
        </>
      ),
    });
  } else if (
    resolution?.unavailableDefaultModel
    && resolution.source !== "helper"
    && resolution.source !== "requested"
  ) {
    lines.push({
      warn: true,
      text: (
        <>
          Helper default is not offered. Running{" "}
          <strong>{modelLabel(resolution.model, models)}</strong> (
          {sourceLabel(resolution, state.label)}).
        </>
      ),
    });
  } else if (resolution?.model) {
    lines.push({
      text: (
        <>
          Runs <strong>{modelLabel(resolution.model, models)}</strong>
          {resolution.reasoningEffort ? `, ${resolution.reasoningEffort}` : ""}
          {notes?.suffix ?? ""}
        </>
      ),
    });
  } else {
    lines.push({ warn: true, text: `${state.label} offers no models.` });
  }
  if (notes?.note && state.kind !== "unavailable") {
    lines.push({ text: notes.note });
  }

  const modelValue = savedModel
    ? optionValue(definition.backends.indexOf(backend), savedModel)
    : "";
  // A helper that can run on more than one backend names the backend in
  // each option, since the list has no group headings.
  const multiBackend = definition.backends.length > 1;
  const modelOptions: SelectOption[] = [
    {
      value: "",
      label: inheritedLabel ? `Helper default (${inheritedLabel})` : "Helper default",
    },
  ];
  definition.backends.forEach((kind, index) => {
    const groupState = states[index];
    const prefix = multiBackend ? `${groupState.label} · ` : "";
    const groupModels = groupState.kind === "ready" ? groupState.models : [];
    if (
      savedModel
      && kind === backend
      && !groupModels.some((model) => model.id === savedModel)
    ) {
      modelOptions.push({
        value: optionValue(index, savedModel),
        label: `${prefix}${savedModel}${savedOffered ? "" : " (not offered)"}`,
      });
    }
    for (const model of groupModels) {
      modelOptions.push({
        value: optionValue(index, model.id),
        label: `${prefix}${model.label ?? model.id}`,
      });
    }
  });

  return (
    <SettingsField
      label={definition.label}
      sub={definition.description}
      control={
        <div className="settings-provider-defaults__selectors">
          <Select
            aria-label={`${definition.label} model`}
            className={PICKER_CLASS}
            disabled={props.disabled}
            value={modelValue}
            options={modelOptions}
            onChange={(value) => {
              if (!value) {
                props.onSave(withHelperChoice(
                  settings,
                  helper,
                  savedEffort ? { reasoningEffort: savedEffort } : undefined,
                ));
                return;
              }
              const separator = value.indexOf(":");
              const index = Number(value.slice(0, separator));
              const model = value.slice(separator + 1);
              const nextBackend = definition.backends[index] ?? definition.backends[0];
              const nextState = states[index];
              const nextModel = nextState?.kind === "ready"
                ? nextState.models.find((entry) => entry.id === model)
                : undefined;
              const nextEfforts = nextModel?.reasoningEfforts
                ?? (nextState?.kind === "ready" ? nextState.reasoningEfforts : undefined);
              const keepEffort =
                savedEffort
                && nextBackend === backend
                && (!nextEfforts || nextEfforts.includes(savedEffort));
              props.onSave(withHelperChoice(settings, helper, {
                ...(index > 0 ? { backend: nextBackend } : {}),
                model,
                ...(keepEffort ? { reasoningEffort: savedEffort } : {}),
              }));
            }}
          />
          {efforts.length > 0 || savedEffort ? (
            <Select
              aria-label={`${definition.label} reasoning`}
              className={PICKER_CLASS}
              disabled={props.disabled}
              value={savedEffort ?? ""}
              options={[
                {
                  value: "",
                  label: effortDefault?.reasoningEffort
                    ? `Default (${effortDefault.reasoningEffort})`
                    : "Default",
                },
                ...(savedEffort && !efforts.includes(savedEffort)
                  ? [{
                      value: savedEffort,
                      label: state.kind === "ready"
                        ? `${savedEffort} (not offered)`
                        : savedEffort,
                    }]
                  : []),
                ...efforts.map((effort) => ({ value: effort, label: effort })),
              ]}
              onChange={(effort) => {
                props.onSave(withHelperChoice(settings, helper, {
                  ...(choice?.backend ? { backend: choice.backend } : {}),
                  ...(savedModel ? { model: savedModel } : {}),
                  ...(effort ? { reasoningEffort: effort } : {}),
                }));
              }}
            />
          ) : null}
        </div>
      }
      help={<ResolutionLines lines={lines} />}
    />
  );
}

/**
 * Settings → AI Providers → Default Models: one row per model turn PwrAgent
 * starts on its own, the model it will run, and a picker to change it. Main
 * resolves every helper through the same `resolveHelperModel`, so the line
 * under each row names what the next helper turn uses.
 */
export function DefaultModelsSettings(props: {
  backends: readonly BackendSummary[];
  settings: DesktopHelperModelSettings;
  catalogRefresh: ProviderCatalogRefreshController;
  catalogReading: boolean;
  catalogError?: string;
  saving: boolean;
  onSave: (next: DesktopHelperModelSettings) => Promise<unknown>;
}) {
  const codex = backendState("codex", props.backends, props.catalogReading);
  const save = (next: DesktopHelperModelSettings): void => {
    void props.onSave(next);
  };

  return (
    <SettingsSectionStack
      paneId="models-default-models"
      aria-label="Default model settings"
    >
      <SettingsPanelHead
        eyebrow="AI Providers"
        title="Default Models"
        help="Models PwrAgent uses for work it starts on its own. Threads you start use New thread defaults on the AI Providers page."
      />
      <SettingsSection
        eyebrow="Helpers"
        title="Helper default"
        description="Every helper below that is left on Helper default uses this model."
      >
        <div className="settings-fields">
          <HelperDefaultField
            settings={props.settings}
            codex={codex}
            disabled={props.saving}
            onSave={save}
          />
          <SettingsField
            label="Model catalog"
            sub={
              props.catalogError
                ? `Last refresh failed: ${props.catalogError}`
                : "Refresh every provider after installing or upgrading a CLI."
            }
            control={
              <ProviderCatalogRefreshControl
                controller={props.catalogRefresh}
                disabled={props.catalogReading || props.saving}
              />
            }
          />
        </div>
      </SettingsSection>
      {HELPER_MODEL_GROUPS.map((group) => (
        <SettingsSection
          key={group.id}
          eyebrow={group.eyebrow}
          title={group.title}
          description={group.description}
        >
          <div className="settings-fields">
            {HELPER_MODEL_DEFINITIONS
              .filter((definition) => definition.group === group.id)
              .map((definition) => (
                <HelperModelField
                  key={definition.id}
                  definition={definition}
                  settings={props.settings}
                  backends={props.backends}
                  catalogReading={props.catalogReading}
                  disabled={props.saving}
                  onSave={save}
                />
              ))}
          </div>
        </SettingsSection>
      ))}
    </SettingsSectionStack>
  );
}
