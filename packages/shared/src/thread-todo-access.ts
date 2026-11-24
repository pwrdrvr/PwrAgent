import type { BackendSummary } from "./contracts/backend";
import type { AppServerBackendKind, ThreadExecutionMode } from "./contracts/normalized-app-server";
import {
  acpNativeAccessMode,
  acpNativeAccessOptions,
  acpNativeAccessRuntime,
  type AcpNativeAccessMode,
} from "./acp-permission-mode";

/** An operator's pick among an agent's own access modes, for that agent alone. */
export type ThreadTodoNativeAccessMode = {
  backend: AppServerBackendKind;
  id: string;
};

/** What a start card stores about access. */
export type ThreadTodoAccessCard = {
  /** The card's mode. Absent inherits the raising thread's. */
  executionMode?: ThreadExecutionMode;
  nativeAccessMode?: ThreadTodoNativeAccessMode;
};

/** The destination provider, as its catalog lists it. */
export type ThreadTodoAccessDestination = Pick<BackendSummary, "kind" | "label" | "executionModes" | "acp">;

/** One mode the destination offers. */
export type ThreadTodoAccessOption =
  | { kind: "mode"; mode: ThreadExecutionMode }
  | {
      kind: "native";
      id: string;
      /** The agent's name for the mode, unformatted. */
      label: string;
      /** The PwrAgent level it carries; absent for modes such as Plan and Accept edits. */
      executionMode?: ThreadExecutionMode;
    };

/**
 * Where the start's access comes from: the card's mode or the operator's
 * pick; the raising thread's mode; a lower mode, because the destination
 * lacks the wanted one; or the agent's own default, because none of its
 * modes is at or below the wanted one.
 */
export type ThreadTodoAccessSource = "card" | "inherited" | "lowered" | "agent";

export type ThreadTodoStartAccess =
  | {
      status: "ready";
      /** Undefined when the agent starts in its own default mode. */
      selected?: ThreadTodoAccessOption;
      source: ThreadTodoAccessSource;
      /** The access the card or its thread asked for. */
      wanted: ThreadExecutionMode;
      /** Recorded on the new thread. */
      executionMode: ThreadExecutionMode;
      /** Starts the agent in its native mode. */
      acpRuntime?: AcpNativeAccessMode["runtime"];
      /** What the operator can pick instead. Empty when nothing can be chosen. */
      options: ThreadTodoAccessOption[];
    }
  | {
      status: "refused";
      reason: "card_mode_unavailable" | "no_fit";
      wanted: ThreadExecutionMode;
      options: ThreadTodoAccessOption[];
      message: string;
    };

/** Lowest first. */
const ACCESS_ORDER: readonly ThreadExecutionMode[] = ["default", "auto", "full-access"];

export function threadExecutionModeRank(mode: ThreadExecutionMode): number {
  return ACCESS_ORDER.indexOf(mode);
}

const MODE_WORDS: Record<ThreadExecutionMode, string> = {
  default: "Default Access",
  auto: "Auto",
  "full-access": "Full Access",
};

/**
 * The access a start card's new thread gets on its destination, shared by
 * the card that shows it and the owner that starts the thread.
 *
 * A provider that lists PwrAgent modes keeps the card's mode when it offers
 * it and refuses otherwise. An inherited mode stays on the same provider;
 * on another it falls back to Default Access when the destination lacks it,
 * and is refused when it offers neither. An agent whose own selector owns
 * approval policy lists no PwrAgent modes: the operator's pick of one of its
 * modes stands, and otherwise its highest mode at or below the wanted access
 * is used, so a provider switch never raises access.
 */
