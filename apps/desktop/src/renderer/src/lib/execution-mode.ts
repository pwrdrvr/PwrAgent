import type {
  AppServerBackendKind,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type {
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import {
  acpRuntimeModeSelector,
  acpRuntimeModeValue,
  formatAcpRuntimeModeLabel,
} from "@pwragent/shared/acp-permission-mode";
import {
  resolveProviderAccessControl,
  type ProviderAccessControl,
} from "@pwragent/shared/provider-access-mode";

export function formatExecutionModeLabel(mode?: ThreadExecutionMode): string {
  return mode === "auto" ? "Auto" : mode === "full-access" ? "Full Access" : "Default Access";
}

export function describeCodexExecutionMode(mode: ThreadExecutionMode): string {
  switch (mode) {
    case "auto":
      return "Workspace sandbox; Codex reviews eligible permission requests.";
    case "full-access":
      return "Runs without the workspace sandbox or permission prompts.";
    default:
      return "Workspace sandbox; asks you to approve additional access.";
  }
}

export function describeClaudeExecutionMode(mode: ThreadExecutionMode): string {
  switch (mode) {
    case "auto":
      return "Claude Code's auto mode decides routine permission requests.";
    case "full-access":
      return "Runs without permission prompts.";
    default:
      return "Asks you to approve edits and commands.";
  }
}

export function describeExecutionModeForBackend(
  backend: AppServerBackendKind,
  mode: ThreadExecutionMode,
): string {
  return backend === "claude"
    ? describeClaudeExecutionMode(mode)
    : describeCodexExecutionMode(mode);
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
  // The same selector a start card's Access menu lists the agent's modes from.
  const selector = acpRuntimeModeSelector(backend?.acp?.runtime);
  if (!selector || selector.choices.length < 2) {
    return undefined;
  }
  return {
    optionId: selector.optionId,
    source: selector.source,
    value: acpRuntimeModeValue(selector, settings?.acpRuntime) ?? "",
    options: selector.choices.map((choice) => ({
      label: formatAcpRuntimeModeLabel(choice.label),
      value: choice.id,
    })),
  };
}

export function getProviderAccessControl(
  backend: BackendSummary | undefined,
  settings: NavigationLaunchpadDraft | NavigationThreadSummary | undefined,
  options?: { includeUnavailableAuto?: boolean },
): ProviderAccessControl | undefined {
  return resolveProviderAccessControl({
    backend,
    state: settings
      ? {
          executionMode: settings.executionMode,
          acpRuntime: settings.acpRuntime,
        }
      : undefined,
    includeUnavailableAuto: options?.includeUnavailableAuto,
  });
}

export function formatAccessModeLabel(
  settings: NavigationLaunchpadDraft | NavigationThreadSummary,
  _backend?: BackendSummary,
): string {
  return formatExecutionModeLabel(settings.executionMode);
}
