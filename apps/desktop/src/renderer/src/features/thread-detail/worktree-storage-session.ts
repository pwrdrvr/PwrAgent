import type {
  ReadWorktreeReflinkCapabilitiesResponse,
  RunWorktreeReflinkRequest,
  RunWorktreeReflinkResponse,
  WorktreeReflinkRuntime,
  WorktreeReflinkSummary,
  WorktreeReflinkTarget,
} from "@pwragent/shared/contracts/worktree-reflink";

export type WorktreeStorageRunMode = "estimate" | "share";

export type WorktreeStorageOutcome = {
  mode: WorktreeStorageRunMode;
  supported: boolean;
  verifiedFilters: boolean;
  summary: WorktreeReflinkSummary;
};

/**
 * What the Share storage dialog knows. Every answer from the main process is
 * matched to the request that asked for it, and every choice the operator
 * made is tied to the Git it was made for:
 *
 * - `verifyFilters` is true only while `runtime` lists the option, and it
 *   returns to false whenever `runtime` becomes another Git. Ticking the box
 *   for one Git is not consent for the next.
 * - A capability answer counts only for the newest capability request, and a
 *   run answer only for the run now in flight. Late answers change nothing.
 */
export type WorktreeStorageState = {
  capabilityRequest: number;
  capabilities: "loading" | "ready" | "unavailable";
  runtime?: WorktreeReflinkRuntime;
  verifyFilters: boolean;
  runRequest: number;
  running?: WorktreeStorageRunMode;
  estimate?: WorktreeStorageOutcome;
  shared?: WorktreeStorageOutcome;
  /** The selected Git changed while the dialog was open. */
  runtimeChanged: boolean;
  error?: string;
};

export type WorktreeStorageEvent =
  | { type: "capabilities-requested" }
  | { type: "capabilities-answered"; request: number; response: ReadWorktreeReflinkCapabilitiesResponse }
  | { type: "capabilities-failed"; request: number; reason: string }
  | { type: "verify-filters-set"; checked: boolean }
  | { type: "run-started"; mode: WorktreeStorageRunMode }
  | { type: "run-answered"; request: number; response: RunWorktreeReflinkResponse }
  | { type: "run-failed"; request: number; reason: string };

export const INITIAL_WORKTREE_STORAGE_STATE: WorktreeStorageState = {
  capabilityRequest: 0,
  capabilities: "loading",
  verifyFilters: false,
  runRequest: 0,
  runtimeChanged: false,
};

/**
 * Take the Git the main process just described. A different Git clears
 * everything that was decided or measured for the old one.
 */
function adoptRuntime(state: WorktreeStorageState, runtime: WorktreeReflinkRuntime): WorktreeStorageState {
  // An error from failing to read the capabilities ends when they are read.
  const error = state.capabilities === "unavailable" ? undefined : state.error;
  if (state.runtime?.runtimeKey === runtime.runtimeKey) {
    return { ...state, capabilities: "ready", runtime, error };
  }
  return {
    ...state,
    error,
    capabilities: "ready",
    runtime,
    verifyFilters: false,
    estimate: undefined,
    shared: undefined,
    runtimeChanged: state.runtime !== undefined,
  };
}

/**
 * A session for another worktree. The request numbers carry on from the old
 * one, so an answer still on its way to it matches nothing here.
 */
export function restartWorktreeStorage(state: WorktreeStorageState): WorktreeStorageState {
  return {
    ...INITIAL_WORKTREE_STORAGE_STATE,
    capabilityRequest: state.capabilityRequest,
    runRequest: state.runRequest,
  };
}

export function reduceWorktreeStorage(
  state: WorktreeStorageState,
  event: WorktreeStorageEvent,
): WorktreeStorageState {
  switch (event.type) {
    case "capabilities-requested":
      return {
        ...state,
        capabilityRequest: state.capabilityRequest + 1,
        // A retry after a failed read keeps saying why until it is answered.
        capabilities: state.runtime || state.capabilities === "unavailable" ? state.capabilities : "loading",
      };
    case "capabilities-answered": {
      if (event.request !== state.capabilityRequest) return state;
      if (event.response.status === "unavailable") {
        return {
          ...state,
          capabilities: "unavailable",
          runtime: undefined,
          verifyFilters: false,
          estimate: undefined,
          shared: undefined,
          error: event.response.reason,
        };
      }
      const { capabilities, runtimeKey } = event.response;
      return adoptRuntime(state, { capabilities, runtimeKey });
    }
    case "capabilities-failed":
      if (event.request !== state.capabilityRequest) return state;
      return {
        ...state,
        capabilities: "unavailable",
        runtime: undefined,
        verifyFilters: false,
        estimate: undefined,
        shared: undefined,
        error: event.reason,
      };
    case "verify-filters-set":
      return {
        ...state,
        verifyFilters: event.checked && state.runtime?.capabilities.verifyFilters === true,
      };
    case "run-started":
      if (state.running || !state.runtime?.capabilities.reflink) return state;
      return {
        ...state,
        runRequest: state.runRequest + 1,
        running: event.mode,
        error: undefined,
        ...(event.mode === "share" ? { runtimeChanged: false } : {}),
      };
    case "run-answered": {
      if (event.request !== state.runRequest || !state.running) return state;
      const settled = { ...state, running: undefined };
      const { response } = event;
      if (response.status === "failed") return { ...settled, error: response.reason };
      const adopted = adoptRuntime(settled, {
        capabilities: response.capabilities,
        runtimeKey: response.runtimeKey,
      });
      if (response.status === "runtime-changed") return { ...adopted, runtimeChanged: true };
      const outcome: WorktreeStorageOutcome = {
        mode: response.mode,
        supported: response.supported,
        verifiedFilters: response.verifiedFilters,
        summary: response.summary,
      };
      return response.mode === "share"
        // What was shared is no longer waiting to be shared.
        ? { ...adopted, shared: outcome, estimate: undefined }
        : { ...adopted, estimate: outcome };
    }
    case "run-failed":
      if (event.request !== state.runRequest || !state.running) return state;
      return { ...state, running: undefined, error: event.reason };
  }
}

/**
 * The request for one run, or undefined when the Git on screen cannot do it.
 * An estimate never asks for filters. A share asks only when the box is
 * ticked for this Git, and names that Git so the main process can refuse a
 * request made for another.
 */
export function worktreeStorageRunRequest(
  state: WorktreeStorageState,
  target: WorktreeReflinkTarget,
  mode: WorktreeStorageRunMode,
): RunWorktreeReflinkRequest | undefined {
  const runtime = state.runtime;
  if (!runtime?.capabilities.reflink) return undefined;
  return {
    ...target,
    mode,
    runtimeKey: runtime.runtimeKey,
    ...(mode === "share" && state.verifyFilters && runtime.capabilities.verifyFilters
      ? { verifyFilters: true }
      : {}),
  };
}
