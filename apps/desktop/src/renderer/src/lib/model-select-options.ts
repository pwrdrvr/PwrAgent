import { buildModelMenu, type BackendModelOption } from "@pwragent/shared";
import type { SelectOption } from "../components/Select";

export const OTHER_MODELS_GROUP = "Other models";

/**
 * A Settings model list, in the order the composer's model chip uses
 * (`buildModelMenu`): the current models, then superseded ones under
 * "Other models", then each Codex model provider's models under its name.
 * A `Select` cannot open a submenu, so Other is a titled group instead.
 */
export function modelSelectOptions(params: {
  /** Backend id, such as "codex", "claude" or "acp:<id>". */
  kind: string | undefined;
  models: readonly BackendModelOption[];
  /** The stored value of a model's row. Defaults to its id. */
  valueFor?: (model: BackendModelOption) => string;
}): SelectOption[] {
  const valueFor = params.valueFor ?? ((model: BackendModelOption) => model.id);
  const row = (model: BackendModelOption, group?: string): SelectOption => ({
    value: valueFor(model),
    label: model.label ?? model.id,
    ...(group ? { group } : {}),
  });
  const menu = buildModelMenu({ kind: params.kind, models: params.models });
  return [
    ...menu.primary.map((model) => row(model)),
    ...menu.other.map((model) => row(model, OTHER_MODELS_GROUP)),
    ...menu.providerGroups.flatMap((group) =>
      group.models.map((model) => row(model, group.label))
    ),
  ];
}
