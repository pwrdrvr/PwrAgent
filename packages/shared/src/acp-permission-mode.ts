import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeConfigOption,
  BackendAcpSessionRuntimeState,
} from "./contracts/backend";
import type { ThreadExecutionMode } from "./contracts/normalized-app-server";

/** The id of Grok's permission config option. */
export const ACP_PERMISSION_MODE_OPTION_ID = "permission_mode";

/** Grok's permission config is independent of ACP's native planning mode. */
export function findAcpPermissionModeConfigOption(
  runtime: BackendAcpRuntimeCapabilities | undefined,
): BackendAcpRuntimeConfigOption | undefined {
  return runtime?.configOptions?.find(
    (option) => option.id === ACP_PERMISSION_MODE_OPTION_ID && option.category === "mode",
  );
}

/**
 * The mode config option that mirrors the ACP session modes, so a write to it
 * also sets `currentModeId`: Antigravity, Kimi and Qwen list one. Grok's
 * `permission_mode` is independent of its planning mode and never mirrors.
 */
export function findAcpMirroredModeConfigOption(
  runtime: BackendAcpRuntimeCapabilities | undefined,
): BackendAcpRuntimeConfigOption | undefined {
  return runtime?.configOptions?.find(
    (option) => option.category === "mode"
      && option.id !== ACP_PERMISSION_MODE_OPTION_ID
      && option.values.length > 0,
  );
}

/** One mode an agent's mode selector lists, as the agent names it. */
export type AcpRuntimeModeChoice = {
  id: string;
  /** The agent's name for the mode, unformatted. */
  label: string;
  description?: string;
};

/**
 * The selector that carries an agent's own modes, and how a pick is written:
 * `configOption` through `session/set_config_option` on `optionId`, `mode`
 * through ACP `session/set_mode`.
 */
export type AcpRuntimeModeSelector = {
  source: "configOption" | "mode";
  optionId: string;
  /** The agent's own current value, if it reports one. */
  currentValue?: string;
  choices: AcpRuntimeModeChoice[];
};

/**
 * Which of an agent's selectors lists its modes: Grok's `permission_mode`,
 * else another mode config option with values (Antigravity, Kimi and Qwen
 * list one beside their session modes), else the ACP session modes. The
 * composer's mode picker and a start card's Access menu both read this, so
 * they never offer an agent's modes from two different lists.
 */
export function acpRuntimeModeSelector(
  runtime: BackendAcpRuntimeCapabilities | undefined,
): AcpRuntimeModeSelector | undefined {
  const option = findAcpPermissionModeConfigOption(runtime) ?? runtime?.configOptions?.find(
    (candidate) => candidate.category === "mode" && candidate.values.length > 0,
  );
  if (option) {
    return {
      source: "configOption",
      optionId: option.id,
      ...(option.currentValue !== undefined ? { currentValue: option.currentValue } : {}),
      choices: option.values.map((value) => ({
        id: value.value,
        label: value.label || value.value,
        ...(value.description ? { description: value.description } : {}),
      })),
    };
  }
  const modes = runtime?.modes;
  if (!modes) return undefined;
  return {
    source: "mode",
    optionId: "mode",
    ...(modes.currentModeId !== undefined ? { currentValue: modes.currentModeId } : {}),
    choices: modes.availableModes.map((mode) => ({
      id: mode.id,
      label: mode.label || mode.id,
      ...(mode.description ? { description: mode.description } : {}),
    })),
  };
}

/**
 * The mode a session is in, as the selector reads it. A legacy mode config
 * option mirrors `currentModeId`; Grok's `permission_mode` does not, because
 * there `currentModeId` is the planning mode. With nothing recorded, the
 * agent's own current value, else its Default, else its first mode.
 */
export function acpRuntimeModeValue(
  selector: AcpRuntimeModeSelector,
  state: Pick<BackendAcpSessionRuntimeState, "configValues" | "currentModeId"> | undefined,
): string | undefined {
  const offers = (value: string | undefined): value is string =>
    value !== undefined && selector.choices.some((choice) => choice.id === value);
  const recorded = selector.source === "mode"
    ? state?.currentModeId
    : (selector.optionId !== "permission_mode" && offers(state?.currentModeId) ? state?.currentModeId : undefined)
      ?? state?.configValues?.[selector.optionId];
  return recorded
    ?? selector.currentValue
    ?? selector.choices.find((choice) => choice.id === "default")?.id
    ?? selector.choices[0]?.id;
}

