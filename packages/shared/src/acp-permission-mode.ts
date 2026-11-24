import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeConfigOption,
  BackendAcpSessionRuntimeState,
} from "./contracts/backend";
import type { ThreadExecutionMode } from "./contracts/normalized-app-server";

/** Grok's permission config is independent of ACP's native planning mode. */
export function findAcpPermissionModeConfigOption(
  runtime: BackendAcpRuntimeCapabilities | undefined,
): BackendAcpRuntimeConfigOption | undefined {
  return runtime?.configOptions?.find(
    (option) => option.id === "permission_mode" && option.category === "mode",
  );
}

/** The native ids for PwrAgent's access levels, lowest first, as ACP session
 * modes and Grok's `permission_mode` name them. An agent lists only some:
 * Antigravity offers `default` and `auto` but no `yolo`. */
const ACP_NATIVE_ACCESS_MODE_IDS: ReadonlyArray<readonly [ThreadExecutionMode, string]> = [
  ["default", "default"],
  ["auto", "auto"],
  ["full-access", "yolo"],
];

/** One of an agent's own access modes, as it lists them. */
export type AcpNativeAccessOption = {
  id: string;
  /** The agent's name for the mode, unformatted. */
  label: string;
  /** The PwrAgent level it carries; absent for modes such as Plan and Accept edits. */
  executionMode?: ThreadExecutionMode;
};

/**
 * The modes that carry an agent's access, in the agent's order: Grok's
 * `permission_mode` values, else the ACP session modes. Empty when the agent
 * offers fewer than two, which leaves nothing to choose.
 */
export function acpNativeAccessOptions(
  runtime: BackendAcpRuntimeCapabilities | undefined,
): AcpNativeAccessOption[] {
  const permission = findAcpPermissionModeConfigOption(runtime);
  const offered = permission
    ? permission.values.map((value) => ({ id: value.value, label: value.label ?? value.value }))
    : runtime?.modes?.availableModes.map((mode) => ({ id: mode.id, label: mode.label || mode.id })) ?? [];
  if (offered.length < 2) return [];
  return offered.map((option) => {
    const level = ACP_NATIVE_ACCESS_MODE_IDS.find(([, id]) => id === option.id)?.[0];
    return level ? { ...option, executionMode: level } : option;
  });
}

export type AcpNativeAccessMode = {
  /** The PwrAgent access level the native mode carries. */
  executionMode: ThreadExecutionMode;
  /** Runtime state that selects the native mode when the session starts. */
  runtime: Pick<BackendAcpSessionRuntimeState, "configValues" | "currentModeId">;
};

/** Runtime state that starts a session in the agent's mode `id`. */
export function acpNativeAccessRuntime(
  runtime: BackendAcpRuntimeCapabilities | undefined,
  id: string,
): AcpNativeAccessMode["runtime"] {
  const permission = findAcpPermissionModeConfigOption(runtime);
  return permission ? { configValues: { [permission.id]: id } } : { currentModeId: id };
}

/**
 * The agent's own mode for a PwrAgent access level, for an agent whose native
 * selector owns approval policy and so lists no PwrAgent execution modes. It
 * picks the highest listed mode at or below `executionMode`, so a provider
 * switch never raises access. Modes with no PwrAgent level, such as Plan and
 * Accept edits, are never picked.
 */
export function acpNativeAccessMode(
  runtime: BackendAcpRuntimeCapabilities | undefined,
  executionMode: ThreadExecutionMode,
): AcpNativeAccessMode | undefined {
  const offered = acpNativeAccessOptions(runtime).map((option) => option.id);
  const ceiling = ACP_NATIVE_ACCESS_MODE_IDS.findIndex(([mode]) => mode === executionMode);
  for (const [mode, id] of ACP_NATIVE_ACCESS_MODE_IDS.slice(0, ceiling + 1).reverse()) {
    if (!offered.includes(id)) continue;
    return { executionMode: mode, runtime: acpNativeAccessRuntime(runtime, id) };
  }
  return undefined;
}
