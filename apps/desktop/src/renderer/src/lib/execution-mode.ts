import type {
  AppServerBackendKind,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type {
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import { acpRuntimeModeSelector } from "@pwragent/shared/acp-permission-mode";

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

export function acpRuntimeModeRequiresFullAccess(value: string): boolean {
  // Auto/Auto-Edit are provider-managed ACP modes, not PwrAgent full access.
  return value.trim().replace(/[-\s]+/g, "_").toLowerCase() === "yolo";
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
  const offers = (value: string | undefined): value is string =>
    value !== undefined && selector.choices.some((choice) => choice.id === value);
  const currentModeId = settings?.acpRuntime?.currentModeId;
  const value = selector.source === "mode"
    ? currentModeId ?? selector.currentValue
    // A legacy mode config option mirrors currentModeId. Grok's permission
    // config does not: there currentModeId remains its planning mode.
    : (selector.optionId !== "permission_mode" && offers(currentModeId) ? currentModeId : undefined)
      ?? settings?.acpRuntime?.configValues?.[selector.optionId]
      ?? selector.currentValue;
  return {
    optionId: selector.optionId,
    source: selector.source,
    value: value ?? selector.choices[0]?.id ?? "",
    options: selector.choices.map((choice) => ({
      label: formatAcpRuntimeModeLabel(choice.label),
      value: choice.id,
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