/** An agent's mode id as the composer, to-do card and messaging show it. */
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

/**
 * Whether an agent's own mode skips every permission request, which only
 * Yolo does. Auto and Auto Edit are the agent's own judgment, not PwrAgent
 * Full Access.
 */
export function acpRuntimeModeIsFullAccess(value: string | undefined): boolean {
  return value?.trim().replace(/[-\s]+/g, "_").toLowerCase() === "yolo";
}

/** The native ids for PwrAgent's access levels, lowest first, as ACP session
 * modes and Grok's `permission_mode` name them. An agent lists only some:
 * Antigravity offers `default` and `auto` but no `yolo`. */
const ACP_NATIVE_ACCESS_MODE_IDS: ReadonlyArray<readonly [ThreadExecutionMode, string]> = [
  ["default", "default"],
  ["auto", "auto"],
  ["full-access", "yolo"],
];

/** The PwrAgent level a native mode id carries, if any. */
export function acpNativeAccessLevel(id: string): ThreadExecutionMode | undefined {
  return ACP_NATIVE_ACCESS_MODE_IDS.find(([, nativeId]) => nativeId === id)?.[0];
}

/** One of an agent's own access modes, as it lists them. */
export type AcpNativeAccessOption = {
  id: string;
  /** The agent's name for the mode, unformatted. */
  label: string;
  /** The PwrAgent level it carries; absent for modes such as Plan and Accept edits. */
  executionMode?: ThreadExecutionMode;
};

/**
 * The modes that carry an agent's access, in the agent's order, from
 * `acpRuntimeModeSelector`. Empty when the agent offers fewer than two, which
 * leaves nothing to choose.
 */
export function acpNativeAccessOptions(
  runtime: BackendAcpRuntimeCapabilities | undefined,
): AcpNativeAccessOption[] {
  const offered = acpRuntimeModeSelector(runtime)?.choices ?? [];
  if (offered.length < 2) return [];
  return offered.map((option) => {
    const level = acpNativeAccessLevel(option.id);
    return level ? { ...option, executionMode: level } : option;
  });
}

export type AcpNativeAccessMode = {
  /** The PwrAgent access level the native mode carries. */
  executionMode: ThreadExecutionMode;
  /** Runtime state that selects the native mode when the session starts. */
  runtime: Pick<BackendAcpSessionRuntimeState, "configValues" | "currentModeId">;
};

/** Runtime state that starts a session in the agent's mode `id`, through the selector that lists it. */
export function acpNativeAccessRuntime(
  runtime: BackendAcpRuntimeCapabilities | undefined,
  id: string,
): AcpNativeAccessMode["runtime"] {
  const selector = acpRuntimeModeSelector(runtime);
  return selector?.source === "configOption" ? { configValues: { [selector.optionId]: id } } : { currentModeId: id };
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
  const native = highestNativeAccessMode(offered, executionMode);
  return native
    ? { executionMode: native[0], runtime: acpNativeAccessRuntime(runtime, native[1]) }
    : undefined;
}

/** The highest of `offered` whose PwrAgent level is at or below `executionMode`. */
function highestNativeAccessMode(
  offered: readonly string[],
  executionMode: ThreadExecutionMode,
): readonly [ThreadExecutionMode, string] | undefined {
  const ceiling = ACP_NATIVE_ACCESS_MODE_IDS.findIndex(([mode]) => mode === executionMode);
  return ACP_NATIVE_ACCESS_MODE_IDS.slice(0, ceiling + 1)
    .reverse()
    .find(([, id]) => offered.includes(id));
}

/**
 * The mode a new session is switched to when PwrAgent asks for `requested`,
 * given the modes that session's own `session/new` or `session/load` reply
 * lists. The agent's cached menu came from another session, and agents differ
 * by session: some Antigravity sessions have no native Auto and refuse it.
 *
 * A listed mode is used as asked. Otherwise the start falls back to the
 * highest listed mode at or below the requested mode's access level, and never
 * to a mode without a level, such as Plan. Undefined leaves the session in the
 * mode it started in: nothing at or below that level is listed, or the
 * requested mode has no level to fall back from.
 */
export function acpSessionStartMode(
  requested: string,
  offered: readonly string[],
): string | undefined {
  if (offered.includes(requested)) return requested;
  const level = acpNativeAccessLevel(requested);
  return level ? highestNativeAccessMode(offered, level)?.[1] : undefined;
}
