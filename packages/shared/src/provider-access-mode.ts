import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeOptionSource,
  BackendAcpSessionRuntimeState,
  BackendSummary,
} from "./contracts/backend";
import type { ThreadExecutionMode } from "./contracts/normalized-app-server";
import {
  ACP_PERMISSION_MODE_OPTION_ID,
  acpRuntimeModeIsFullAccess,
  acpRuntimeModeSelector,
  acpRuntimeModeValue,
  formatAcpRuntimeModeLabel,
} from "./acp-permission-mode";

/** An ACP runtime option paired with a provider access mode choice. */
export type ProviderAccessAcpOption = {
  source: BackendAcpRuntimeOptionSource;
  optionId: string;
  value: string;
};

/** One selectable option in a provider's single access/mode control. */
export type ProviderAccessModeOption =
  | {
      kind: "execution";
      value: ThreadExecutionMode;
      label: string;
      executionMode: ThreadExecutionMode;
      available: boolean;
      unavailableReason?: string;
      /**
       * For hybrid providers like Antigravity whose process-level modes also
       * select/reset an underlying ACP runtime mode (such as "default").
       */
      acpOption?: ProviderAccessAcpOption;
      requiresFullAccessConfirmation: boolean;
      tone?: "danger";
    }
  | {
      kind: "acp";
      value: string;
      label: string;
      description?: string;
      /** PwrAgent execution mode envelope this option runs under. */
      executionMode: ThreadExecutionMode;
      available: true;
      acpOption: ProviderAccessAcpOption;
      requiresFullAccessConfirmation: boolean;
      tone?: "danger";
    };

/**
 * The single access/mode control for a provider, shared by the desktop
 * composer, Star Map chat card, to-do cards, and messaging surfaces so no
 * provider ever renders two overlapping access/mode controls.
 */
export type ProviderAccessControl = {
  kind: "execution" | "acp" | "hybrid-antigravity";
  ariaLabel: "Access mode" | "Agent mode";
  value: string;
  selectedOption: ProviderAccessModeOption | undefined;
  options: ProviderAccessModeOption[];
};

export function formatProviderExecutionModeLabel(
  mode?: ThreadExecutionMode,
): string {
  return mode === "auto"
    ? "Auto"
    : mode === "full-access"
      ? "Full Access"
      : "Default Access";
}

/**
 * Resolves the single access/mode control for any backend summary and current
 * state. Guarantees at most one control per provider:
 *
 * 1. `acp:antigravity` with listed PwrAgent `executionModes` merges its
 *    process-level modes (`Default Access`, `Full Access`) with its non-default,
 *    non-yolo native ACP modes (`Accept Edits`, `Auto`, `Plan`) into ONE list.
 * 2. Any other provider with listed `executionModes` (`codex`, `claude`, legacy
 *    slash-controlled `kimi`/`grok`) surfaces only those PwrAgent modes.
 * 3. A provider with empty `executionModes` surfaces its native ACP runtime
 *    mode selector (`acpRuntimeModeSelector`) when it offers at least 2 choices.
 */
