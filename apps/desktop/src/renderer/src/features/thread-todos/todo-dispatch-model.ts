import type { BackendSummary, ThreadTodoModelSettings } from "@pwragent/shared";
import { formatBackendLabel } from "../../lib/backend-label";

export function formatTodoDispatchSettings(settings: ThreadTodoModelSettings, backends: BackendSummary[]): string {
  const summary = backends.find((entry) => entry.kind === settings.backend);
  const model = summary?.launchpadOptions?.models?.find((entry) => entry.id === settings.model);
  return [formatBackendLabel(settings.backend, backends), model?.label ?? settings.model ?? "Default model",
    settings.reasoningEffort].filter(Boolean).join(" · ");
}

export function todoDispatchRecentResolves(settings: ThreadTodoModelSettings, backends: BackendSummary[]): boolean {
  const backend = backends.find((entry) => entry.kind === settings.backend && entry.available && entry.capabilities.createThread);
  if (!backend) return false;
  const models = backend.launchpadOptions?.models ?? [];
  const model = settings.model ? models.find((entry) => entry.id === settings.model)
    : models.find((entry) => entry.current) ?? models[0];
  if (settings.model && !model) return false;
  if (!settings.reasoningEffort) return true;
  if (model?.supportsReasoning === false) return false;
  const efforts = model?.reasoningEfforts ?? backend.launchpadOptions?.reasoningEfforts ?? [];
  return efforts.length === 0
    || efforts.some((effort) => effort.toLowerCase() === settings.reasoningEffort!.toLowerCase());
}

/** Custom changes choose valid defaults for the new provider/model. */
export function customTodoDispatchSettings(backend: BackendSummary, modelId?: string, effort?: string): ThreadTodoModelSettings {
  const models = backend.launchpadOptions?.models ?? [];
  const model = models.find((entry) => entry.id === modelId) ?? models.find((entry) => entry.current) ?? models[0];
  const efforts = model?.supportsReasoning === false ? [] : model?.reasoningEfforts ?? backend.launchpadOptions?.reasoningEfforts ?? [];
  const reasoningEffort = efforts.includes(effort ?? "") ? effort
    : model?.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort
    : efforts.includes("high") ? "high" : efforts[0];
  return { backend: backend.kind, model: model?.id, reasoningEffort };
}
