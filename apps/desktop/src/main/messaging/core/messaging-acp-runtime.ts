import {
  acpRuntimeModeIsFullAccess,
  acpRuntimeModeSelector,
  acpRuntimeModeValue,
  formatAcpRuntimeModeLabel,
} from "@pwragent/shared/acp-permission-mode";
import type {
  BackendAcpRuntimeOptionSource,
  BackendAcpSessionRuntimeState,
  BackendSummary,
} from "@pwragent/shared/contracts/backend";
import type { ThreadExecutionMode } from "@pwragent/shared/contracts/normalized-app-server";
import { isAcpBackendId } from "@pwragent/shared/contracts/navigation";

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

  // The selector the composer and a start card read, so messaging offers the
  // same modes and reports the same current mode.
  const selector = acpRuntimeModeSelector(backend.acp?.runtime);
  if (selector && selector.choices.length > 0) {
    const currentValue = acpRuntimeModeValue(selector, params.runtime);
    const choices = selector.choices.map((choice) => ({
      description: choice.description,
      label: formatAcpRuntimeModeLabel(choice.label),
      optionId: selector.optionId,
      privileged: acpRuntimeModeIsFullAccess(choice.id),
      selected: choice.id === currentValue,
      source: selector.source,
      value: choice.id,
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
      ? formatAcpRuntimeModeLabel(fallbackValue)
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

function labelForRuntimeValue(
  choices: MessagingAcpRuntimeModeChoice[],
  value: string | undefined,
): string {
  if (!value) {
    return "Agent default";
  }
  return (
    choices.find((choice) => choice.value === value)?.label ??
    formatAcpRuntimeModeLabel(value)
  );
}

function isFallbackRuntimeModeConfigKey(key: string): boolean {
  return key.trim().toLowerCase().endsWith("mode");
}
