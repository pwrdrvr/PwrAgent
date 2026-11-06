import { codexProviderIdOfModel } from "./codex-model-providers";

/** The catalog fields the menu rule reads. */
export type ModelMenuEntry = {
  id: string;
  providerId?: string;
  providerLabel?: string;
  other?: boolean;
};

export type ModelMenuProviderGroup<T> = {
  providerId: string;
  label: string;
  models: T[];
};

/**
 * One provider's catalog arranged for a picker. `primary` is the list,
 * `other` goes behind an Other entry, and each Codex model provider's models
 * follow under that provider's title.
 */
export type ModelMenu<T> = {
  primary: T[];
  other: T[];
  providerGroups: ModelMenuProviderGroup<T>[];
};

/**
 * Which catalog entries are superseded. Nothing is hidden: an Other entry
 * stays selectable, it only moves out of the main list.
 *
 * - Claude marks its own older models with `other`.
 * - Codex: GPT-5.5 and GPT-5.6 once a GPT-6 model is offered, and GPT-6-Sol
 *   once GPT-6.1-Sol or GPT-6.1-Terra is. A catalog without the newer model
 *   keeps the older one in the list.
 * - Models served by a Codex model provider are that provider's own and are
 *   never superseded.
 */
export function splitModelMenuOptions<T extends ModelMenuEntry>(
  kind: string | undefined,
  models: readonly T[],
): { primary: T[]; other: T[] } {
  const ownModels = models.filter((model) => !model.providerId);
  const hasGpt6 = ownModels.some((model) => /^gpt-6(?:[.-]|$)/iu.test(model.id));
  const hasSolReplacement = ownModels.some((model) => /^gpt-6\.1-(?:sol|terra)$/iu.test(model.id));
  const primary: T[] = [];
  const other: T[] = [];
  for (const model of models) {
    const isOther = kind === "claude"
      ? model.other
      : kind === "codex" && !model.providerId && (
        (hasGpt6 && /^gpt-5\.(?:5|6)(?:-|$)/iu.test(model.id))
        || (hasSolReplacement && /^gpt-6-sol$/iu.test(model.id))
      );
    (isOther ? other : primary).push(model);
  }
  return { primary, other };
}

/** What a picker calls its Other entry. Claude's own menu says "Other Models". */
export function modelMenuOtherLabel(kind: string | undefined): string {
  return kind === "claude" ? "Other Models" : "Other";
}

/**
 * Arrange a catalog for any model picker, so every surface that offers a
 * model offers the same list in the same order.
 *
 * Pass `thread` when the choice changes an existing thread. Codex fixes a
 * thread's model provider when the thread starts, so an existing Codex
 * thread is offered only its own provider's models. Without `thread` the
 * choice starts something new, and every provider's models are offered.
 */
export function buildModelMenu<T extends ModelMenuEntry>(params: {
  kind: string | undefined;
  models: readonly T[];
  thread?: { model?: string };
}): ModelMenu<T> {
  const { kind, models } = params;
  if (params.thread && kind === "codex") {
    const provider = codexProviderIdOfModel(params.thread.model);
    const own = models.filter((model) => model.providerId === provider);
    return { ...splitModelMenuOptions(kind, own), providerGroups: [] };
  }
  const groups = new Map<string, ModelMenuProviderGroup<T>>();
  for (const model of models) {
    if (!model.providerId) continue;
    let group = groups.get(model.providerId);
    if (!group) {
      group = { providerId: model.providerId, label: model.providerLabel ?? model.providerId, models: [] };
      groups.set(model.providerId, group);
    }
    group.models.push(model);
  }
  return {
    ...splitModelMenuOptions(kind, models.filter((model) => !model.providerId)),
    providerGroups: [...groups.values()],
  };
}
