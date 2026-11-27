import type { BackendAcpRuntimeCapabilities } from "@pwragent/shared/contracts/backend";
import { acpRuntimeModeSelector, formatAcpRuntimeModeLabel } from "@pwragent/shared/acp-permission-mode";
import type {
  ProviderAccessControl,
  ProviderAccessModeOption,
} from "@pwragent/shared/provider-access-mode";
import {
  sameThreadTodoAccessOption,
  type ThreadTodoAccessOption,
  type ThreadTodoStartAccess,
} from "@pwragent/shared/thread-todo-access";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import type { AccessLevelRef } from "../composer/access-picker-model";

/** A start card's access as the access picker reads it, and the way back to the card's options. */
export type TodoAccessControl = {
  control: ProviderAccessControl;
  /** The card's option behind a picker option, by the picker's value. */
  optionFor: (value: string) => ThreadTodoAccessOption | undefined;
  /**
   * The level the new thread starts at, for the shield. Read from the
   * resolved access rather than the stops: a card that cannot be changed
   * here lists none, and still starts at its own level.
   */
  level?: AccessLevelRef;
};

/**
 * A start card's access options as the provider access control the
 * composer's picker draws, so the card offers the same shield and level bar.
 * The options and the selection stay `resolveThreadTodoStartAccess`'s: this
 * only renames them. A PwrAgent mode keeps its mode as its value and an
 * agent's mode its id, as the composer's control names them; an id that
 * repeats a value already listed is prefixed so every stop stays distinct.
 * The value is empty when nothing is selected: the agent starts in its own
 * default, or the card's mode is refused.
 */
export function todoAccessControl(
  resolved: ThreadTodoStartAccess,
  runtime?: BackendAcpRuntimeCapabilities,
): TodoAccessControl {
  const selector = acpRuntimeModeSelector(runtime);
  const entries: Array<{ option: ProviderAccessModeOption; source: ThreadTodoAccessOption }> = [];
  const taken = new Set<string>();
  for (const source of resolved.options) {
    if (source.kind === "mode") {
      taken.add(source.mode);
      entries.push({
        source,
        option: {
          kind: "execution",
          value: source.mode,
          label: formatExecutionModeLabel(source.mode),
          executionMode: source.mode,
          available: true,
          requiresFullAccessConfirmation: source.mode === "full-access",
          ...(source.mode === "full-access" ? { tone: "danger" as const } : {}),
        },
      });
      continue;
    }
    const value = taken.has(source.id) ? `native:${source.id}` : source.id;
    taken.add(value);
    const executionMode = source.executionMode ?? "default";
    const description = selector?.choices.find((choice) => choice.id === source.id)?.description;
    entries.push({
      source,
      option: {
        kind: "acp",
        value,
        label: formatAcpRuntimeModeLabel(source.label),
        ...(description ? { description } : {}),
        executionMode,
        available: true,
        acpOption: {
          source: selector?.source ?? "mode",
          optionId: selector?.optionId ?? "mode",
          value: source.id,
        },
        requiresFullAccessConfirmation: executionMode === "full-access",
        ...(executionMode === "full-access" ? { tone: "danger" as const } : {}),
      },
    });
  }
  const selected = resolved.status === "ready" ? resolved.selected : undefined;
  const chosen = selected
    ? entries.find((entry) => sameThreadTodoAccessOption(entry.source, selected))
    : undefined;
  const level: AccessLevelRef | undefined = resolved.status !== "ready"
    ? undefined
    : selected?.kind === "native"
      ? { kind: "acp", value: selected.id, executionMode: selected.executionMode ?? "default" }
      : { kind: "execution", value: resolved.executionMode, executionMode: resolved.executionMode };
  return {
    ...(level ? { level } : {}),
    control: {
      kind: entries.some((entry) => entry.option.kind === "acp")
        ? entries.some((entry) => entry.option.kind === "execution") ? "hybrid-antigravity" : "acp"
        : "execution",
      ariaLabel: "Access mode",
      value: chosen?.option.value ?? "",
      selectedOption: chosen?.option,
      options: entries.map((entry) => entry.option),
    },
    optionFor: (value) => entries.find((entry) => entry.option.value === value)?.source,
  };
}
