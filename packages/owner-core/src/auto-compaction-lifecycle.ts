/**
 * The owner's auto-compaction lifecycle for one thread, as a pure reducer.
 *
 * The owner feeds it what it observes (context fill reports, turns starting
 * and ending, provider compactions, and the answers to its own requests) and
 * carries out the command it returns. Nothing here is persisted: a restart
 * starts every thread at `armed`, and the next fill report re-evaluates it.
 *
 * Phases:
 *
 * - `armed`: the fill is below the trigger, or nothing has been reported.
 * - `due`: the fill passed the trigger and a compaction is wanted, but no
 *   opening exists yet: a turn runs that cannot be steered, or a gate holds
 *   the thread.
 * - `steering` / `starting`: a steered `/compact` or a compaction turn was
 *   requested and has not been answered. Nothing else is requested meanwhile.
 * - `compacting`: the request was accepted. Waiting for evidence: a fill
 *   below the trigger, or the provider reporting a compaction.
 * - `resume`: a steered compaction worked. The turn it was steered into ends
 *   early, so one continuation is sent when it does.
 * - `held`: compaction ran without bringing the fill down, the provider
 *   refused it three times, or the thread has no way to compact. Nothing is
 *   requested until the fill falls below `rearmTokens`, the provider reports a
 *   compaction, or the owner resets the thread.
 *
 * Within one episode (from leaving `armed` until returning to it) the reducer
 * requests at most one steer and one compaction turn that the provider
 * accepts, and it never has two requests open at once.
 */

export type AutoCompactionPhase =
  | "armed"
  | "due"
  | "steering"
  | "starting"
  | "compacting"
  | "resume"
  | "held";

export type AutoCompactionHeldReason = "no-shrink" | "refused" | "unsupported";

export type AutoCompactionState = {
  phase: AutoCompactionPhase;
  /** The last fill reported, in tokens. */
  lastFill?: number;
  triggerTokens?: number;
  rearmTokens?: number;
  /** False when the rule says to wait for the turn instead of steering. */
  allowSteer?: boolean;
  /** How the open or accepted request was made. */
  via?: "steer" | "start";
  /** This episode used its steer: accepted, refused, or found ineffective. */
  steerUsed?: boolean;
  /** This episode started a compaction turn the provider accepted. */
  startUsed?: boolean;
  /** Refused requests this episode. */
  refusals?: number;
  /** The turn the request was steered into, or the compaction turn. */
  turnId?: string;
  /** That turn has ended. */
  turnEnded?: boolean;
  /** The fill when the request was made. */
  dispatchedAtTokens?: number;
  /**
   * The fill dropped, or the provider reported a compaction, while a request
   * was unanswered. The answer then settles the episode.
   */
  evidence?: boolean;
  heldReason?: AutoCompactionHeldReason;
};

/** What the owner can do for this thread right now. */
export type AutoCompactionContext = {
  /** A turn is running. */
  turnRunning: boolean;
  /** The running turn's id, when known. */
  turnId?: string;
  /** The provider takes a steered `/compact` into a running turn. */
  canSteer: boolean;
  /**
   * Whether an idle compaction can start: `yes`; `blocked` while a gate holds
   * the thread (a lock, a paused project, a restart); or `unsupported` when
   * the provider has no way to compact.
   */
  canStart: "yes" | "blocked" | "unsupported";
};

export type AutoCompactionThresholdInput = {
  triggerTokens: number;
  rearmTokens: number;
  /** `wait` never steers. */
  duringTurn: "steer" | "wait";
};

export type AutoCompactionInput =
  | {
      kind: "fill";
      usedTokens: number;
      /** Undefined when no enabled rule matches this thread. */
      threshold?: AutoCompactionThresholdInput;
      context: AutoCompactionContext;
    }
  | { kind: "turn-started"; turnId: string }
  | { kind: "turn-ended"; turnId?: string; context: AutoCompactionContext }
  | { kind: "compaction-observed"; context: AutoCompactionContext }
  | { kind: "dispatch-accepted"; turnId?: string; context: AutoCompactionContext }
  | { kind: "dispatch-refused"; context: AutoCompactionContext }
  /**
   * The thread was busy (a lock, a queued message that started first, an
   * archive). Not a refusal: the request waits for the next opening.
   */
  | { kind: "dispatch-deferred" }
  /** The compaction's turn ended a while ago and no evidence came. */
  | { kind: "settle-timeout"; context: AutoCompactionContext }
  | { kind: "reset" };

