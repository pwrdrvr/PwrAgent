import { useState } from "react";
import type {
  PrSummary,
  ThreadPrWatchHistoryEntry,
  ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import { EyeIcon, MergeIcon, PullRequestIcon } from "../../icons";
import { describeCiOutcomes } from "../pr-status/PrStatusCard";
import { isCiWatch } from "./useThreadPrWatchIndicators";

/** History rows one card shows; the rest stay on the owner. */
const HISTORY_ROWS = 5;

type PullRequestWatchListProps = {
  pr: PrSummary;
  /** This PR's active watches, oldest first. */
  watches: readonly ThreadPullRequestWatchSummary[];
  autoFix: boolean;
  /**
   * Set for a peer's thread: its watches run there, and no signed request can
   * stop one from here, so the list is read-only.
   */
  ownerLabel?: string;
  onStop?: (watch: ThreadPullRequestWatchSummary) => Promise<void>;
  onTurnOffAutoFix?: () => void;
  onAskAgentToWatchCi?: () => void;
  /** Ended watches for this PR, newest first; absent until first loaded. */
  history?: readonly ThreadPrWatchHistoryEntry[];
  historyOpen?: boolean;
  onToggleHistory?: () => void;
  /** Injected by tests so times are deterministic. */
  now?: number;
};

/**
 * A Pull requests card's "Wakes this thread" list: each active watch with a
 * way to stop it, Auto-fix with a way to turn it off, and, when nothing waits
 * for CI, a hint that teaches the operator to ask the agent for a watch.
 */
export function PullRequestWatchList(props: PullRequestWatchListProps) {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const now = props.now ?? Date.now();
  const readOnly = props.ownerLabel !== undefined;
  const ciWatches = props.watches.filter(isCiWatch);
  const terminalWatches = props.watches.filter((watch) => !isCiWatch(watch));
  const stop = (watch: ThreadPullRequestWatchSummary): void => {
    if (!props.onStop) return;
    setStopping((current) => new Set(current).add(watch.watchId));
    void props.onStop(watch).finally(() => {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(watch.watchId);
        return next;
      });
    });
  };
  const historyRows = props.history?.slice(0, HISTORY_ROWS) ?? [];

  return (
    <div className="pr-watch-list">
      <p className="pr-watch-list__eyebrow">Wakes this thread</p>
      {ciWatches.map((watch) => (
        <div className="pr-watch-list__row" key={watch.watchId}>
          <span className="pr-watch-list__icon" aria-hidden="true">
            <EyeIcon size={12} />
          </span>
          <span className="pr-watch-list__text">
            <span className="pr-watch-list__title">
              {watch.baseline?.runAttempt !== undefined
                ? `Waiting for CI · attempt ${watch.baseline.runAttempt}`
                : "Waiting for CI"}
            </span>
            <span className="pr-watch-list__sub">{describeCiWatch(watch, now)}</span>
          </span>
          {!readOnly && props.onStop ? (
            <button
              type="button"
              className="pr-watch-list__action"
              aria-label={`Stop waiting for CI on #${props.pr.number}`}
              disabled={stopping.has(watch.watchId)}
              onClick={() => stop(watch)}
            >
              Stop
            </button>
          ) : null}
        </div>
      ))}
      {terminalWatches.map((watch) => (
        <div className="pr-watch-list__row" key={watch.watchId}>
          <span className="pr-watch-list__icon" aria-hidden="true">
            <MergeIcon size={12} />
          </span>
          <span className="pr-watch-list__text">
            <span className="pr-watch-list__title">Waiting for merge or close</span>
            <span className="pr-watch-list__sub">{describeCreator(watch, now)}</span>
          </span>
          {!readOnly && props.onStop ? (
            <button
              type="button"
              className="pr-watch-list__action"
              aria-label={`Stop watching #${props.pr.number} for merge`}
              disabled={stopping.has(watch.watchId)}
              onClick={() => stop(watch)}
            >
              Stop
            </button>
          ) : null}
        </div>
      ))}
      {props.autoFix ? (
        <div className="pr-watch-list__row">
          <span className="pr-watch-list__icon" aria-hidden="true">
            <PullRequestIcon size={12} />
          </span>
          <span className="pr-watch-list__text">
            <span className="pr-watch-list__title">Auto-fix</span>
            <span className="pr-watch-list__sub">
              Starts a repair turn when a new push fails CI.
            </span>
          </span>
          {!readOnly && props.onTurnOffAutoFix ? (
            <button
              type="button"
              className="pr-watch-list__action"
              aria-label={`Turn off Auto-fix for #${props.pr.number}`}
              onClick={props.onTurnOffAutoFix}
            >
              Turn Off
            </button>
          ) : null}
        </div>
      ) : null}
      {ciWatches.length === 0 && !readOnly ? (
        <div className="pr-watch-list__hint">
          <span className="pr-watch-list__hint-text">Not waiting for CI.</span>
          {props.onAskAgentToWatchCi ? (
            <button
              type="button"
              className="pr-watch-list__hint-action"
              onClick={props.onAskAgentToWatchCi}
            >
              Ask Agent to Watch CI
            </button>
          ) : null}
        </div>
      ) : null}
      {readOnly ? (
        <p className="pr-watch-list__owner">
          {`Watches run on ${props.ownerLabel}. Stop them there.`}
        </p>
      ) : null}
      {props.onToggleHistory ? (
        <>
          <button
            type="button"
            className="pr-watch-list__history-toggle"
            aria-expanded={props.historyOpen === true}
            onClick={props.onToggleHistory}
          >
            {props.history ? `History (${props.history.length})` : "History"}
          </button>
          {props.historyOpen ? (
            props.history === undefined ? (
              <p className="pr-watch-list__sub">Loading…</p>
            ) : historyRows.length === 0 ? (
              <p className="pr-watch-list__sub">No watch has ended yet.</p>
            ) : (
              <div className="pr-watch-list__history">
                {historyRows.map((entry) => (
                  <div className="pr-watch-list__history-row" key={entry.watchId}>
                    <span className="pr-watch-list__history-text">
                      {describeEnded(entry, props.watches, props.history ?? [])}
                    </span>
                    <span className="pr-watch-list__history-time">
                      {formatWatchTime(entry.updatedAt, now)}
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function describeCiWatch(watch: ThreadPullRequestWatchSummary, now: number): string {
  const parts = [
    `On ${describeCiOutcomes(watch.notifyOn)}.`,
    `${describeCreator(watch, now)}.`,
  ];
  const baseline = watch.baseline;
  if (baseline) {
    const outcome = baseline.outcome === "failure" ? "failure" : "pass";
    parts.push(
      baseline.runAttempt !== undefined && baseline.runAttempt > 1
        ? `Attempt ${baseline.runAttempt - 1}'s ${outcome} will not wake it.`
        : `The earlier ${outcome} will not wake it.`,
    );
  }
  if (watch.followedFrom) {
    parts.push(`Followed a push from ${watch.followedFrom.slice(0, 7)}.`);
  }
  return parts.join(" ");
}

function describeCreator(watch: ThreadPullRequestWatchSummary, now: number): string {
  // Absent means an agent: only `watch_thread_pull_request` creates watches.
  return `Agent, ${formatWatchTime(watch.createdAt, now)}`;
}

const WOKE_ON: Record<string, string> = {
  success: "CI passed",
  failure: "CI failed",
  merged: "merged",
  closed: "closed",
};

function describeEnded(
  entry: ThreadPrWatchHistoryEntry,
  active: readonly ThreadPullRequestWatchSummary[],
  history: readonly ThreadPrWatchHistoryEntry[],
): string {
  switch (entry.endedReason) {
    case "woke":
      return entry.wokeOn ? `Woke the thread · ${WOKE_ON[entry.wokeOn] ?? entry.wokeOn}` : "Woke the thread";
    case "moved": {
      const next = [...active, ...history].find((watch) => watch.watchId === entry.movedTo);
      return next ? `Moved to new head · ${next.headSha.slice(0, 7)}` : "Moved to new head";
    }
    case "head_changed":
      return "Ended by a new push";
    case "cancelled_by_operator":
      return "Stopped by you";
    case "detached":
      return "Ended when the PR was detached";
    case "covered_by_auto_fix":
      return "Handed to Auto-fix";
    case "failed":
      return "Could not wake the thread";
    case undefined:
      break;
  }
  switch (entry.status) {
    case "dispatched":
      return "Woke the thread";
    case "superseded":
      return "Ended by a new push";
    case "cancelled":
      return "Stopped";
    case "failed":
      return "Could not wake the thread";
  }
}

/** A clock time today; with the date before today. */
export function formatWatchTime(timestamp: number, now: number): string {
  const sameDay = new Date(timestamp).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(timestamp);
}
