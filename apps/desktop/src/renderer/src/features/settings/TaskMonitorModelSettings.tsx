import {
  automaticProviderMonitorModel,
  type BackendSummary,
  type DesktopHelperModelSettings,
  type DesktopTaskMonitorModelChoice,
} from "@pwragent/shared";
import { Select, type SelectOption } from "../../components/Select";
import { helperModelRunningLabel } from "./HelperModelSettings";
import { SettingsField, SettingsSection } from "./SettingsLayout";

/** The closed picker draws as the AI Providers page's chip pills. */
const PICKER_CLASS = "settings-select settings-select--chip";

/** Select values: "" is Automatic; provider models carry a prefix so no
 *  model id can collide with the Helper model entry. */
const AUTOMATIC_VALUE = "";
const HELPER_VALUE = "helper";
const MODEL_VALUE_PREFIX = "model:";

function selectedValue(choice: DesktopTaskMonitorModelChoice | undefined): string {
  if (choice?.source === "helper") return HELPER_VALUE;
  if (choice?.source === "provider" && choice.model) {
    return `${MODEL_VALUE_PREFIX}${choice.model}`;
  }
  return AUTOMATIC_VALUE;
}

/**
 * One provider page's Task monitors row: which model runs the monitors that
 * this provider's threads start. Automatic picks the provider's own
 * lightweight model; Helper model runs them on Codex.
 */
export function TaskMonitorModelSettings(props: {
  /** Backend id the choice is keyed by: "claude" or "acp:<id>". */
  backendId: string;
  providerLabel: string;
  backends: readonly BackendSummary[];
  helperModels: DesktopHelperModelSettings;
  choices: Record<string, DesktopTaskMonitorModelChoice>;
  catalogReading: boolean;
  saving: boolean;
  onSave: (
    taskMonitorModels: Record<string, DesktopTaskMonitorModelChoice>,
  ) => Promise<unknown>;
}) {
  const backend = props.backends.find((candidate) => candidate.kind === props.backendId);
  const models = backend?.launchpadOptions?.models ?? [];
  const labelOf = (id: string): string =>
    models.find((model) => model.id === id)?.label ?? id;
  const current = props.choices[props.backendId];
  const savedModel = current?.source === "provider" ? current.model : undefined;
  const automaticModel = automaticProviderMonitorModel(models);
  const helperLabel = helperModelRunningLabel(
    props.helperModels,
    props.backends,
    props.catalogReading,
  );

  const options: SelectOption[] = [
    {
      value: AUTOMATIC_VALUE,
      label: automaticModel ? `Automatic (${labelOf(automaticModel)})` : "Automatic",
    },
    {
      value: HELPER_VALUE,
      label: helperLabel ? `Helper model (${helperLabel})` : "Helper model",
    },
    ...(savedModel && !models.some((model) => model.id === savedModel)
      ? [{
          value: `${MODEL_VALUE_PREFIX}${savedModel}`,
          // Only a catalog that was read can say a model is not offered.
          label: backend?.available && models.length > 0
            ? `${savedModel} (not offered)`
            : savedModel,
        }]
      : []),
    ...models.map((model) => ({
      value: `${MODEL_VALUE_PREFIX}${model.id}`,
      label: model.label ?? model.id,
    })),
  ];

  const save = (value: string): void => {
    const next = { ...props.choices };
    if (value === HELPER_VALUE) {
      next[props.backendId] = { source: "helper" };
    } else if (value.startsWith(MODEL_VALUE_PREFIX)) {
      const model = value.slice(MODEL_VALUE_PREFIX.length);
      // A saved effort belongs to its model; keep it only when the model stays.
      const reasoningEffort =
        savedModel === model ? current?.reasoningEffort : undefined;
      next[props.backendId] = {
        source: "provider",
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      };
    } else {
      delete next[props.backendId];
    }
    void props.onSave(next);
  };

  return (
    <SettingsSection
      eyebrow="Defaults"
      title="Task monitors"
      sectionId="task-monitor-model"
      description={`Model for monitors that ${props.providerLabel} threads start to wait on CI and long jobs.`}
    >
      <div className="settings-fields">
        <SettingsField
          label="Monitor model"
          sub={current?.source === "helper" ? "Runs on Codex." : `Runs on ${props.providerLabel}.`}
          control={
            <Select
              aria-label="Task monitors"
              className={PICKER_CLASS}
              disabled={props.saving}
              value={selectedValue(current)}
              options={options}
              onChange={save}
            />
          }
        />
      </div>
    </SettingsSection>
  );
}
