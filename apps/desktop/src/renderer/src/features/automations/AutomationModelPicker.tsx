import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { ModelSettingsPicker } from "../composer/ModelSettingsPicker";
import { splitEffortChoices } from "../composer/model-settings-picker-model";

/**
 * The automation's run provider, model and reasoning, as one model pill.
 * Each blank value inherits the Agent's at run time. A model belongs to one
 * provider's catalog and an effort to one model, so a change drops a choice
 * the new catalog or model does not offer rather than sending it anyway.
 */
export function AutomationModelPicker(props: {
  /** The Agent chosen in Deliver, which blank values inherit from. */
  agentBackend: AppServerBackendKind | undefined;
  agentModel: string | undefined;
  agentReasoning: string | undefined;
  backendCatalog: readonly BackendSummary[] | undefined;
  backend: "" | AppServerBackendKind;
  model: string;
  reasoning: string;
  onBackend: (backend: "" | AppServerBackendKind) => void;
  onModel: (model: string) => void;
  onReasoning: (reasoning: string) => void;
}) {
  const { backendCatalog, agentBackend, model, reasoning } = props;
  const labelFor = (kind: AppServerBackendKind | undefined): string =>
    kind
      ? backendCatalog?.find((backend) => backend.kind === kind)?.label ?? kind
      : "";
  const effectiveKind = props.backend || agentBackend;
  const effective = backendCatalog?.find((backend) => backend.kind === effectiveKind);
  const catalogModels = effective?.launchpadOptions?.models ?? [];
  const selected = catalogModels.find((entry) => entry.id === model);
  const reasoningChoices = selected?.reasoningEfforts ?? effective?.launchpadOptions?.reasoningEfforts ?? [];

  return (
    <ModelSettingsPicker
      ariaLabel="Automation model"
      size="setting"
      provider={{
        label: labelFor(props.backend || undefined) || "Inherit Agent provider",
        showInPill: Boolean(props.backend),
        choices: {
          options: [
            {
              label: agentBackend
                ? `Inherit Agent provider (${labelFor(agentBackend)})`
                : "Inherit Agent provider",
              value: "",
            },
            ...(backendCatalog ?? [])
              .filter((backend) => backend.available || backend.kind === props.backend)
              .map((backend) => ({ label: backend.label, value: backend.kind })),
          ],
          value: props.backend,
          onChange: (value) => {
            const next = value as "" | AppServerBackendKind;
            props.onBackend(next);
            const nextKind = next || agentBackend;
            const nextModels =
              backendCatalog?.find((backend) => backend.kind === nextKind)?.launchpadOptions?.models ?? [];
            if (model && !nextModels.some((entry) => entry.id === model)) {
              props.onModel("");
              props.onReasoning("");
            }
          },
        },
      }}
      model={{
        value: model,
        label: model
          ? selected?.label
            ?? (catalogModels.length > 0 ? `${model} (not in this provider's catalog)` : model)
          : props.agentModel
            ? `Inherit (${props.agentModel})`
            : "Inherit model",
        kind: effectiveKind,
        models: catalogModels,
        disabled: !effectiveKind,
        leadingOptions: [
          {
            label: props.agentModel ? `Inherit Agent model (${props.agentModel})` : "Inherit Agent model",
            value: "",
          },
          ...(model && !catalogModels.some((entry) => entry.id === model)
            ? [{ label: `${model} (not in this provider's catalog)`, value: model }]
            : []),
        ],
        onChange: (value) => {
          props.onModel(value);
          const next = catalogModels.find((entry) => entry.id === value);
          const efforts = next?.reasoningEfforts ?? effective?.launchpadOptions?.reasoningEfforts ?? [];
          if (reasoning && !efforts.includes(reasoning)) props.onReasoning("");
        },
      }}
      effort={{
        stops: splitEffortChoices(reasoningChoices).stops,
        value: reasoning,
        defaultOption: {
          label: props.agentReasoning ? `Inherit (${props.agentReasoning})` : "Inherit",
          value: "",
        },
        disabled: !effectiveKind,
        onChange: props.onReasoning,
      }}
    />
  );
}
