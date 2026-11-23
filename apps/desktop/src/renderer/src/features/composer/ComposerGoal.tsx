import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  validateThreadGoalObjective,
  type ThreadGoalState,
  type ThreadGoalView,
} from "@pwragent/shared/contracts/thread-goal";
import type { AppServerNotification } from "@pwragent/shared/contracts/normalized-app-server";
import type { DesktopApi } from "../../lib/desktop-api";
import { useModalDialog } from "../../lib/useModalDialog";
import type { ComposerErrorEntry } from "./ComposerErrorRail";

type GoalCommand = { action: "set"; objective: string }
  | { action: "read" | "pause" | "resume" | "clear" | "cancel" };

export const GOAL_ARGUMENT_HINT = "objective | pause | resume | clear";

export function parseGoalCommand(draft: string): GoalCommand | undefined {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(draft.trim());
  if (!match) return undefined;
  const objective = match[1]?.trim();
  if (!objective) return { action: "read" };
  const action = objective.toLowerCase();
  return action === "pause" || action === "resume" || action === "clear"
    ? { action }
    : { action: "set", objective };
}

type GoalAction = GoalCommand["action"];

const actionLabels: Record<GoalAction, string> = {
  read: "Show goal", set: "Set goal", pause: "Pause goal",
  resume: "Resume goal", clear: "Clear goal", cancel: "Cancel goal",
};
const busyLabels: Record<GoalAction, string> = {
  read: "Loading goal…", set: "Setting…", pause: "Pausing…",
  resume: "Resuming…", clear: "Clearing…", cancel: "Cancelling…",
};
const errorLabels: Record<GoalAction, string> = {
  read: "Goal not loaded", set: "Goal not set", pause: "Goal not paused",
  resume: "Goal not resumed", clear: "Goal not cleared", cancel: "Goal not cancelled",
};

function requestGoal(api: DesktopApi | undefined, threadId: string, command: GoalCommand, confirmedObjective?: string) {
  switch (command.action) {
    case "read": return api?.readThreadGoal?.(threadId);
    case "set": return api?.setThreadGoal?.(threadId, command.objective, confirmedObjective);
    case "pause": return api?.pauseThreadGoal?.(threadId);
    case "resume": return api?.resumeThreadGoal?.(threadId);
    case "clear": return api?.clearThreadGoal?.(threadId, confirmedObjective);
    case "cancel": return api?.cancelThreadGoalActivation?.(threadId);
  }
}

type Confirmation = {
  command: GoalCommand;
  objective: string;
  onAccepted?: () => void;
};

