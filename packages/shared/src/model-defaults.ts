import type { BackendLaunchpadOptions, BackendModelOption } from "./contracts/backend";
import { modelMenuEntryProviderId } from "./model-menu";

/**
 * Which model and reasoning effort a thread starts on when nothing names one,
 * and which efforts a model offers. The owner starts threads by these rules,
 * and the composer, queued sends and every messaging surface show them, so
 * all of them read one catalog the same way.
 */

export const DEFAULT_REASONING_EFFORT = "medium";

/** The model id a backend prefers when its catalog marks none current. */
export function preferredModelId(
  backend: string | undefined,
  models?: readonly BackendModelOption[],
): string {
  if (backend !== "codex") {
    return models?.find((model) => model.current)?.id ?? models?.[0]?.id ?? "";
  }

  // A new install should start on a current coding model. Registered Codex
  // model providers cannot nominate OpenAI's default through their flags.
  const ownModels = models?.filter((model) => !modelMenuEntryProviderId(model));
  for (const id of ["gpt-6.1-terra", "gpt-6.1-sol"]) {
    if (ownModels?.some((model) => model.id === id)) return id;
  }
  return ownModels?.find((model) => model.current)?.id
    ?? ownModels?.[0]?.id
    ?? "gpt-6.1-terra";
}

/** The model a thread starts on when it names none. */
export function defaultModelOption(
  backend: string | undefined,
  options: BackendLaunchpadOptions | undefined,
): BackendModelOption | undefined {
  const models = options?.models ?? [];
  if (models.length === 0) {
    return undefined;
  }

  const preferred = preferredModelId(backend, models);
  return (
    models.find((model) => model.current) ??
    models.find((model) => model.id === preferred) ??
    models.find((model) => model.supportsReasoning) ??
    models[0]
  );
}

/** The efforts a model offers: its own list, else the backend's. */
export function reasoningEffortsForModel(
  options: BackendLaunchpadOptions | undefined,
  model: BackendModelOption | undefined,
): string[] {
  return model?.reasoningEfforts ?? options?.reasoningEfforts ?? [];
}

/** The effort a thread starts at when it names none: the model's default, else Medium, else the first offered. */
export function defaultReasoningEffort(
  options: BackendLaunchpadOptions | undefined,
  model: BackendModelOption | undefined,
): string | undefined {
  const efforts = reasoningEffortsForModel(options, model);
  if (model?.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return efforts.includes(DEFAULT_REASONING_EFFORT) ? DEFAULT_REASONING_EFFORT : efforts[0];
}

/** The first candidate the model offers, else its default effort. */
export function offeredReasoningEffort(
  options: BackendLaunchpadOptions | undefined,
  model: BackendModelOption | undefined,
  candidates: ReadonlyArray<string | undefined>,
): string | undefined {
  const efforts = reasoningEffortsForModel(options, model);
  return candidates.find((candidate): candidate is string => candidate !== undefined && efforts.includes(candidate))
    ?? defaultReasoningEffort(options, model);
}