export function resolveThreadTodoStartAccess(input: {
  card: ThreadTodoAccessCard;
  sourceBackend: AppServerBackendKind;
  sourceExecutionMode: ThreadExecutionMode;
  /** Undefined when the catalog does not list the provider. */
  destination: ThreadTodoAccessDestination | undefined;
  destinationBackend: AppServerBackendKind;
}): ThreadTodoStartAccess {
  const { card, destination } = input;
  const fromCard = card.executionMode !== undefined;
  const wanted = card.executionMode ?? input.sourceExecutionMode;
  const sameBackend = input.destinationBackend === input.sourceBackend;
  const named: ThreadTodoAccessSource = fromCard ? "card" : "inherited";
  if (!destination) {
    return { status: "ready", selected: { kind: "mode", mode: wanted }, source: named, wanted, executionMode: wanted, options: [] };
  }

  // A peer's older catalog may leave the list out.
  const listed = destination.executionModes ?? [];
  if (listed.length > 0) {
    const options: ThreadTodoAccessOption[] = ACCESS_ORDER
      .filter((mode) => listed.some((entry) => entry.mode === mode && entry.available))
      .map((mode) => ({ kind: "mode", mode }));
    const offers = (mode: ThreadExecutionMode) =>
      options.some((option) => option.kind === "mode" && option.mode === mode);
    const ready = (mode: ThreadExecutionMode, source: ThreadTodoAccessSource): ThreadTodoStartAccess => ({
      status: "ready", selected: { kind: "mode", mode }, source, wanted, executionMode: mode, options,
    });
    // The raising thread already runs at its mode on this provider.
    if (offers(wanted) || (!fromCard && sameBackend)) return ready(wanted, named);
    if (fromCard) {
      return {
        status: "refused", reason: "card_mode_unavailable", wanted, options,
        message: options.length > 0
          ? `${destination.label} does not offer ${MODE_WORDS[wanted]}. Choose one of its modes.`
          : `${destination.label} has no access mode it can start with now, not even Default Access. Choose another provider.`,
      };
    }
    // An inherited mode must never raise access to make a provider fit.
    if (offers("default")) return ready("default", "lowered");
    return {
      status: "refused", reason: "no_fit", wanted, options,
      message: options.length > 0
        ? `${destination.label} cannot use the inherited access mode or Default Access. Choose one of its modes.`
        : `${destination.label} has no access mode it can start with now, not even Default Access. Choose another provider.`,
    };
  }

  const runtime = destination.acp?.runtime;
  const options: ThreadTodoAccessOption[] = acpNativeAccessOptions(runtime)
    .map((option) => ({ kind: "native", ...option }));
  // The Full Access gate judges the card's mode, so a pick above it, which
  // the card's own Access menu never stores, is not honored.
  const picked = card.nativeAccessMode?.backend === input.destinationBackend
    ? options.find((option) => option.kind === "native" && option.id === card.nativeAccessMode?.id
      && (option.executionMode === undefined || threadExecutionModeRank(option.executionMode) <= threadExecutionModeRank(wanted)))
    : undefined;
  if (picked?.kind === "native") {
    return {
      status: "ready", selected: picked, source: "card", wanted,
      executionMode: recordedNativeMode(picked.executionMode),
      acpRuntime: acpNativeAccessRuntime(runtime, picked.id),
      options,
    };
  }
  const native = acpNativeAccessMode(runtime, wanted);
  if (native) {
    const id = native.runtime.currentModeId ?? Object.values(native.runtime.configValues ?? {})[0];
    const selected = options.find((option) => option.kind === "native" && option.id === id);
    return {
      status: "ready", ...(selected ? { selected } : {}),
      source: native.executionMode === wanted ? named : "lowered", wanted,
      executionMode: recordedNativeMode(native.executionMode),
      acpRuntime: native.runtime,
      options,
    };
  }
  // The agent offers no mode at or below the wanted access, or none at all.
  // It starts in its own default, recorded as Default Access unless the card
  // named a mode or the thread stays on its provider.
  return {
    status: "ready", source: options.length > 0 ? "agent" : named, wanted,
    executionMode: fromCard || sameBackend ? wanted : "default",
    ...(options.length > 0 ? {} : { selected: { kind: "mode", mode: fromCard || sameBackend ? wanted : "default" } }),
    options,
  };
}

/** A native mode below Full Access records the thread at Default Access. */
function recordedNativeMode(level: ThreadExecutionMode | undefined): ThreadExecutionMode {
  return level === "full-access" ? "full-access" : "default";
}

/**
 * What a card stores for an operator's pick. A native mode keeps its level as
 * the card's mode, so the Full Access gate holds back Yolo and a later switch
 * to a provider with PwrAgent modes never raises access. A mode without a
 * level, such as Plan, is stored at Default Access.
 */
export function threadTodoAccessForPick(
  option: ThreadTodoAccessOption,
  backend: AppServerBackendKind,
): Required<Pick<ThreadTodoAccessCard, "executionMode">> & Pick<ThreadTodoAccessCard, "nativeAccessMode"> {
  return option.kind === "mode"
    ? { executionMode: option.mode }
    : { executionMode: option.executionMode ?? "default", nativeAccessMode: { backend, id: option.id } };
}

export function sameThreadTodoAccessOption(
  left: ThreadTodoAccessOption | undefined,
  right: ThreadTodoAccessOption | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.kind === "mode"
    ? right.kind === "mode" && left.mode === right.mode
    : right.kind === "native" && left.id === right.id;
}