export function useComposerGoal(api: DesktopApi | undefined, threadId: string | undefined) {
  const [snapshot, setSnapshot] = useState<{ threadId: string; state: ThreadGoalState }>();
  const [requests, setRequests] = useState<ReadonlyMap<string, GoalCommand>>(() => new Map());
  const [error, setError] = useState<{ threadId: string; entry: ComposerErrorEntry }>();
  const [confirmation, setConfirmation] = useState<{ threadId: string; value: Confirmation }>();
  const [showCount, setShowCount] = useState(0);
  const scope = useRef({ threadId, revision: 0, busy: false, occurrence: 0 });
  if (scope.current.threadId !== threadId) {
    scope.current = { threadId, revision: 0, busy: false, occurrence: 0 };
  }
  const state = snapshot?.threadId === threadId ? snapshot?.state : undefined;
  const busy = threadId ? requests.get(threadId)?.action : undefined;

  useEffect(() => {
    if (!threadId) return;
    const current = scope.current;
    let alive = true;
    const refresh = () => {
      const revision = current.revision;
      void api?.readThreadGoal?.(threadId).then((next) => {
        if (alive && current.revision === revision && scope.current === current) {
          setSnapshot({ threadId, state: next });
        }
      }, () => undefined);
    };
    const unsubscribe = api?.onAgentEvent?.((event) => {
      if (event.backend !== "codex" || event.federationTarget?.scope === "remote") return;
      if (event.notification.method === "thread/goal/controlChanged" && event.notification.params.threadId === threadId) {
        const { state: next } = (event.notification as Extract<AppServerNotification, { method: "thread/goal/controlChanged" }>).params;
        current.revision++;
        setSnapshot({ threadId, state: next });
      } else if (event.notification.method === "thread/started"
        && (event.notification as Extract<AppServerNotification, { method: "thread/started" }>).params.thread?.id === threadId) {
        refresh();
      }
    });
    const unsubscribeRestart = api?.onCodexRestartStatusChanged?.((status) => {
      if (!status.stopped) refresh();
    });
    refresh();
    return () => {
      alive = false;
      unsubscribe?.();
      unsubscribeRestart?.();
    };
  }, [api, threadId]);

  const run = async (
    command: GoalCommand,
    notice: (message: string, label?: string) => void,
    onAccepted?: () => void,
    confirmedObjective?: string,
  ): Promise<void> => {
    const current = scope.current;
    if (!threadId || current.busy || busy) return;
    if (state?.supported === false || !api?.readThreadGoal) {
      notice("This Codex version doesn’t support goals.");
      return;
    }
    if (command.action === "set") {
      const invalid = validateThreadGoalObjective(command.objective);
      if (invalid) {
        notice(invalid, errorLabels.set);
        return;
      }
    }
    const goal = state?.goal;
    if (state?.supported && !goal && command.action !== "read" && command.action !== "set") {
      notice(command.action === "pause" ? "No goal to pause." : "No goal on this thread.");
      return;
    }
    if (goal && goal.status !== "complete" && confirmedObjective !== goal.objective
      && (command.action === "clear" || (command.action === "set" && command.objective !== goal.objective))) {
      setConfirmation({ threadId, value: { command, objective: goal.objective, onAccepted } });
      return;
    }
    current.busy = true;
    const revision = current.revision;
    const request = { ...command };
    setRequests((pending) => new Map(pending).set(threadId, request));
    setError(undefined);
    try {
      const result = await requestGoal(api, threadId, command, confirmedObjective);
      if (scope.current !== current) return;
      if (!result?.supported) {
        notice("This Codex version doesn’t support goals.");
        return;
      }
      if (revision === current.revision) setSnapshot({ threadId, state: result });
      if (result.confirmationRequired && result.goal) {
        setConfirmation({ threadId, value: { command, objective: result.goal.objective, onAccepted } });
        return;
      }
      if (result.refusal) {
        notice(result.refusal, errorLabels[command.action]);
        return;
      }
      if (command.action === "read") {
        if (!result.goal) {
          notice("No goal on this thread.");
          return;
        }
        setShowCount((count) => count + 1);
      }
      onAccepted?.();
    } catch (failure) {
      if (scope.current !== current) return;
      setError({ threadId, entry: {
        id: "codex-goal",
        label: errorLabels[command.action],
        message: failure instanceof Error ? failure.message : String(failure),
        occurrence: ++current.occurrence,
        retry: { label: "Retry", onClick: () => void run(command, notice, onAccepted, confirmedObjective) },
      } });
    } finally {
      current.busy = false;
      setRequests((pending) => {
        if (pending.get(threadId) !== request) return pending;
        const remaining = new Map(pending);
        remaining.delete(threadId);
        return remaining;
      });
    }
  };

  return {
    state,
    busy,
    error: error?.threadId === threadId ? error?.entry : undefined,
    showCount,
    run,
    confirmation: confirmation?.threadId === threadId ? confirmation?.value : undefined,
    dismissConfirmation: () => setConfirmation(undefined),
    label: (command: GoalCommand) => busy
      ? busyLabels[busy]
      : command.action === "set" && state?.goal && state.goal.objective !== command.objective
        && state.goal.status !== "complete" ? "Replace goal" : actionLabels[command.action],
  };
}

const statusLabels: Record<ThreadGoalView["status"], string> = {
  active: "",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limit",
  budgetLimited: "Budget limit",
  complete: "Complete",
};