export type AutoCompactionCommand =
  | { kind: "steer-compact"; turnId: string; usedTokens: number; triggerTokens: number }
  | { kind: "start-compact"; usedTokens: number; triggerTokens: number }
  | { kind: "start-continuation" };

export type AutoCompactionStep = {
  state: AutoCompactionState;
  command?: AutoCompactionCommand;
};

export const AUTO_COMPACTION_MAX_REFUSALS = 3;

export const INITIAL_AUTO_COMPACTION_STATE: AutoCompactionState = { phase: "armed" };

/** A new episode: keeps the last reading and threshold, forgets the rest. */
function armed(state: AutoCompactionState): AutoCompactionState {
  return {
    phase: "armed",
    ...(state.lastFill !== undefined ? { lastFill: state.lastFill } : {}),
    ...(state.triggerTokens !== undefined ? { triggerTokens: state.triggerTokens } : {}),
    ...(state.rearmTokens !== undefined ? { rearmTokens: state.rearmTokens } : {}),
    ...(state.allowSteer !== undefined ? { allowSteer: state.allowSteer } : {}),
  };
}

function held(state: AutoCompactionState, reason: AutoCompactionHeldReason): AutoCompactionState {
  return { ...armed(state), phase: "held", heldReason: reason };
}

/**
 * Leave `due` when an opening exists. A steer goes only into a running turn
 * whose id is known; a compaction turn starts only on an idle thread.
 */
function dispatch(state: AutoCompactionState, context: AutoCompactionContext): AutoCompactionStep {
  if (state.lastFill === undefined || state.triggerTokens === undefined || state.lastFill < state.triggerTokens) {
    return { state: armed(state) };
  }
  const due: AutoCompactionState = {
    ...state,
    phase: "due",
    via: undefined,
    turnId: undefined,
    turnEnded: undefined,
    dispatchedAtTokens: undefined,
    evidence: undefined,
    heldReason: undefined,
  };
  const usedTokens = state.lastFill ?? 0;
  const triggerTokens = state.triggerTokens ?? 0;
  if (context.turnRunning) {
    if (state.allowSteer !== false && context.canSteer && context.turnId && !state.steerUsed) {
      return {
        state: {
          ...due,
          phase: "steering",
          via: "steer",
          turnId: context.turnId,
          turnEnded: false,
          dispatchedAtTokens: usedTokens,
        },
        command: { kind: "steer-compact", turnId: context.turnId, usedTokens, triggerTokens },
      };
    }
    return { state: due };
  }
  if (state.startUsed) {
    // This episode's compaction turn already ran without bringing it down.
    return { state: held(state, "no-shrink") };
  }
  if (context.canStart === "unsupported") return { state: held(state, "unsupported") };
  if (context.canStart === "blocked") return { state: due };
  return {
    state: { ...due, phase: "starting", via: "start", dispatchedAtTokens: usedTokens },
    command: { kind: "start-compact", usedTokens, triggerTokens },
  };
}

/** The fill came down, or the provider reported a compaction. */
function completed(state: AutoCompactionState, context: AutoCompactionContext): AutoCompactionStep {
  if (state.via !== "steer") return { state: armed(state) };
  if (!context.turnRunning) {
    return { state: armed(state), command: { kind: "start-continuation" } };
  }
  // Still in the steered turn: continue when it ends. In a later turn, that
  // turn carries the work on, so nothing is sent.
  return state.turnEnded
    ? { state: armed(state) }
    : { state: { ...armed(state), phase: "resume" } };
}

/** A compaction ran and the fill is still at or above the trigger. */
function retryOrHold(state: AutoCompactionState, context: AutoCompactionContext): AutoCompactionStep {
  if (state.via === "steer" && !state.startUsed) {
    // The agent likely read the steered `/compact` as text. Try once more as
    // a compaction turn of its own.
    return dispatch({ ...state, steerUsed: true }, context);
  }
  return { state: held(state, "no-shrink") };
}