export function resolveProviderAccessControl(params: {
  backend: Pick<BackendSummary, "kind" | "available" | "executionModes" | "acp"> | undefined;
  state?: {
    executionMode?: ThreadExecutionMode;
    acpRuntime?: Pick<BackendAcpSessionRuntimeState, "configValues" | "currentModeId">;
  };
  /**
   * When true (desktop composer), keep an unavailable `"auto"` mode if the
   * backend itself is available so the menu can show its disabled tooltip.
   */
  includeUnavailableAuto?: boolean;
}): ProviderAccessControl | undefined {
  const { backend, state, includeUnavailableAuto = false } = params;
  if (!backend) {
    return undefined;
  }

  const listedExecutionModes = backend.executionModes ?? [];
  if (listedExecutionModes.length > 0) {
    const filteredExecutionModes = listedExecutionModes.filter((mode) =>
      mode.available || (includeUnavailableAuto && backend.available && mode.mode === "auto"),
    );
    if (filteredExecutionModes.length === 0) {
      return undefined;
    }

    if (backend.kind === "acp:antigravity") {
      const selector = acpRuntimeModeSelector(backend.acp?.runtime);
      const usableSelector = selector && selector.choices.length >= 2 ? selector : undefined;
      const hasNativeDefault = usableSelector?.choices.some((choice) => choice.id === "default") ?? false;
      const defaultAcpOption: ProviderAccessAcpOption | undefined = usableSelector && hasNativeDefault
        ? {
            source: usableSelector.source,
            optionId: usableSelector.optionId,
            value: "default",
          }
        : undefined;
      const defaultExec = filteredExecutionModes.find((entry) => entry.mode === "default");
      const offersAuto = filteredExecutionModes.some((entry) => entry.mode === "auto" && entry.available);

      const options: ProviderAccessModeOption[] = [];
      if (defaultExec) {
        options.push({
          kind: "execution",
          value: "default",
          label: formatProviderExecutionModeLabel("default"),
          executionMode: "default",
          available: defaultExec.available,
          ...(defaultExec.unavailableReason ? { unavailableReason: defaultExec.unavailableReason } : {}),
          ...(defaultAcpOption ? { acpOption: defaultAcpOption } : {}),
          requiresFullAccessConfirmation: false,
        });
      }
      if (defaultExec?.available && usableSelector) {
        for (const choice of usableSelector.choices) {
          if (
            choice.id === "default"
            || choice.id === "full-access"
            || acpRuntimeModeIsFullAccess(choice.id)
            || (choice.id === "auto" && offersAuto)
          ) {
            continue;
          }
          options.push({
            kind: "acp",
            value: choice.id,
            label: formatAcpRuntimeModeLabel(choice.label),
            ...(choice.description ? { description: choice.description } : {}),
            executionMode: "default",
            available: true,
            acpOption: {
              source: usableSelector.source,
              optionId: usableSelector.optionId,
              value: choice.id,
            },
            requiresFullAccessConfirmation: false,
          });
        }
      }
      for (const entry of filteredExecutionModes) {
        if (entry.mode === "default") {
          continue;
        }
        options.push({
          kind: "execution",
          value: entry.mode,
          label: formatProviderExecutionModeLabel(entry.mode),
          executionMode: entry.mode,
          available: entry.available,
          ...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {}),
          ...(entry.mode === "full-access" && defaultAcpOption ? { acpOption: defaultAcpOption } : {}),
          requiresFullAccessConfirmation: entry.mode === "full-access",
          ...(entry.mode === "full-access" ? { tone: "danger" as const } : {}),
        });
      }

      const effectiveExec = state?.executionMode ?? "default";
      let value: string;
      if (
        effectiveExec !== "default"
        && options.some((option) => option.kind === "execution" && option.value === effectiveExec)
      ) {
        value = effectiveExec;
      } else if (usableSelector && defaultExec?.available) {
        const recordedNative = usableSelector.source === "mode"
          ? state?.acpRuntime?.currentModeId
          : (usableSelector.optionId !== ACP_PERMISSION_MODE_OPTION_ID
              && state?.acpRuntime?.currentModeId
              && usableSelector.choices.some((choice) => choice.id === state.acpRuntime?.currentModeId)
              ? state.acpRuntime.currentModeId
              : undefined)
            ?? state?.acpRuntime?.configValues?.[usableSelector.optionId];
        const effectiveNative = recordedNative ?? usableSelector.currentValue;
        const nativeMatch = effectiveNative
          ? options.find((option) => option.kind === "acp" && option.value === effectiveNative)
          : undefined;
        value = nativeMatch?.value
          ?? (options.some((option) => option.value === "default")
            ? "default"
            : options[0]?.value ?? "default");
      } else {
        value = options.find((option) => option.kind === "execution" && option.executionMode === effectiveExec)?.value
          ?? options[0]?.value
          ?? effectiveExec;
      }

      return {
        kind: "hybrid-antigravity",
        ariaLabel: "Access mode",
        value,
        selectedOption: options.find((option) => option.value === value),
        options,
      };
    }

    const options: ProviderAccessModeOption[] = filteredExecutionModes.map((entry) => ({
      kind: "execution",
      value: entry.mode,
      label: formatProviderExecutionModeLabel(entry.mode),
      executionMode: entry.mode,
      available: entry.available,
      ...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {}),
      requiresFullAccessConfirmation: entry.mode === "full-access",
      ...(entry.mode === "full-access" ? { tone: "danger" as const } : {}),
    }));
    const requested = state?.executionMode ?? "default";
    const value = options.some((option) => option.value === requested)
      ? requested
      : requested;
    return {
      kind: "execution",
      ariaLabel: "Access mode",
      value,
      selectedOption: options.find((option) => option.value === value),
      options,
    };
  }

  const selector = acpRuntimeModeSelector(backend.acp?.runtime);
  if (!selector || selector.choices.length < 2) {
    return undefined;
  }
  const options: ProviderAccessModeOption[] = selector.choices.map((choice) => {
    const fullAccess = acpRuntimeModeIsFullAccess(choice.id);
    return {
      kind: "acp",
      value: choice.id,
      label: formatAcpRuntimeModeLabel(choice.label),
      ...(choice.description ? { description: choice.description } : {}),
      executionMode: fullAccess ? "full-access" : "default",
      available: true,
      acpOption: {
        source: selector.source,
        optionId: selector.optionId,
        value: choice.id,
      },
      requiresFullAccessConfirmation: false,
      ...(fullAccess ? { tone: "danger" as const } : {}),
    };
  });
  const value = acpRuntimeModeValue(selector, state?.acpRuntime) ?? options[0]?.value ?? "";
  return {
    kind: "acp",
    ariaLabel: "Agent mode",
    value,
    selectedOption: options.find((option) => option.value === value),
    options,
  };
}

