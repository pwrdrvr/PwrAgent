import type {
  BackendAcpRuntimeConfigOption,
  BackendAcpRuntimeOptionSource,
  BackendAcpSessionRuntimeState,
  BackendSummary,
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

  const modeConfigOptions =
    runtimeCapabilities?.configOptions?.filter(isRuntimeModeConfigOption) ?? [];
  const configChoices = modeConfigOptions.flatMap((option) => {
    const currentValue =
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

  const fallbackValue = resolveAcpRuntimeModeValue(params.runtime);
  return {
    choices: [],
    currentLabel: fallbackValue
      ? formatMessagingAcpRuntimeModeLabel(fallbackValue)
      : "Agent default",
    currentValue: fallbackValue,
  };
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
  return value === "yolo" || value === "autoEdit" || value === "auto_edit";
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
