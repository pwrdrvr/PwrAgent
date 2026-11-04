import type { ComponentProps } from "react";
import {
  buildModelMenu,
  formatModelOptionLabel,
  type BackendModelOption,
  type BackendSummary,
} from "@pwragent/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import {
  ComposerDropdown,
  type ComposerDropdownGroup,
  type ComposerDropdownOption,
} from "./ComposerDropdown";

export function modelDropdownOption(model: BackendModelOption): ComposerDropdownOption {
  return {
    label: model.label ?? model.id,
    ...(model.providerLabel ? { selectedLabel: formatModelOptionLabel(model) } : {}),
    value: model.id,
  };
}

type ComposerDropdownProps = ComponentProps<typeof ComposerDropdown>;

/**
 * The model chip. Every surface that offers a model uses it, so each one
 * lists the same models in the same order: the current models, an Other
 * entry holding superseded ones, then each Codex model provider's models
 * under that provider's title (`buildModelMenu`).
 */
export function ModelDropdown(
  props: Omit<
    ComposerDropdownProps,
    "groups" | "kind" | "options" | "optionsLabel" | "otherLabel" | "otherOptions"
  > & {
    kind: BackendSummary["kind"] | undefined;
    models: readonly BackendModelOption[];
    /** Set when the choice changes an existing thread; see `buildModelMenu`. */
    thread?: { model?: string };
    /** Rows before the catalog, such as Inherit or a model it no longer lists. */
    leadingOptions?: ComposerDropdownOption[];
    /** Shown when the catalog is empty, so the chip still names a choice. */
    emptyOptions?: ComposerDropdownOption[];
  },
) {
  const {
    emptyOptions,
    kind,
    leadingOptions = [],
    models,
    thread,
    ...dropdown
  } = props;
  const menu = buildModelMenu({ kind, models, thread });
  const groups: ComposerDropdownGroup[] = menu.providerGroups.map((group) => ({
    label: group.label,
    options: group.models.map(modelDropdownOption),
  }));
  const options = [...leadingOptions, ...menu.primary.map(modelDropdownOption)];
  return (
    <ComposerDropdown
      {...dropdown}
      options={models.length === 0 && emptyOptions ? emptyOptions : options}
      optionsLabel={kind ? formatBackendLabel(kind) : undefined}
      groups={groups}
      otherOptions={menu.other.map(modelDropdownOption)}
      otherLabel={kind === "claude" ? "Other Models" : undefined}
    />
  );
}
