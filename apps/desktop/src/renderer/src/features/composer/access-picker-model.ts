import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import {
  orderProviderAccessOptions,
  providerAccessOptionTier,
  type ProviderAccessTier,
} from "@pwragent/shared/provider-access-levels";
import type {
  ProviderAccessControl,
  ProviderAccessModeOption,
} from "@pwragent/shared/provider-access-mode";
import { describeExecutionModeForBackend } from "../../lib/execution-mode";

/** One stop on the Access level bar. */
export type AccessStop = {
  option: ProviderAccessModeOption;
  /** The name in the trigger, the level heading and the description. */
  label: string;
  /** The shorter name under the stop. */
  tick: string;
  disabled: boolean;
  reason?: string;
};

/**
 * The option's name without the redundant "Access" on Default: the trigger
 * reads "Access: Default". Full Access keeps its name, which is the warning.
 */
export function accessLevelLabel(option: ProviderAccessModeOption): string {
  return option.kind === "execution" && option.executionMode === "default" ? "Default" : option.label;
}

function accessTickLabel(option: ProviderAccessModeOption, label: string): string {
  if (option.executionMode === "full-access" && option.kind === "execution") return "Full";
  if (/^accept edits$/i.test(label)) return "Edits";
  return label;
}

/**
 * The bar's stops: every option `resolveProviderAccessControl` lists, in
 * order of how much each lets the agent do. An option that cannot be chosen
 * is still a stop, drawn disabled with its reason.
 */
export function accessStops(control: ProviderAccessControl): AccessStop[] {
  return orderProviderAccessOptions(control.options).map((option) => {
    const label = accessLevelLabel(option);
    const disabled = !option.available;
    const reason = option.kind === "execution" ? option.unavailableReason : undefined;
    return {
      option,
      label,
      tick: accessTickLabel(option, label),
      disabled,
      ...(disabled ? { reason: reason ?? `${label} is unavailable.` } : {}),
    };
  });
}

const TIER_DESCRIPTIONS: Readonly<Record<ProviderAccessTier, string>> = {
  plan: "Reads and proposes only. Nothing is edited or run.",
  default: "Asks you to approve edits and commands.",
  edits: "Edits files without asking. Commands still ask first.",
  auto: "The agent decides routine permission requests.",
  full: "Runs without permission prompts.",
};

/**
 * The sentence under the bar. Codex and Claude describe their own modes; an
 * agent's mode uses the agent's own description when it gives one.
 */
export function describeAccessOption(
  option: ProviderAccessModeOption,
  backend: AppServerBackendKind | undefined,
): string | undefined {
  if (option.kind === "execution") {
    if (!option.available && option.unavailableReason) return option.unavailableReason;
    if (backend === "codex" || backend === "claude") {
      return describeExecutionModeForBackend(backend, option.executionMode);
    }
  } else if (option.description) {
    return option.description;
  }
  const tier = providerAccessOptionTier(option);
  return tier ? TIER_DESCRIPTIONS[tier] : undefined;
}

/** How much of the trigger's shield is filled. */
export type AccessShieldLevel = "empty" | "low" | "half" | "full";

/**
 * The shield's fill for the chosen stop. It rises with the level: Plan is an
 * empty outline, Default a low fill, Accept Edits and Auto half, and Full
 * Access solid. With only two stops the lower one is empty, so the two
 * levels read as empty and full.
 */
export function accessShieldLevel(
  stops: readonly AccessStop[],
  chosen: ProviderAccessModeOption | undefined,
): AccessShieldLevel {
  const tier = chosen ? providerAccessOptionTier(chosen) ?? "default" : "default";
  if (tier === "full") return "full";
  if (tier === "plan") return "empty";
  if (stops.length === 2 && stops[0]?.option.value === chosen?.value) return "empty";
  return tier === "default" ? "low" : "half";
}

/** The picker's own state: a stop shown on the bar but not yet committed. */
export type AccessPickerState = { pending?: string };

export type AccessPickerEvent =
  | { type: "choose"; value: string }
  | { type: "allow" }
  | { type: "cancel" };

export type AccessPickerCommit = { value: string; confirmed: boolean };

/**
 * One step of the picker. Choosing a stop that needs confirmation only shows
 * it, with Allow and Cancel; the level changes when Allow commits it as
 * confirmed. A disabled stop, or the current one, commits nothing.
 */
export function stepAccessPicker(
  state: AccessPickerState,
  event: AccessPickerEvent,
  context: {
    stops: readonly AccessStop[];
    value: string;
    needsConfirmation: (option: ProviderAccessModeOption) => boolean;
  },
): { state: AccessPickerState; commit?: AccessPickerCommit } {
  const stopFor = (value: string | undefined) =>
    value === undefined ? undefined : context.stops.find((stop) => stop.option.value === value);
  switch (event.type) {
    case "choose": {
      const stop = stopFor(event.value);
      if (!stop || stop.disabled) return { state };
      if (stop.option.value === context.value) return { state: {} };
      if (context.needsConfirmation(stop.option)) return { state: { pending: stop.option.value } };
      return { state: {}, commit: { value: stop.option.value, confirmed: false } };
    }
    case "allow": {
      const stop = stopFor(state.pending);
      if (!stop || stop.disabled || stop.option.value === context.value) return { state: {} };
      return { state: {}, commit: { value: stop.option.value, confirmed: true } };
    }
    case "cancel":
      return { state: {} };
  }
}