/**
 * Applies an ACP runtime option pick onto an existing session/launchpad
 * `acpRuntime` state without clobbering unrelated config values.
 */
export function applyProviderAccessAcpOptionToRuntime(
  currentAcpRuntime: BackendAcpSessionRuntimeState | undefined,
  acpOption: ProviderAccessAcpOption,
): BackendAcpSessionRuntimeState {
  return {
    ...currentAcpRuntime,
    configValues:
      acpOption.source === "configOption"
        ? {
            ...(currentAcpRuntime?.configValues ?? {}),
            [acpOption.optionId]: acpOption.value,
          }
        : currentAcpRuntime?.configValues,
    currentModeId:
      acpOption.source === "mode"
        ? acpOption.value
        : acpOption.optionId === ACP_PERMISSION_MODE_OPTION_ID
          ? currentAcpRuntime?.currentModeId
          : undefined,
  };
}

/**
 * Produces the atomic launchpad patch for selecting any `ProviderAccessModeOption`.
 * Guarantees hybrid Antigravity picks always update both `executionMode` and
 * `acpRuntime` together (never leaving `full-access` behind a native mode or
 * leaving `plan` behind `full-access`).
 */
export function launchpadPatchForProviderAccessOption(params: {
  option: ProviderAccessModeOption;
  currentAcpRuntime?: BackendAcpSessionRuntimeState;
}): {
  executionMode: ThreadExecutionMode;
  acpRuntime?: BackendAcpSessionRuntimeState;
} {
  const { option, currentAcpRuntime } = params;
  if (!option.acpOption) {
    return { executionMode: option.executionMode };
  }
  return {
    executionMode: option.executionMode,
    acpRuntime: applyProviderAccessAcpOptionToRuntime(currentAcpRuntime, option.acpOption),
  };
}

/**
 * Explicit canonical state of a live Antigravity thread's access mode.
 *
 * Full Access targets always select native Default. A stored, applied state
 * can retain a legacy mode until the owner confirms Default with the worker.
 */
