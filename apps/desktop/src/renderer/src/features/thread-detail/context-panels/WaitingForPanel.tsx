import { memo, useState, type ReactNode } from "react";
import {
  THREAD_DEPENDENCY_CONDITION_PHRASES,
  THREAD_PR_WATCH_CONTROL_CAPABILITY,
  buildPullRequestStatusKey,
  graphemePrefix,
  isThreadPendingWakeLive,
  type NavigationThreadSummary,
  type ThreadPendingWake,
  type ThreadPendingWakeHold,
  type ThreadPendingWakeKind,
} from "@pwragent/shared";
import {
  ChevronRightIcon,
  ClockIcon,
  ContinueAfterIcon,
  EyeIcon,
  HistoryIcon,
  LockIcon,
  MergeIcon,
  PauseIcon,
  PullRequestIcon,
  RadarIcon,
  TerminalIcon,
} from "../../../icons";
import { describeCiOutcomes } from "../../pr-status/PrStatusCard";
import { formatWatchTime } from "../../pr-watches/PullRequestWatchList";
import { isCiWatch, readWatchRunAttempt } from "../../pr-watches/useThreadPrWatchIndicators";
import type { ThreadPendingWakesController } from "../../thread-pending-wakes/useThreadPendingWakes";
import type { ContextTabId } from "./context-tab";

type WaitingForPanelProps = {
  thread: NavigationThreadSummary;
  controller: ThreadPendingWakesController;
  /** Set for a peer's thread: the wakes run there. */
  ownerLabel?: string;
  onTurnOffAutoFix?: () => Promise<void>;
  onSendScheduledNow?: (actionId: string) => Promise<void>;
  /** Sends a wake-up a paused project holds, through the project's own release. */
  onSendHeldNow?: (wake: HeldMessageWake) => Promise<void>;
  /** Unlocks the thread, which sends what the lock held. */
  onUnlockThread?: () => Promise<void>;
  /** Opens the rail tab that owns a row, for more than this list shows. */
  onShowTab?: (tab: ContextTabId) => void;
  /** Opens Continue After for this thread. */
  onOpenContinueAfter?: () => void;
  /** Injected by tests so times are deterministic. */
  now?: number;
};

type Group = { id: string; label: string; aside?: string; wakes: ThreadPendingWake[] };

export type HeldMessageWake = Extract<ThreadPendingWake, { kind: "held_message" }>;

type BackendWake = Extract<ThreadPendingWake, { kind: "backend_wake" }>;

/** Ended rows one list shows. */
const ENDED_ROWS = 8;

/**
 * The Waiting for tab: everything that will start a turn on this thread
 * later, grouped soonest first, each with the stop its source already has.
 * Rows reuse the Pull requests card's watch-list row.
 */