export function stepAutoCompaction(
  state: AutoCompactionState,
  input: AutoCompactionInput,
): AutoCompactionStep {
  switch (input.kind) {
    case "reset":
      return { state: INITIAL_AUTO_COMPACTION_STATE };

    case "fill": {
      const threshold = input.threshold;
      if (!threshold) {
        // No enabled rule. An open request keeps its tracking so its answer is
        // still recorded; anything else rests.
        if (state.phase === "steering" || state.phase === "starting") {
          return { state: { ...state, lastFill: input.usedTokens } };
        }
        return { state: { phase: "armed", lastFill: input.usedTokens } };
      }
      const next: AutoCompactionState = {
        ...state,
        lastFill: input.usedTokens,
        triggerTokens: threshold.triggerTokens,
        rearmTokens: threshold.rearmTokens,
        allowSteer: threshold.duringTurn !== "wait",
      };
      const below = input.usedTokens < threshold.triggerTokens;
      switch (state.phase) {
        case "armed":
        case "due":
          return below ? { state: armed(next) } : dispatch(next, input.context);
        case "steering":
        case "starting":
          return { state: below ? { ...next, evidence: true } : next };
        case "resume":
          return { state: next };
        case "compacting":
          if (below) return completed(next, input.context);
          return next.turnEnded ? retryOrHold(next, input.context) : { state: next };
        case "held":
          return input.usedTokens < threshold.rearmTokens ? { state: armed(next) } : { state: next };
      }
      return { state: next };
    }

    case "turn-started":
      if (state.phase === "resume") {
        // The next turn started without us and carries on the work.
        return { state: armed(state) };
      }
      if (
        (state.phase === "starting" || state.phase === "compacting")
        && state.via === "start"
        && state.turnId === undefined
      ) {
        // The compaction turn, before its request was answered with an id.
        return { state: { ...state, turnId: input.turnId, turnEnded: false } };
      }
      return { state };

    case "turn-ended":
      switch (state.phase) {
        case "due":
          return dispatch(state, input.context);
        case "resume":
          return { state: armed(state), command: { kind: "start-continuation" } };
        case "steering":
        case "starting":
        case "compacting": {
          const sameTurn = input.turnId === undefined
            || state.turnId === undefined
            || input.turnId === state.turnId;
          return sameTurn ? { state: { ...state, turnEnded: true } } : { state };
        }
        default:
          return { state };
      }

    case "compaction-observed":
      switch (state.phase) {
        case "compacting":
          return completed(state, input.context);
        case "steering":
        case "starting":
          // Evidence can arrive before the request's answer, which settles it.
          return { state: { ...state, evidence: true } };
        case "due":
        case "held":
          // The provider compacted on its own.
          return { state: armed(state) };
        default:
          return { state };
      }

    case "dispatch-accepted": {
      if (state.phase !== "steering" && state.phase !== "starting") return { state };
      const accepted: AutoCompactionState = {
        ...state,
        phase: "compacting",
        ...(state.via === "steer" ? { steerUsed: true } : { startUsed: true }),
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        turnEnded: state.via === "steer" ? state.turnEnded === true : false,
        evidence: undefined,
      };
      // Evidence that came first settles it now.
      return state.evidence ? completed(accepted, input.context) : { state: accepted };
    }

    case "dispatch-refused": {
      if (state.phase !== "steering" && state.phase !== "starting") return { state };
      // The context came down anyway, by the provider's own compaction.
      if (state.evidence) return { state: armed(state) };
      const refusals = (state.refusals ?? 0) + 1;
      if (refusals >= AUTO_COMPACTION_MAX_REFUSALS) {
        return { state: held({ ...state, refusals }, "refused") };
      }
      // A refused steer is not steered again this episode.
      return dispatch(
        { ...state, refusals, ...(state.via === "steer" ? { steerUsed: true } : {}) },
        input.context,
      );
    }

    case "dispatch-deferred":
      if (state.phase !== "steering" && state.phase !== "starting") return { state };
      if (state.evidence) return { state: armed(state) };
      return {
        state: {
          ...state,
          phase: "due",
          via: undefined,
          turnId: undefined,
          turnEnded: undefined,
          dispatchedAtTokens: undefined,
        },
      };

    case "settle-timeout":
      if (state.phase !== "compacting" || !state.turnEnded) return { state };
      return (state.lastFill ?? 0) < (state.triggerTokens ?? 0)
        ? completed(state, input.context)
        : retryOrHold(state, input.context);
  }
}

/** Phases where a request is open or its evidence is awaited. */
export function isAutoCompactionInFlight(phase: AutoCompactionPhase): boolean {
  return phase === "steering" || phase === "starting" || phase === "compacting";
}
