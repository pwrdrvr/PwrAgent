import type {
  BackendSummary,
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragent/shared";

export function formatExecutionModeLabel(mode?: ThreadExecutionMode): string {
  return mode === "full-access" ? "Full Access" : "Default Access";
}

export function acpRuntimeModeRequiresFullAccess(value: string): boolean {
  return ["auto_edit", "autoedit", "yolo"].includes(
    value.trim().replace(/[-\s]+/g, "_").toLowerCase(),
  );
}

export type AcpRuntimeModeControl = {
  optionId: string;
  source: "configOption" | "mode";
  value: string;
  options: Array<{ label: string; value: string }>;
};

export function getAcpRuntimeModeControl(
  backend: BackendSummary | undefined,
  settings: NavigationLaunchpadDraft | NavigationThreadSummary | undefined,
): AcpRuntimeModeControl | undefined {
  const runtime = backend?.acp?.runtime;
  if (!runtime) {
    return undefined;
  }

  const modeConfigOption = runtime.configOptions?.find(
    (option) => option.category === "mode" && option.values.length > 0,
  );
  if (modeConfigOption) {
    if (modeConfigOption.values.length < 2) {
      return undefined;
    }
    const currentModeValue =
      settings?.acpRuntime?.currentModeId &&
      modeConfigOption.values.some(
        (option) => option.value === settings.acpRuntime?.currentModeId,
      )
        ? settings.acpRuntime.currentModeId
        : undefined;
    const value =
      currentModeValue ??
      settings?.acpRuntime?.configValues?.[modeConfigOption.id] ??
      modeConfigOption.currentValue ??
      modeConfigOption.values[0]?.value ??
      "";
    return {
      optionId: modeConfigOption.id,
      source: "configOption",
      value,
      options: modeConfigOption.values.map((option) => ({
        label: formatAcpRuntimeModeLabel(option.label ?? option.value),
        value: option.value,
      })),
    };
  }

  const modeOptions = runtime.modes?.availableModes ?? [];
  if (modeOptions.length < 2) {
    return undefined;
  }

  return {
    optionId: "mode",
    source: "mode",
    value:
      settings?.acpRuntime?.currentModeId ??
      runtime.modes?.currentModeId ??
      modeOptions[0]?.id ??
      "",
    options: modeOptions.map((mode) => ({
      label: formatAcpRuntimeModeLabel(mode.label ?? mode.id),
      value: mode.id,
    })),
  };
}

export function formatAccessModeLabel(
  settings: NavigationLaunchpadDraft | NavigationThreadSummary,
  _backend?: BackendSummary,
): string {
  return formatExecutionModeLabel(settings.executionMode);
}

export function formatAcpRuntimeModeLabel(value: string): string {
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