export type AntigravityAccessState = {
  executionMode: "default" | "full-access";
  nativeMode: string;
};

export function normalizeAntigravityAccessTarget(requested: {
  executionMode: ThreadExecutionMode;
  nativeMode?: string;
}): AntigravityAccessState {
  if (requested.executionMode === "full-access") {
    return { executionMode: "full-access", nativeMode: "default" };
  }
  const trimmed = requested.nativeMode?.trim();
  const nativeMode = trimmed && !acpRuntimeModeIsFullAccess(trimmed) && trimmed !== "full-access"
    ? trimmed
    : "default";
  return { executionMode: "default", nativeMode };
}

export function sameAntigravityAccessState(
  left: AntigravityAccessState | undefined,
  right: AntigravityAccessState | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.executionMode === right.executionMode && left.nativeMode === right.nativeMode;
}

export function readAppliedAntigravityAccessState(params: {
  executionMode?: ThreadExecutionMode;
  acpRuntime?: Pick<BackendAcpSessionRuntimeState, "configValues" | "currentModeId">;
  capabilities?: BackendAcpRuntimeCapabilities;
}): AntigravityAccessState {
  if (params.executionMode === "full-access") {
    // Report the saved mode to the transition planner so a Full Access
    // selection can reconcile a cold legacy session instead of no-oping.
    const nativeMode = params.acpRuntime?.configValues?.mode ?? params.acpRuntime?.currentModeId ?? "default";
    return { executionMode: "full-access", nativeMode };
  }
  const selector = acpRuntimeModeSelector(params.capabilities);
  const nativeMode = selector
    ? acpRuntimeModeValue(selector, params.acpRuntime)
    : params.acpRuntime?.currentModeId ?? params.acpRuntime?.configValues?.mode;
  return normalizeAntigravityAccessTarget({
    executionMode: "default",
    nativeMode,
  });
}

export function formatAntigravityAccessStateLabel(
  state: AntigravityAccessState,
  capabilities?: BackendAcpRuntimeCapabilities,
): string {
  if (state.executionMode === "full-access") {
    return formatProviderExecutionModeLabel("full-access");
  }
  if (state.nativeMode === "default") {
    return formatProviderExecutionModeLabel("default");
  }
  const selector = acpRuntimeModeSelector(capabilities);
  const match = selector?.choices.find((choice) => choice.id === state.nativeMode);
  return formatAcpRuntimeModeLabel(match?.label ?? state.nativeMode);
}

/**
 * Exhaustive action set for Antigravity's single explicit access state machine.
 * Every UI or API selection resolves to exactly one of these five actions.
 */
export type AntigravityAccessTransitionAction =
  | { type: "noop" }
  | { type: "cancel_queue" }
  | { type: "queue"; target: AntigravityAccessState }
  | { type: "move_process"; target: AntigravityAccessState }
  | { type: "set_native_mode"; target: AntigravityAccessState };

/**
 * Pure explicit transition function for Antigravity's unified access state
 * machine. Eliminates dual-queue races and contradictory `(full-access, plan)`
 * states.
 */
export function planAntigravityAccessTransition(input: {
  applied: AntigravityAccessState;
  queued?: AntigravityAccessState;
  turnActive: boolean;
  requested: {
    executionMode: ThreadExecutionMode;
    nativeMode?: string;
  };
}): AntigravityAccessTransitionAction {
  const target = normalizeAntigravityAccessTarget(input.requested);

  if (sameAntigravityAccessState(target, input.applied)) {
    return input.queued ? { type: "cancel_queue" } : { type: "noop" };
  }

  if (input.turnActive) {
    if (sameAntigravityAccessState(target, input.queued)) {
      return { type: "noop" };
    }
    return { type: "queue", target };
  }

  if (target.executionMode !== input.applied.executionMode) {
    return { type: "move_process", target };
  }

  return { type: "set_native_mode", target };
}
