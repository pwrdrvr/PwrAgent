import {
  automaticProviderMonitorModel,
  type DesktopHelperModelSettings,
  type DesktopTaskMonitorModelChoice,
} from "@pwragent/shared/helper-models";
import { type BackendSummary } from "@pwragent/shared/contracts/backend";
import { ModelSettingsPicker, type ModelSettingsChoice } from "../composer/ModelSettingsPicker";
import { helperModelRunningLabel } from "./HelperModelSettings";
import { SettingsField, SettingsSection } from "./SettingsLayout";

/** Picker values: "" is Automatic and every other row is a model id, so
 *  the Helper model row takes a value no provider names a model. */
const AUTOMATIC_VALUE = "";
const HELPER_VALUE = "pwragent:helper-model";

function selectedValue(choice: DesktopTaskMonitorModelChoice | undefined): string {
  if (choice?.source === "helper") return HELPER_VALUE;
  if (choice?.source === "provider" && choice.model) return choice.model;
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

  const automaticLabel = automaticModel ? `Automatic (${labelOf(automaticModel)})` : "Automatic";
  const helperRowLabel = helperLabel ? `Helper model (${helperLabel})` : "Helper model";
  const leadingOptions: ModelSettingsChoice[] = [
    { value: AUTOMATIC_VALUE, label: automaticLabel },
    { value: HELPER_VALUE, label: helperRowLabel, description: "Runs on Codex." },
    ...(savedModel && !models.some((model) => model.id === savedModel)
      ? [{
          value: savedModel,
          // Only a catalog that was read can say a model is not offered.
          label: backend?.available && models.length > 0
            ? `${savedModel} (not offered)`
            : savedModel,
        }]
      : []),
  ];
  const value = selectedValue(current);
  const pillLabel = leadingOptions.find((option) => option.value === value)?.label
    ?? labelOf(value);

  const save = (value: string): void => {
    const next = { ...props.choices };
    if (value === HELPER_VALUE) {
      next[props.backendId] = { source: "helper" };
    } else if (value !== AUTOMATIC_VALUE) {
      const model = value;
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
            <div className="settings-provider-defaults__selectors">
              <ModelSettingsPicker
                ariaLabel="Task monitors"
                disabled={props.saving}
                size="setting"
                provider={{ label: props.providerLabel }}
                model={{
                  value,
                  label: pillLabel,
                  kind: backend?.kind,
                  models,
                  leadingOptions,
                  onChange: save,
                }}
              />
            </div>
          }
        />
      </div>
    </SettingsSection>
  );
}