export const WaitingForPanel = memo(function WaitingForPanel(props: WaitingForPanelProps) {
  const { state } = props.controller;
  const [openKey, setOpenKey] = useState<string>();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string>();
  const [endedOpen, setEndedOpen] = useState(false);
  const now = props.now ?? Date.now();
  const capabilities = props.thread.federation?.capabilities ?? [];
  const peer = state.status === "ready" && state.peer;
  const [unlocking, setUnlocking] = useState(false);

  if (state.status !== "ready") {
    return (
      <section className="context-panel__section waiting-for-panel">
        <header className="waiting-for-panel__header"><h3>Waiting for</h3></header>
        <p className="context-empty">
          {state.status === "loading" ? "Loading…"
            : props.ownerLabel ? `${props.ownerLabel} does not share what will wake this thread.`
            : "This window cannot read what will wake this thread."}
        </p>
      </section>
    );
  }

  const run = (key: string, action: () => Promise<void>): void => {
    setBusy((current) => new Set(current).add(key));
    setError(undefined);
    void action()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      }));
  };
  const stop = (wake: ThreadPendingWake): void => run(wake.key, async () => {
    if (wake.kind === "pr_auto_fix") {
      await props.onTurnOffAutoFix?.();
      return;
    }
    const response = await props.controller.stop(wake.key);
    if (!response.ok) throw new Error(response.error.message);
  });
  const canStop = (wake: ThreadPendingWake): boolean => {
    if (!wake.stop) return false;
    if (wake.kind === "pr_auto_fix") return !peer && Boolean(props.onTurnOffAutoFix);
    if (!peer) return true;
    // A peer stops only what its owner already accepts from a viewer.
    switch (wake.kind) {
      case "pr_watch":
        return capabilities.includes(THREAD_PR_WATCH_CONTROL_CAPABILITY) && capabilities.includes("turn_control");
      case "scheduled_action":
        return capabilities.includes("scheduled_actions");
      case "monitor":
      case "backend_task":
      case "held_message":
        return capabilities.includes("turn_control");
      default:
        return false;
    }
  };

  // An owner newer than this window can list kinds it cannot draw.
  const wakes = state.wakes.filter((wake) => KNOWN_KINDS.has(wake.kind));
  const groups = groupWakes(wakes, props.thread);
  // Auto-fix on an ended PR is listed but waits for nothing.
  const liveCount = wakes.filter(isThreadPendingWakeLive).length;
  const readOnlyOnPeer = peer && wakes.some((wake) => wake.stop && !canStop(wake));
  const endedRows = state.ended.slice(0, ENDED_ROWS);
  const notice = readHoldNotice(props.thread, wakes);
  // A peer sends a held wake-up only through its project's release.
  const canSendHeld = (wake: ThreadPendingWake): boolean => wake.held?.kind === "project_paused"
    && Boolean(props.onSendHeldNow)
    && (!peer || (capabilities.includes("project_forge_automation") && capabilities.includes("turn_control")));
  const unlock = props.onUnlockThread;

  return (
    <section className="context-panel__section waiting-for-panel">
      <header className="waiting-for-panel__header">
        <h3>Waiting for</h3>
        {liveCount > 0 ? <span className="waiting-for-panel__count">{liveCount}</span> : null}
      </header>
      <div className="waiting-for-panel__body">
        {notice ? (
          <div className="waiting-for-panel__hold" role="note">
            <span className="waiting-for-panel__hold-icon" aria-hidden="true">
              {notice.kind === "thread_locked" ? <LockIcon size={12} /> : <PauseIcon size={12} />}
            </span>
            <span className="waiting-for-panel__hold-text">
              <span className="waiting-for-panel__hold-title">{describeHoldTitle(notice)}</span>
              <span className="pr-watch-list__sub">{describeHoldRelease(notice, Boolean(unlock), props.ownerLabel)}</span>
            </span>
            {notice.kind === "thread_locked" && unlock ? (
              <button
                type="button"
                className="pr-watch-list__action"
                disabled={unlocking}
                onClick={() => {
                  setUnlocking(true);
                  setError(undefined);
                  void unlock()
                    .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
                    .finally(() => setUnlocking(false));
                }}
              >
                Unlock
              </button>
            ) : null}
          </div>
        ) : null}
        {liveCount === 0 ? (
          <div className="waiting-for-panel__empty">
            <p className="waiting-for-panel__empty-title">{state.incomplete ? "Could not confirm everything this thread is waiting for." : "Nothing will wake this thread."}</p>
            <p className="pr-watch-list__sub">
              It runs again when a message is sent. An agent can watch CI, wait for another
              thread, or start a monitor; ask it to.
            </p>
          </div>
        ) : null}
        {groups.map((group) => (
          <div className="waiting-for-panel__group" key={group.id} role="group" aria-label={group.label}>
            <p className="pr-watch-list__eyebrow waiting-for-panel__eyebrow">
              <span>{group.label}</span>
              {group.aside ? <span className="waiting-for-panel__eyebrow-aside">{group.aside}</span> : null}
            </p>
            {group.wakes.map((wake) => {
              const view = describeWake(wake, props.thread, now, props.ownerLabel, canSendHeld(wake));
              const open = openKey === wake.key;
              const detail = open ? renderDetail(wake, props, now) : null;
              return (
                <div
                  className={`pr-watch-list__row waiting-for-panel__row${open ? " is-open" : ""}${
                    isThreadPendingWakeLive(wake) ? "" : " is-idle"
                  }`}
                  key={wake.key}
                >
                  <span className="pr-watch-list__icon" aria-hidden="true">{view.icon}</span>
                  <span className="pr-watch-list__text">
                    <button
                      type="button"
                      className="waiting-for-panel__title-button pr-watch-list__title"
                      aria-expanded={open}
                      onClick={() => setOpenKey(open ? undefined : wake.key)}
                    >
                      {view.title}
                    </button>
                    <span className="pr-watch-list__sub">{view.sub}</span>
                    {detail}
                  </span>
                  <span className="waiting-for-panel__actions">
                    {wake.kind === "held_message" && canSendHeld(wake) ? (
                      <button
                        type="button"
                        className="pr-watch-list__action"
                        aria-label={`Send Now: ${view.plainTitle}`}
                        disabled={busy.has(wake.key)}
                        onClick={() => run(wake.key, async () => {
                          await props.onSendHeldNow!(wake);
                          props.controller.ended(wake.key);
                        })}
                      >
                        Send Now
                      </button>
                    ) : null}
                    {wake.kind === "scheduled_action" && wake.status === "scheduled" && !peer && props.onSendScheduledNow ? (
                      <button
                        type="button"
                        className="pr-watch-list__action"
                        disabled={busy.has(wake.key)}
                        onClick={() => run(wake.key, async () => await props.onSendScheduledNow!(wake.actionId))}
                      >
                        {wake.actionKind === "review" ? "Run Now" : "Send Now"}
                      </button>
                    ) : null}
                    {canStop(wake) ? (
                      <button
                        type="button"
                        className="pr-watch-list__action"
                        aria-label={`${stopLabel(wake)}: ${view.plainTitle}`}
                        disabled={busy.has(wake.key)}
                        onClick={() => stop(wake)}
                      >
                        {stopLabel(wake)}
                      </button>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {error ? <p className="waiting-for-panel__error" role="alert">{error}</p> : null}
        {state.incomplete ? (
          <p className="pr-watch-list__sub">This list is incomplete. Some wakes may be missing.</p>
        ) : null}
        {readOnlyOnPeer ? (
          <p className="pr-watch-list__owner">{`Some of these run on ${props.ownerLabel ?? "the thread's own machine"}. Stop them there.`}</p>
        ) : null}
        {!peer ? (
          <div className="waiting-for-panel__ended">
            <button
              type="button"
              className="pr-watch-list__history-toggle waiting-for-panel__ended-toggle"
              aria-expanded={endedOpen}
              onClick={() => setEndedOpen((current) => !current)}
            >
              <ChevronRightIcon size={10} />
              {`Recently ended (${endedRows.length})`}
            </button>
            {endedOpen ? (
              endedRows.length === 0 ? (
                <p className="pr-watch-list__sub">Nothing has ended yet.</p>
              ) : (
                <div className="pr-watch-list__history">
                  {endedRows.map((entry) => (
                    <div className="pr-watch-list__history-row" key={`${entry.key}:${entry.endedAt}`}>
                      <span className="pr-watch-list__history-text">
                        {entry.summary}
                        {entry.detail ? <span className="waiting-for-panel__ended-detail">{` · ${entry.detail}`}</span> : null}
                      </span>
                      <span className="pr-watch-list__history-time">{formatWatchTime(entry.endedAt, now)}</span>
                    </div>
                  ))}
                </div>
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
});

const GROUP_ORDER: Array<{ id: string; label: string; kinds: ThreadPendingWakeKind[] }> = [
  { id: "held", label: "Held", kinds: ["held_message"] },
  { id: "scheduled", label: "Scheduled", kinds: ["scheduled_action", "backend_wake"] },
  { id: "prs", label: "Pull requests", kinds: ["pr_watch", "pr_auto_fix"] },
  { id: "threads", label: "Other threads", kinds: ["dependency"] },
  { id: "running", label: "Running", kinds: ["monitor", "backend_task"] },
];

const KNOWN_KINDS = new Set<ThreadPendingWakeKind>(GROUP_ORDER.flatMap((group) => group.kinds));

/**
 * The hold over the whole thread, for the notice above the list: its lock,
 * which the thread row also carries, else the paused project a wake names.
 */
function readHoldNotice(
  thread: NavigationThreadSummary,
  wakes: readonly ThreadPendingWake[],
): Exclude<ThreadPendingWakeHold, { kind: "queue_held" }> | undefined {
  if (thread.lock) return { kind: "thread_locked", ...(thread.lock.note ? { note: thread.lock.note } : {}) };
  for (const wake of wakes) {
    if (wake.held?.kind === "thread_locked" || wake.held?.kind === "project_paused") return wake.held;
  }
  return undefined;
}

function describeHoldTitle(hold: Exclude<ThreadPendingWakeHold, { kind: "queue_held" }>): string {
  if (hold.kind === "thread_locked") {
    return hold.note ? `This thread is locked: ${clipText(hold.note, 120)}` : "This thread is locked.";
  }
  return `${hold.projectLabel} is paused.`;
}

function describeHoldRelease(
  hold: Exclude<ThreadPendingWakeHold, { kind: "queue_held" }>,
  canUnlock: boolean,
  ownerLabel: string | undefined,
): string {
  if (hold.kind === "thread_locked") {
    return canUnlock
      ? "Nothing starts a turn until it is unlocked. Unlocking sends what it held, in order."
      : `Nothing starts a turn until it is unlocked${ownerLabel ? ` on ${ownerLabel}` : ""}.`;
  }
  return hold.discardsWakeups
    ? "Its PR checks stop, and monitor and Continue After results are dropped. Resume it from the project's menu in Directories."
    : "Its PR checks stop, and monitor and Continue After results are held. Resume it from the project's menu in Directories.";
}

/** One line on a row the hold keeps from starting: what holds it, and when it goes. */
function describeRowHold(wake: ThreadPendingWake, canSend: boolean): string | undefined {
  const hold = wake.held;
  if (!hold) return undefined;
  if (hold.kind === "thread_locked") {
    if (wake.kind === "held_message") return "Held while this thread is locked; unlocking sends it.";
    // Claude's own task and wakes run on; the turn each would start waits.
    if (wake.kind === "backend_task") return "It keeps running. Claude's answer waits until the thread is unlocked.";
    if (wake.kind === "backend_wake") return "If it fires while this thread is locked, Claude's turn waits until it is unlocked.";
    return "Held while this thread is locked.";
  }
  if (hold.kind === "queue_held") return `Held: ${clipText(hold.reason, 160)} Send it again from the queue above the composer.`;
  if (wake.kind === "held_message") {
    return canSend
      ? `Held while ${hold.projectLabel} is paused. Send it now, or resume the project.`
      : `Held while ${hold.projectLabel} is paused. Resuming the project sends it.`;
  }
  if (wake.kind === "pr_watch") return `Waits while ${hold.projectLabel} is paused.`;
  return hold.discardsWakeups
    ? `Dropped if it ends while ${hold.projectLabel} is paused.`
    : `Held if it ends while ${hold.projectLabel} is paused.`;
}

/** Main sends the wakes soonest first; groups keep that order. */
function groupWakes(wakes: readonly ThreadPendingWake[], thread: NavigationThreadSummary): Group[] {
  const groups: Group[] = [];
  for (const spec of GROUP_ORDER) {
    const members = wakes.filter((wake) => spec.kinds.includes(wake.kind));
    if (members.length === 0) continue;
    if (spec.id !== "prs") {
      groups.push({ id: spec.id, label: spec.label, wakes: members });
      continue;
    }
    // One group per PR, so the PR number heads its watches and Auto-fix.
    const byPr = new Map<string, ThreadPendingWake[]>();
    for (const wake of members) {
      const prKey = wake.kind === "pr_watch" ? wake.watch.prKey : wake.kind === "pr_auto_fix" ? wake.prKey : "";
      if (!byPr.has(prKey)) byPr.set(prKey, []);
      byPr.get(prKey)!.push(wake);
    }
    // A PR whose rows all wait for nothing follows the live ones.
    const prGroups = [...byPr].sort(([, left], [, right]) =>
      Number(!left.some(isThreadPendingWakeLive)) - Number(!right.some(isThreadPendingWakeLive)));
    for (const [prKey, prWakes] of prGroups) {
      const prNumber = readPrNumber(prKey, prWakes, thread);
      const ended = readPrEnded(prWakes);
      const aside = [prNumber !== undefined ? `#${prNumber}` : undefined, ended].filter(Boolean).join(" · ");
      groups.push({
        id: `prs:${prKey}`,
        label: spec.label,
        ...(aside ? { aside } : {}),
        wakes: prWakes,
      });
    }
  }
  return groups;
}

function readPrEnded(wakes: readonly ThreadPendingWake[]): "merged" | "closed" | undefined {
  for (const wake of wakes) {
    if (wake.kind === "pr_auto_fix" && wake.prEnded) return wake.prEnded;
  }
  return undefined;
}

function readPrNumber(
  prKey: string,
  wakes: readonly ThreadPendingWake[],
  thread: NavigationThreadSummary,
): number | undefined {
  for (const wake of wakes) {
    if (wake.kind === "pr_watch") return wake.watch.prNumber;
    if (wake.kind === "pr_auto_fix" && wake.prNumber !== undefined) return wake.prNumber;
  }
  return thread.prs?.find((pr) => buildPullRequestStatusKey(pr) === prKey)?.number;
}

type WakeView = { icon: ReactNode; title: ReactNode; plainTitle: string; sub: ReactNode };

function describeWake(
  wake: ThreadPendingWake,
  thread: NavigationThreadSummary,
  now: number,
  ownerLabel: string | undefined,
  canSendHeld = false,
): WakeView {
  const rowHold = describeRowHold(wake, canSendHeld);
  const transient = (
    <>
      {rowHold ? <span className="waiting-for-panel__held">{` ${rowHold}`}</span> : null}
      {wake.durable ? null : (
        <span className="waiting-for-panel__transient">
          {` Ends if ${ownerLabel ?? "PwrAgent"} quits.`}
        </span>
      )}
    </>
  );
  switch (wake.kind) {
    case "held_message": {
      const title = HELD_SOURCE_TITLES[wake.source];
      // The label names the message, so two held rows' buttons differ.
      const plainTitle = wake.displayText ? `${title}: ${clipText(wake.displayText, 60)}` : title;
      const quote = wake.displayText ? <span className="waiting-for-panel__quote">{`“${clipText(wake.displayText, 90)}”`}</span> : null;
      return {
        icon: wake.held?.kind === "thread_locked" ? <LockIcon size={12} /> : <PauseIcon size={12} />,
        title,
        plainTitle,
        sub: <>{quote}{transient}</>,
      };
    }
    case "scheduled_action": {
      const noun = wake.actionKind === "review" ? "Review" : "Message";
      const plainTitle = wake.status === "held"
        ? `${noun} held`
        : wake.wakesAt !== undefined && wake.wakesAt > now
          ? `${noun} at ${formatWatchTime(wake.wakesAt, now)}`
          : `${noun} due now`;
      const title = wake.status === "scheduled" && wake.wakesAt !== undefined && wake.wakesAt > now
        ? <>{`${noun} at `}<span className="waiting-for-panel__when">{formatWatchTime(wake.wakesAt, now)}</span></>
        : plainTitle;
      const quote = wake.displayText ? <span className="waiting-for-panel__quote">{`“${clipText(wake.displayText, 90)}” `}</span> : null;
      return {
        icon: <ClockIcon size={12} />,
        title,
        plainTitle,
        sub: <>{quote}{wake.status === "held" ? "Waits for you to release it." : `${creatorLabel(wake.createdBy, ownerLabel)}, ${formatWatchTime(wake.createdAt ?? now, now)}.`}{transient}</>,
      };
    }
    case "pr_watch": {
      const { watch } = wake;
      if (isCiWatch(watch)) {
        const attempt = readWatchRunAttempt(watch);
        const plainTitle = attempt !== undefined ? `Waiting for CI · attempt ${attempt}` : "Waiting for CI";
        return {
          icon: <EyeIcon size={12} />,
          title: plainTitle,
          plainTitle,
          sub: <>{`On ${describeCiOutcomes(watch.notifyOn)}. ${creatorLabel(wake.createdBy, ownerLabel)}, ${formatWatchTime(watch.createdAt, now)}.`}{transient}</>,
        };
      }
      return {
        icon: <MergeIcon size={12} />,
        title: "Waiting for merge or close",
        plainTitle: "Waiting for merge or close",
        sub: <>{`${creatorLabel(wake.createdBy, ownerLabel)}, ${formatWatchTime(watch.createdAt, now)}.`}{transient}</>,
      };
    }
    case "pr_auto_fix": {
      if (wake.prEnded) {
        const prNumber = readPrNumber(wake.prKey, [wake], thread);
        const pr = prNumber !== undefined ? `#${prNumber}` : "the PR";
        return {
          icon: <PullRequestIcon size={12} />,
          title: "Auto-fix idle",
          plainTitle: "Auto-fix idle",
          sub: `On, but ${pr} ${wake.prEnded}, so there is nothing to repair. It wakes this thread again only if the PR reopens.`,
        };
      }
      const plainTitle = wake.state === "paused" ? "Auto-fix paused"
        : wake.state === "handled_by_other_thread" ? `Auto-fix handled by ${wake.handledBy?.title ?? "another thread"}`
        : "Auto-fix";
      return {
        icon: <PullRequestIcon size={12} />,
        title: plainTitle,
        plainTitle,
        sub: wake.state === "paused" ? "The repair budget is empty. Resume it from the safety notice."
          : wake.state === "handled_by_other_thread" ? "That thread gets the repair turn when this PR fails CI."
          : "Starts a repair turn when a new push fails CI.",
      };
    }
    case "dependency": {
      const plainTitle = describeDependencyTitle(wake, thread);
      const ready = wake.dependency.status === "ready";
      return {
        icon: <ContinueAfterIcon size={12} />,
        title: plainTitle,
        plainTitle,
        sub: <>{ready && !wake.held
          ? "Met. Waits for this thread to be free."
          : ready
            ? "Met."
            : `Since ${formatWatchTime(wake.createdAt ?? now, now)}.${wake.dependency.conditions.length > 1 ? wake.dependency.mode === "any" ? " Waits for any of them." : " Waits for all of them." : ""}`}{transient}</>,
      };
    }
    case "monitor": {
      const plainTitle = `Monitor: ${clipText(wake.task, 80)}`;
      return {
        icon: <RadarIcon size={12} />,
        title: plainTitle,
        plainTitle,
        sub: <>{`Checks every ${formatInterval(wake.pollIntervalSeconds)}. Last check ${formatAgo(wake.lastActivityAt, now)}.`}{transient}</>,
      };
    }
    case "backend_wake": {
      const { lead, when } = describeBackendWakeTitle(wake, now);
      const prompt = describeBackendWakePrompt(wake);
      return {
        icon: wake.wake.recurring ? <HistoryIcon size={12} /> : <ClockIcon size={12} />,
        title: when ? <>{lead}<span className="waiting-for-panel__when">{when}</span></> : lead,
        plainTitle: `${lead}${when ?? ""}`,
        sub: (
          <>
            <span className="waiting-for-panel__quote">{`“${clipText(prompt, 90)}” `}</span>
            {"Claude scheduled this itself. Ask Claude to cancel it."}
            {rowHold ? <span className="waiting-for-panel__held">{` ${rowHold}`}</span> : null}
            <span className="waiting-for-panel__transient">
              {` Ends if ${ownerLabel ?? "PwrAgent"} quits or Claude restarts.`}
            </span>
          </>
        ),
      };
    }
    case "backend_task": {
      const command = wake.task.command;
      const running = wake.task.startedAt !== undefined ? ` Running ${formatElapsed(wake.task.startedAt, now)}.` : "";
      const lead = wake.task.kind === "agent" ? "Sub-agent: " : wake.task.kind === "task" ? "Task: " : "";
      return {
        icon: <TerminalIcon size={12} />,
        title: lead ? `${lead}${command}` : <span className="waiting-for-panel__mono">{command}</span>,
        plainTitle: `${lead}${command}`,
        sub: <>{`Claude continues when it ends.${running}`}{transient}</>,
      };
    }
  }
}

/** A wake-up by its time, a cron by its schedule. `when` is a time still ahead. */
function describeBackendWakeTitle(wake: BackendWake, now: number): { lead: string; when?: string } {
  const { wake: scheduled } = wake;
  if (scheduled.recurring) {
    const schedule = scheduled.humanSchedule?.trim();
    return { lead: schedule ? `Claude repeats ${lowerFirst(schedule)}` : `Claude repeats on ${scheduled.schedule || "a schedule"}` };
  }
  const noun = scheduled.origin === "loop_wakeup" ? "Claude loop" : "Claude reminder";
  if (wake.wakesAt === undefined) return { lead: scheduled.schedule ? `${noun} on ${scheduled.schedule}` : `${noun} scheduled` };
  return wake.wakesAt > now ? { lead: `${noun} at `, when: formatWatchTime(wake.wakesAt, now) } : { lead: `${noun} due now` };
}

/** The autonomous /loop sends itself a sentinel, not words. */
function describeBackendWakePrompt(wake: BackendWake): string {
  const prompt = wake.wake.prompt.trim();
  return /^<<autonomous-loop(-dynamic)?>>$/.test(prompt) ? "Continue the autonomous loop" : prompt || "No text.";
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function describeDependencyTitle(
  wake: Extract<ThreadPendingWake, { kind: "dependency" }>,
  thread: NavigationThreadSummary,
): string {
  const { conditions, deliver } = wake.dependency;
  const lead = deliver === "operator" ? "Remind you after" : "Continue after";
  if (conditions.length !== 1) {
    // "Something else" is not a thread.
    const threads = conditions.every((condition) => condition.subject === undefined);
    return wake.dependency.mode === "any"
      ? `${lead} any of ${conditions.length} ${threads ? "threads" : "prerequisites"}`
      : threads ? `${lead} ${conditions.length} threads finish` : `${lead} ${conditions.length} prerequisites`;
  }
  const condition = conditions[0]!;
  const self = condition.subject === undefined && !condition.target
    && condition.backend === thread.source && condition.threadId === thread.id;
  const name = self ? "this thread" : condition.subject?.trim() || condition.title?.trim() || "another thread";
  return `${lead} ${name} ${THREAD_DEPENDENCY_CONDITION_PHRASES[condition.when]}`;
}

function renderDetail(wake: ThreadPendingWake, props: WaitingForPanelProps, now: number): ReactNode {
  const showTab = (tab: ContextTabId, label: string): ReactNode => props.onShowTab ? (
    <button type="button" className="waiting-for-panel__link" onClick={() => props.onShowTab!(tab)}>{label}</button>
  ) : null;
  switch (wake.kind) {
    case "dependency": {
      const { dependency } = wake;
      return (
        <span className="waiting-for-panel__detail">
          {dependency.conditions.map((condition, index) => {
            // Evidence is stored in condition order; a slot naming another thread is stale.
            const slot = dependency.evidence[index];
            const evidence = slot && slot.condition.backend === condition.backend
              && slot.condition.threadId === condition.threadId && slot.condition.when === condition.when
              ? slot : undefined;
            const met = evidence?.state === "satisfied";
            const failed = evidence?.state === "failed";
            const name = condition.subject?.trim() || condition.title?.trim() || "Another thread";
            return (
              <span className={`waiting-for-panel__cond${met ? " is-met" : ""}${failed ? " is-failed" : ""}`} key={`${condition.threadId}:${condition.when}:${index}`}>
                <span className="waiting-for-panel__cond-dot" aria-hidden="true" />
                {`${name} ${THREAD_DEPENDENCY_CONDITION_PHRASES[condition.when]}`}
                {met ? ` · ${formatWatchTime(evidence!.observedAt, now)}` : failed ? ` · ${evidence!.reason}` : ""}
              </span>
            );
          })}
          {dependency.continuation ? (
            <span className="waiting-for-panel__prompt">
              {`${dependency.deliver === "operator" ? "Then you are reminded" : "Then the agent is told"}: “${dependency.continuation}”`}
            </span>
          ) : null}
          {props.onOpenContinueAfter ? (
            <button type="button" className="waiting-for-panel__link" onClick={props.onOpenContinueAfter}>Open in Continue After…</button>
          ) : null}
        </span>
      );
    }
    case "monitor":
      return (
        <span className="waiting-for-panel__detail">
          <dl className="waiting-for-panel__facts">
            <dt>Watches</dt><dd>{wake.task}</dd>
            {wake.model ? <><dt>Runs on</dt><dd>{wake.model}</dd></> : null}
            {wake.createdAt !== undefined ? <><dt>Since</dt><dd>{formatWatchTime(wake.createdAt, now)}</dd></> : null}
          </dl>
          {showTab("subagents", "Show in Sub-agents")}
        </span>
      );
    case "scheduled_action":
      return (
        <span className="waiting-for-panel__detail">
          <span className="waiting-for-panel__prompt">{wake.displayText || "No text."}</span>
          {wake.wakesAt !== undefined ? <span className="pr-watch-list__sub">{`Fires ${formatWatchTime(wake.wakesAt, now)}.`}</span> : null}
        </span>
      );
    case "backend_wake": {
      const { wake: scheduled } = wake;
      return (
        <span className="waiting-for-panel__detail">
          <span className="waiting-for-panel__prompt">{describeBackendWakePrompt(wake)}</span>
          <dl className="waiting-for-panel__facts">
            {scheduled.reason ? <><dt>Why</dt><dd>{scheduled.reason}</dd></> : null}
            {wake.wakesAt !== undefined ? <><dt>Next</dt><dd>{formatWatchTime(wake.wakesAt, now)}</dd></> : null}
            {scheduled.schedule ? <><dt>Cron</dt><dd className="waiting-for-panel__mono">{scheduled.schedule}</dd></> : null}
            {wake.createdAt !== undefined ? <><dt>Since</dt><dd>{formatWatchTime(wake.createdAt, now)}</dd></> : null}
          </dl>
        </span>
      );
    }
    case "backend_task":
      return (
        <span className="waiting-for-panel__detail">
          {wake.task.progress ? <span className="pr-watch-list__sub">{wake.task.progress}</span> : null}
          {showTab("actions", "Show in Actions")}
        </span>
      );
    case "pr_watch":
    case "pr_auto_fix":
      return (
        <span className="waiting-for-panel__detail">
          {showTab("prs", "Show in Pull requests")}
        </span>
      );
    case "held_message":
      return (
        <span className="waiting-for-panel__detail">
          <span className="waiting-for-panel__prompt">{wake.displayText || "No text."}</span>
          {wake.createdAt !== undefined ? <span className="pr-watch-list__sub">{`Held since ${formatWatchTime(wake.createdAt, now)}.`}</span> : null}
        </span>
      );
  }
}

function stopLabel(wake: ThreadPendingWake): string {
  return wake.stop === "turn_off" ? "Turn Off"
    : wake.stop === "cancel" ? "Cancel"
    : wake.stop === "discard" ? "Discard"
    : "Stop";
}

const HELD_SOURCE_TITLES: Record<HeldMessageWake["source"], string> = {
  monitor: "Monitor result",
  dependency: "Continue After result",
  operator: "Your queued message",
  automation: "Automation message",
  messaging: "Message from messaging",
  other: "Queued message",
};

/** Absent means an agent: older PR watch rows predate the field. */
function creatorLabel(createdBy: ThreadPendingWake["createdBy"], ownerLabel: string | undefined): string {
  if (createdBy === "operator") return ownerLabel ? "Operator" : "You";
  if (createdBy === "messaging") return "From messaging";
  return "Agent";
}

export function clipText(text: string, max: number): string {
  return text.length > max ? `${graphemePrefix(text, max - 1).trimEnd()}…` : text;
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

function formatAgo(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `at ${formatWatchTime(timestamp, now)}`;
}

function formatElapsed(startedAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
  if (minutes < 1) return "under a minute";
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
