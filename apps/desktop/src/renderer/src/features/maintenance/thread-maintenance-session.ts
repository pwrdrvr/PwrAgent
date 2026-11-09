import { useCallback, useMemo, useReducer } from "react";
import type { ThreadMaintenancePhase } from "./thread-maintenance-run-state";

/**
 * One thread maintenance session per window: the dialog's mode, plan, rules,
 * idle days, scan, selections, review step and run. The dialog stays mounted
 * for the whole session, so minimizing hides it without losing any of that,
 * and a scan or run that ends while it is hidden lands in the same session.
 *
 * A plan is a session too: the operator may have changed the mode or rules
 * before minimizing. So every launch (File, Settings, an agent) reopens the
 * session there is, and only an explicit discard ends one. Discard drops the
 * dialog's state and nothing else; a run already started keeps going in main
 * and shows again on the next open. Stopping a run is the run's own button.
 */
export type ThreadMaintenanceSession = {
  /** Changes only when a new session starts, so it can key the dialog. */
  id: number;
  projectKey?: string;
  minimized: boolean;
  /** The operator closed the minimized notice. The session stays, File →
   * Thread Maintenance… reopens it, and the notice comes back when the
   * session reaches another phase, such as a scan finishing. */
  noticeHidden: boolean;
};

/** What the dialog tells its host, for the minimized notice. */
export type ThreadMaintenanceSessionStatus = {
  phase: ThreadMaintenancePhase;
  /** A short progress or result line, such as "12 / 40" or "3 found". */
  detail?: string;
};

export type ThreadMaintenanceSessionState = {
  session?: ThreadMaintenanceSession;
  status?: ThreadMaintenanceSessionStatus;
  nextId: number;
};

export type ThreadMaintenanceSessionAction =
  | { type: "launch"; projectKey?: string }
  | { type: "minimize" }
  | { type: "restore" }
  | { type: "hideNotice" }
  | { type: "status"; status: ThreadMaintenanceSessionStatus }
  | { type: "discard" };

export const INITIAL_THREAD_MAINTENANCE_SESSION: ThreadMaintenanceSessionState = { nextId: 1 };

function shown(session: ThreadMaintenanceSession): ThreadMaintenanceSession {
  return session.minimized || session.noticeHidden ? { ...session, minimized: false, noticeHidden: false } : session;
}

export function threadMaintenanceSessionReducer(
  state: ThreadMaintenanceSessionState,
  action: ThreadMaintenanceSessionAction,
): ThreadMaintenanceSessionState {
  const session = state.session;
  switch (action.type) {
    case "launch":
      if (session) {
        const next = shown(session);
        return next === session ? state : { ...state, session: next };
      }
      return {
        nextId: state.nextId + 1,
        session: {
          id: state.nextId, minimized: false, noticeHidden: false,
          ...(action.projectKey ? { projectKey: action.projectKey } : {}),
        },
      };
    case "restore": {
      if (!session) return state;
      const next = shown(session);
      return next === session ? state : { ...state, session: next };
    }
    case "minimize":
      return session && !session.minimized ? { ...state, session: { ...session, minimized: true, noticeHidden: false } } : state;
    case "hideNotice":
      return session?.minimized && !session.noticeHidden ? { ...state, session: { ...session, noticeHidden: true } } : state;
    case "status": {
      if (!session) return state;
      const current = state.status;
      if (current?.phase === action.status.phase && current.detail === action.status.detail) return state;
      // A new phase is news: the notice comes back to say so.
      const phaseChanged = current !== undefined && current.phase !== action.status.phase;
      return {
        ...state,
        status: action.status,
        ...(phaseChanged && session.noticeHidden ? { session: { ...session, noticeHidden: false } } : {}),
      };
    }
    case "discard":
      return session ? { nextId: state.nextId } : state;
  }
}

/** The minimized notice's text for a session's status. */
export function sessionNoticeText(status: ThreadMaintenanceSessionStatus | undefined): {
  message: string;
  state: "progress" | "success" | undefined;
  label: string;
} {
  const detail = status?.detail ? ` · ${status.detail}` : "";
  switch (status?.phase) {
    case "scanning":
      return { message: `Scanning${detail}. The review opens here when it is ready.`, state: "progress", label: "Scanning" };
    case "threads":
    case "hibernate":
    case "checkouts":
      return { message: `Review ready${detail}. Your selections are kept; nothing changes until you run it.`,
        state: undefined, label: "Review" };
    case "running":
      return { message: `Running${detail}. It keeps going while this is minimized.`, state: "progress", label: "Running" };
    case "finished":
      return { message: `Finished${detail}. Reopen it to read the results.`, state: "success", label: "Finished" };
    default:
      return { message: "Your plan is kept. Reopen it to scan.", state: undefined, label: "Plan" };
  }
}

/** Discarding drops a scan in flight or a run's view, so it is offered only
 * once neither is under way. Closing the notice is always safe. */
export function sessionCanDiscard(status: ThreadMaintenanceSessionStatus | undefined): boolean {
  return status?.phase !== "scanning" && status?.phase !== "running";
}

/** App's thread maintenance lifecycle. The dialog reports its status here,
 * and every launch, minimize, reopen and discard goes through the reducer. */
export function useThreadMaintenanceSession() {
  const [state, dispatch] = useReducer(threadMaintenanceSessionReducer, INITIAL_THREAD_MAINTENANCE_SESSION);
  const report = useCallback((status: ThreadMaintenanceSessionStatus) => dispatch({ type: "status", status }), []);
  const launch = useCallback((request: { projectKey?: string } = {}) => {
    dispatch({ type: "launch", ...(request.projectKey ? { projectKey: request.projectKey } : {}) });
  }, []);
  const minimize = useCallback(() => dispatch({ type: "minimize" }), []);
  const restore = useCallback(() => dispatch({ type: "restore" }), []);
  const hideNotice = useCallback(() => dispatch({ type: "hideNotice" }), []);
  const discard = useCallback(() => dispatch({ type: "discard" }), []);
  return useMemo(() => ({
    session: state.session, status: state.status, report, launch, minimize, restore, hideNotice, discard,
  }), [discard, hideNotice, launch, minimize, report, restore, state.session, state.status]);
}

export type ThreadMaintenanceSessionController = ReturnType<typeof useThreadMaintenanceSession>;
