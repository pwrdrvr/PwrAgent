import type {
  BackendAcpRuntimeConfigOption,
  BackendAcpRuntimeOptionSource,
  BackendAcpSessionRuntimeState,
  BackendSummary,
  ThreadExecutionMode,
} from "@pwragent/shared";
import { isAcpBackendId } from "@pwragent/shared";

export type MessagingAcpRuntimeModeChoice = {
  description?: string;
  label: string;
  optionId: string;
  privileged: boolean;
  selected: boolean;
  source: BackendAcpRuntimeOptionSource;
  value: string;
};

export type MessagingAcpRuntimeModeSummary = {
  choices: MessagingAcpRuntimeModeChoice[];
  currentLabel: string;
  currentValue?: string;
};

export function buildMessagingAcpRuntimeModeSummary(params: {
  backend?: BackendSummary;
  runtime?: BackendAcpSessionRuntimeState;
}): MessagingAcpRuntimeModeSummary {
  const backend = params.backend;
  if (!backend || !isAcpBackendId(backend.kind)) {
    return {
      choices: [],
      currentLabel: "Agent default",
    };
  }

  const runtimeCapabilities = backend.acp?.runtime;
  const modeConfigOptions =
    runtimeCapabilities?.configOptions?.filter(isRuntimeModeConfigOption) ?? [];
  const configChoices = modeConfigOptions.flatMap((option) => {
    const currentModeValue =
      params.runtime?.currentModeId &&
      option.values.some((value) => value.value === params.runtime?.currentModeId)
        ? params.runtime.currentModeId
        : undefined;
    const currentValue =
      currentModeValue ??
      params.runtime?.configValues?.[option.id] ??
      option.currentValue ??
      defaultConfigOptionValue(option);
    return option.values.map((value) => ({
      description: value.description,
      label: formatMessagingAcpRuntimeModeLabel(value.label || value.value),
      optionId: option.id,
      privileged: messagingAcpRuntimeValueLooksPrivileged(value.value),
      selected: value.value === currentValue,
      source: "configOption" as const,
      value: value.value,
    }));
  });
  if (configChoices.length > 0) {
    const selected = configChoices.find((choice) => choice.selected);
    return {
      choices: configChoices,
      currentLabel: selected?.label ?? "Agent default",
      currentValue: selected?.value,
    };
  }

  const modeChoices =
    runtimeCapabilities?.modes?.availableModes.map((mode) => ({
      description: mode.description,
      label: formatMessagingAcpRuntimeModeLabel(mode.label || mode.id),
      optionId: "mode",
      privileged: messagingAcpRuntimeValueLooksPrivileged(mode.id),
      selected: false,
      source: "mode" as const,
      value: mode.id,
    })) ?? [];
  if (modeChoices.length > 0) {
    const currentValue =
      params.runtime?.currentModeId ??
      runtimeCapabilities?.modes?.currentModeId ??
      defaultRuntimeModeValue(modeChoices);
    const choices = modeChoices.map((choice) => ({
      ...choice,
      selected: choice.value === currentValue,
    }));
    return {
      choices,
      currentLabel: labelForRuntimeValue(choices, currentValue),
      currentValue,
    };
  }

  const fallbackValue = resolveAcpRuntimeModeValue(params.runtime);
  return {
    choices: [],
    currentLabel: fallbackValue
      ? formatMessagingAcpRuntimeModeLabel(fallbackValue)
      : "Agent default",
    currentValue: fallbackValue,
  };
}

/**
 * Whether an ACP backend's Permissions control is PwrAgent's Default and
 * Full Access execution modes. Grok and Kimi builds without a permission
 * selector of their own declare both on the backend summary, and the registry
 * applies them. Any runtime mode such a backend still advertises, such as
 * Grok's planning selector, is not a permission choice.
 */
export function acpBackendUsesExecutionModePermissions(
  backend: BackendSummary | undefined,
): boolean {
  return (
    acpBackendDeclaresExecutionMode(backend, "default")
    && acpBackendDeclaresExecutionMode(backend, "full-access")
  );
}

/** Whether an ACP backend declares `mode` as an available execution mode. */
export function acpBackendDeclaresExecutionMode(
  backend: BackendSummary | undefined,
  mode: ThreadExecutionMode,
): boolean {
  return Boolean(
    backend
    && isAcpBackendId(backend.kind)
    && backend.executionModes.some(
      (candidate) => candidate.mode === mode && candidate.available,
    ),
  );
}

export function resolveAcpRuntimeModeValue(
  runtime: BackendAcpSessionRuntimeState | undefined,
): string | undefined {
  return (
    runtime?.currentModeId ??
    (runtime?.configValues
      ? Object.entries(runtime.configValues).find(([key]) =>
          isFallbackRuntimeModeConfigKey(key),
        )?.[1]
      : undefined)
  );
}

export function formatMessagingAcpRuntimeModeLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (trimmed.toLowerCase() === "yolo") {
    return "Yolo";
  }
  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function messagingAcpRuntimeValueLooksPrivileged(
  value: string | undefined,
): boolean {
  // Auto/Auto-Edit are provider-managed ACP modes, not PwrAgent full access.
  return value === "yolo";
}

function isRuntimeModeConfigOption(option: BackendAcpRuntimeConfigOption): boolean {
  return option.category === "mode";
}

function defaultRuntimeModeValue(
  choices: MessagingAcpRuntimeModeChoice[],
): string | undefined {
  return (
    choices.find((choice) => choice.value === "default")?.value ??
    choices[0]?.value
  );
}

function defaultConfigOptionValue(
  option: BackendAcpRuntimeConfigOption,
): string | undefined {
  return (
    option.values.find((value) => value.value === "default")?.value ??
    option.values[0]?.value
  );
}

function labelForRuntimeValue(
  choices: MessagingAcpRuntimeModeChoice[],
  value: string | undefined,
): string {
  if (!value) {
    return "Agent default";
  }
  return (
    choices.find((choice) => choice.value === value)?.label ??
    formatMessagingAcpRuntimeModeLabel(value)
  );
}

function isFallbackRuntimeModeConfigKey(key: string): boolean {
  return key.trim().toLowerCase().endsWith("mode");
}