const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function ComposerGoalStrip(props: {
  goal: ThreadGoalView;
  pausedForMessage?: boolean;
  activationQueued?: boolean;
  activationHoldReason?: string;
  busy?: GoalAction;
  showCount: number;
  onCommand: (command: GoalCommand) => void;
}) {
  const { goal } = props;
  const [open, setOpen] = useState(false);
  const [openAt, setOpenAt] = useState(props.showCount);
  const detailId = useId();
  const status = props.activationHoldReason ? "Start held"
    : props.activationQueued ? "Starts after this turn"
    : props.pausedForMessage ? "Paused for your message" : statusLabels[goal.status];
  const warning = !!props.activationHoldReason || goal.status === "blocked" || goal.status === "usageLimited" || goal.status === "budgetLimited";
  const expanded = props.showCount !== openAt || open;
  const usage = compactNumber.format(goal.tokensUsed)
    + (goal.tokenBudget === null ? "" : ` / ${compactNumber.format(goal.tokenBudget)}`);
  const minutes = Math.floor(goal.timeUsedSeconds / 60);
  return (
    <div className="composer__queued composer-goal" data-status={goal.status} data-warning={warning || undefined}>
      <button
        aria-controls={detailId}
        aria-expanded={expanded}
        className="composer-goal__summary"
        onClick={() => { setOpen(!expanded); setOpenAt(props.showCount); }}
        type="button"
      >
        <span className="composer__queued-env-action-chevron" aria-hidden="true" />
        <span className="composer__queued-label">{status ? `Goal · ${status}` : "Goal"}</span>
        <span className="composer__queued-text">{props.activationHoldReason ?? goal.objective}</span>
      </button>
      {!props.activationQueued && (
        <span className="composer-goal__usage">
          {minutes > 0 ? `${minutes}m · ` : ""}{usage} tok
        </span>
      )}
      <div className="composer-goal__actions">
        {props.activationQueued ? (
          <>
            {props.activationHoldReason && (
              <button className="composer__secondary-action" disabled={!!props.busy} type="button"
                onClick={() => props.onCommand({ action: "resume" })}>
                {props.busy === "resume" ? "Retrying…" : "Retry"}
              </button>
            )}
            <button className="composer__secondary-action" disabled={!!props.busy} type="button"
              onClick={() => props.onCommand({ action: "cancel" })}>Cancel</button>
          </>
        ) : (
          <>
            {!props.pausedForMessage && goal.status !== "complete" && (
              <button className="composer__secondary-action" disabled={!!props.busy} type="button"
                onClick={() => props.onCommand({ action: goal.status === "active" ? "pause" : "resume" })}>
                {props.busy === "pause" || props.busy === "resume" ? busyLabels[props.busy]
                  : goal.status === "active" ? "Pause" : "Resume"}
              </button>
            )}
            <button className="composer__secondary-action" disabled={!!props.busy} type="button"
              onClick={() => props.onCommand({ action: "clear" })}>
              {props.busy === "clear" ? busyLabels.clear : "Clear"}
            </button>
          </>
        )}
      </div>
      <div id={detailId} className="composer-goal__detail" hidden={!expanded}
        key={props.showCount} data-show={props.showCount > 0 || undefined}>
        {props.activationHoldReason ? `${props.activationHoldReason}\n${goal.objective}` : goal.objective}
      </div>
    </div>
  );
}

export function ComposerGoalConfirmation(props: {
  confirmation: Confirmation;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const title = useId();
  const description = useId();
  const confirm = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const replacement = props.confirmation.command.action === "set" ? props.confirmation.command.objective : undefined;
  const dialog = useModalDialog<HTMLElement>({
    onClose: props.onCancel,
    initialFocus: replacement === undefined ? cancel : confirm,
  });
  return createPortal(
    <div className="rename-thread-backdrop" role="presentation">
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={title}
        aria-describedby={description} className="rename-thread-dialog composer-goal-dialog">
        <h2 id={title}>{replacement === undefined ? "Clear this goal?" : "Replace the current goal?"}</h2>
        <div className="composer-goal-dialog__content" role="region" aria-label="Goal details" tabIndex={0}>
          <p id={description}>{replacement === undefined
            ? "Codex stops working toward this goal and loses its time and token counts. The running turn continues."
            : "Codex stops working toward the current goal and starts on the new one."}</p>
          <dl>
            <dt>{replacement === undefined ? "Goal" : "Now"}</dt>
            <dd>{props.confirmation.objective}</dd>
            {replacement !== undefined && <><dt>New</dt><dd>{replacement}</dd></>}
          </dl>
        </div>
        <div className="rename-thread-dialog__actions">
          <button ref={cancel} className="button button--secondary" type="button" onClick={props.onCancel}>Cancel</button>
          <button ref={confirm} className="button button--primary" type="button" onClick={props.onConfirm}>
            {replacement === undefined ? "Clear goal" : "Replace goal"}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
