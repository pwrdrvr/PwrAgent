import type { BackendLaunchpadOptions, BackendModelOption } from "@pwragent/shared";

export type ThreadTodoModelResolution =
  | { ok: true; model?: string; reasoningEffort?: string }
  | { ok: false; message: string };

/**
 * Settle a handoff card's model and reasoning effort against the backend's
 * catalog when the card is written, not when it runs. Starting a thread with
 * an id the catalog does not list falls back to the default model without a
 * word, so a card that said "GPT-6.1-Sol" would quietly run something else.
 *
 * The model may be named by id or by the label the composer shows, in any
 * case; the card stores the id. An effort is checked against the model it
 * will run on: the card's model, else the raising thread's (`threadModel`,
 * which a handoff inherits), else the backend default.
 *
 * An empty catalog (discovery has not answered, or the agent lists none)
 * cannot refute anything, so the values pass through as given.
 */
export function resolveThreadTodoModel(
  options: BackendLaunchpadOptions | undefined,
  requested: { model?: string; reasoningEffort?: string },
  threadModel?: string,
): ThreadTodoModelResolution {
  const models = options?.models ?? [];
  if (models.length === 0) {
    return { ok: true, ...requested };
  }
  let selected: BackendModelOption | undefined;
  if (requested.model) {
    selected = findModel(models, requested.model);
    if (!selected) {
      return {
        ok: false,
        message: `No model named "${requested.model}" for this backend. Available models: ${models
          .map(describeModel)
          .join(", ")}.`,
      };
    }
  }
  const model = selected?.id;
  if (!requested.reasoningEffort) {
    return { ok: true, ...(model ? { model } : {}) };
  }
  const effective = selected
    ?? models.find((entry) => entry.id === threadModel)
    ?? models.find((entry) => entry.current)
    ?? models[0]!;
  if (effective.supportsReasoning === false) {
    return {
      ok: false,
      message: `${describeModel(effective)} does not take a reasoning effort.`,
    };
  }
  const efforts = effective.reasoningEfforts ?? options?.reasoningEfforts ?? [];
  const effort = efforts.find(
    (entry) => entry.toLowerCase() === requested.reasoningEffort!.toLowerCase(),
  );
  if (efforts.length > 0 && !effort) {
    return {
      ok: false,
      message: `${describeModel(effective)} does not offer reasoning effort "${requested.reasoningEffort}". Available efforts: ${efforts.join(", ")}.`,
    };
  }
  return {
    ok: true,
    ...(model ? { model } : {}),
    reasoningEffort: effort ?? requested.reasoningEffort,
  };
}

function findModel(
  models: readonly BackendModelOption[],
  query: string,
): BackendModelOption | undefined {
  const needle = query.trim().toLowerCase();
  const loose = looseName(query);
  return models.find((model) => model.id === query.trim())
    ?? models.find((model) => model.id.toLowerCase() === needle)
    ?? models.find((model) => model.label?.toLowerCase() === needle)
    ?? models.find((model) =>
      looseName(model.id) === loose
      || (model.label !== undefined && looseName(model.label) === loose));
}

/** "GPT 6.1 Sol", "gpt-6.1-sol" and "GPT-6.1-Sol" are one name. */
function looseName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, "");
}

function describeModel(model: BackendModelOption): string {
  return model.label && model.label !== model.id
    ? `${model.id} (${model.label})`
    : model.id;
}
