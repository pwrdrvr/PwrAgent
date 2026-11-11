import {
  describeMergeQueueRemoval,
  mergeQueueNoun,
  type PrSummary,
} from "@pwragent/shared";
import { BranchIcon } from "../../icons";
import { DiffStat } from "../../lib/DiffStat";
import { formatRunningDurationMs } from "../../lib/format-duration";
import type { PrChipWatch } from "../pr-watches/useThreadPrWatchIndicators";
import { readPrBranchDrift, type PrBranchDrift } from "./pr-branch-drift";
import { splitPrBranch } from "./pr-branch-split";
import {
  prPhaseLabel,
  prStatusLabel,
  resolveChipState,
  resolveLifecycleState,
} from "./pr-chip-state";

/**
 * The PR chip's hover card.
 *
 * Structured sibling of the composer's `.context-usage-card`: same 272px
 * column, same eyebrow / headline / meter / section-row rhythm, same tokens.
 * Two structured hover cards in one app should read as one family.
 *
 * EVERY section below is conditional, and that is load-bearing rather than
 * defensive. Diff stats and timestamps are optional on `PrSummary` because a
 * federated peer may run a build that predates them, and because a PR that
 * reached a terminal lifecycle before this shipped will never gain them —
 * `collectPrPollTargets` drops terminal PRs from the poll rotation, so its
 * cached row is frozen. The card therefore has to look finished with any
 * subset present: no dashes, no "unknown", no empty section headers. Missing
 * counts are never rendered as zero; "not known" and "changes nothing" are
 * different claims and we only ever have evidence for the first.
 */
export function PrStatusCard(props: {
  pr: PrSummary;
  /**
   * Mirrors `PrChip`'s flag so the card's dot resolves exactly like the chip's.
   * Next to status pills the chip defers merge-conflict to them and keeps the
   * check-state color; the card follows, because a card that disagreed with the
   * chip it is anchored to would just look broken.
   */
  withStatusPills?: boolean;
  /**
   * The thread branch's base drift, when this is the PR on that branch. Only
   * the sidebar row knows the thread, so other surfaces leave it out and the
   * card draws no Local branch section.
   */
  branchDrift?: PrBranchDrift;
  /** What wakes the chip's thread for this PR: CI, merge or close, Auto-fix. */
  watch?: PrChipWatch;
  /** The chip's context menu can stop its watches, so the card says how. */
  watchStopHint?: boolean;
  /** Injected by tests so age rows are deterministic. */
  now?: number;
}) {
  const { pr } = props;
  const now = props.now ?? Date.now();
  const title = pr.title?.trim();
  const phase = prPhaseLabel(pr);
  const dotState = resolveDotState(pr, props.withStatusPills === true);
  const changes = readPrChanges(pr);
  const timeline = readPrTimeline(pr, now);
  const branch = splitPrBranch(pr.headRefName);
  const drift = readBranchDriftRows(props.branchDrift);
  const wakes = readWatchRows(props.watch);
  const queue = readMergeQueueSection(pr, now);
  const stoppable = Boolean(props.watch?.ci || props.watch?.terminal);

  return (
    <>
      <div className="pr-status-card__header">
        <span className="pr-status-card__eyebrow">Pull request</span>
        {phase ? <span className="pr-status-card__phase">{phase}</span> : null}
      </div>
      {title ? <div className="pr-status-card__title">{title}</div> : null}
      <div className="pr-status-card__identity">
        {`${pr.org}/${pr.repo}#${pr.number}`}
      </div>
      {branch ? (
        <div className="pr-status-card__branch">
          <BranchIcon
            aria-hidden="true"
            className="pr-status-card__branch-icon"
            size={11}
          />
          {/* The split is a truncation mechanism, not two facts — but flex
              items are blockified, so assistive tech reports the halves as two
              separate nodes and reads them as two branch names ("…backport-pr-stat",
              "us-hover-1.0"). Hide the visual split and carry the name once,
              whole, for anything that listens rather than looks. */}
          <span aria-hidden="true" className="pr-status-card__branch-name">
            <span className="pr-status-card__branch-head">{branch.head}</span>
            <span className="pr-status-card__branch-tail">{branch.tail}</span>
          </span>
          <span className="pr-status-card__branch-full">{branch.full}</span>
        </div>
      ) : null}
      <div className="pr-status-card__status">
        <span
          aria-hidden="true"
          className={`pr-status-card__dot pr-status-card__dot--${dotState}`}
        />
        <span>{prStatusLabel(pr)}</span>
      </div>
      {queue ? (
        <div className="pr-status-card__section">
          <span className="pr-status-card__section-title">{queue.title}</span>
          {queue.rows.map((row) => (
            <div className="pr-status-card__row" key={row.label}>
              <span className="pr-status-card__row-label">{row.label}</span>
              <span className="pr-status-card__row-value">{row.value}</span>
            </div>
          ))}
          {queue.detail ? (
            <div className="pr-status-card__caption">{queue.detail}</div>
          ) : null}
        </div>
      ) : null}
      {changes ? (
        <div className="pr-status-card__section">
          <span className="pr-status-card__section-title">Changes</span>
          <div className="pr-status-card__diff">
            {changes.diff ? (
              <DiffStat
                additions={changes.diff.additions}
                removals={changes.diff.deletions}
                className="pr-status-card__diff-stat"
              />
            ) : <span />}
            {changes.files ? (
              <span className="pr-status-card__files">{changes.files}</span>
            ) : null}
          </div>
          {changes.meter ? (
            <div aria-hidden="true" className="pr-status-card__diff-meter">
              <span
                className="pr-status-card__diff-fill--additions"
                style={{ width: `${changes.meter.additionsPercent}%` }}
              />
              <span
                className="pr-status-card__diff-fill--deletions"
                style={{ width: `${100 - changes.meter.additionsPercent}%` }}
              />
            </div>
          ) : null}
          {changes.commits ? (
            <div className="pr-status-card__caption">{changes.commits}</div>
          ) : null}
        </div>
      ) : null}
      {wakes.length > 0 ? (
        <div className="pr-status-card__section">
          <span className="pr-status-card__section-title">Wakes this thread</span>
          {wakes.map((row) => (
            <div className="pr-status-card__wake" key={row.label}>
              <div className="pr-status-card__row">
                <span className="pr-status-card__row-label">{row.label}</span>
                <span
                  className={`pr-status-card__row-value${
                    row.muted ? " pr-status-card__row-value--muted" : ""
                  }`}
                >
                  {row.value}
                </span>
              </div>
              {row.detail ? (
                <span className="pr-status-card__row-detail">
                  {row.detail}
                </span>
              ) : null}
            </div>
          ))}
          {props.watchStopHint && stoppable ? (
            <div className="pr-status-card__caption">
              Right-click the chip to stop a watch.
            </div>
          ) : null}
        </div>
      ) : null}
      {drift.length > 0 ? (
        <div className="pr-status-card__section">
          <span className="pr-status-card__section-title">Local branch</span>
          {drift.map((row) => (
            <div className="pr-status-card__row" key={row.label}>
              <span className="pr-status-card__row-label">{row.label}</span>
              <span className="pr-status-card__row-value">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {timeline.length > 0 ? (
        <div className="pr-status-card__section">
          <span className="pr-status-card__section-title">Timeline</span>
          {timeline.map((row) => (
            <div className="pr-status-card__row" key={row.label}>
              <span className="pr-status-card__row-label">{row.label}</span>
              <span className="pr-status-card__row-value">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function resolveDotState(pr: PrSummary, withStatusPills: boolean): string {
  const chipState = resolveChipState(pr);
  const isOpen = resolveLifecycleState(pr) === "open";
  if (isOpen && !withStatusPills && pr.mergeState === "conflicting") {
    return "conflicting";
  }
  return chipState;
}

type PrChanges = {
  /**
   * Additions and deletions travel as a PAIR. They come from one fetch, so a
   * provider that answers with one and not the other is malformed rather than
   * partially informative — and `DiffStat` renders `+A -R` as a unit anyway.
   */
  diff?: { additions: number; deletions: number };
  files?: string;
  commits?: string;
  meter?: { additionsPercent: number };
};

function readPrChanges(pr: PrSummary): PrChanges | undefined {
  const additions = readCount(pr.additions);
  const deletions = readCount(pr.deletions);
  const changedFiles = readCount(pr.changedFiles);
  const commitCount = readCount(pr.commitCount);
  const hasDiff = additions !== undefined && deletions !== undefined;
  if (!hasDiff && changedFiles === undefined && commitCount === undefined) {
    return undefined;
  }

  const changes: PrChanges = {};
  if (changedFiles !== undefined) {
    changes.files = pluralize(changedFiles, "file");
  }
  if (commitCount !== undefined) {
    changes.commits = pluralize(commitCount, "commit");
  }
  if (!hasDiff) {
    return changes;
  }

  changes.diff = { additions, deletions };

  // The meter is the point of the section — it says "mostly deletions" before
  // anyone reads a digit — but only when something actually changed.
  const total = additions + deletions;
  if (total > 0) {
    // Floor each visible segment at 2% so a +2/-900 PR still shows green.
    const raw = (additions / total) * 100;
    const additionsPercent =
      additions > 0 && raw < 2
        ? 2
        : deletions > 0 && raw > 98
          ? 98
          : raw;
    changes.meter = { additionsPercent };
  }

  return changes;
}

type PrTimelineRow = { label: string; value: string };

/**
 * `detail` is prose, such as a thread title, that goes on its own line under
 * the row. A row's value never wraps, so prose there ran out of the card.
 */
type PrWatchRow = PrTimelineRow & { muted?: boolean; detail?: string };

/**
 * One row per thing that wakes the thread. The attempt is the useful number
 * after a re-run: it says which run's result the watch is waiting for.
 */
function readWatchRows(watch: PrChipWatch | undefined): PrWatchRow[] {
  if (!watch) {
    return [];
  }
  const rows: PrWatchRow[] = [];
  if (watch.ci) {
    rows.push({
      label: "Waiting for CI",
      value: watch.ci.runAttempt !== undefined
        ? `attempt ${watch.ci.runAttempt}`
        : describeCiOutcomes(watch.ci.notifyOn),
    });
  }
  if (watch.terminal) {
    rows.push({ label: "Merge or close", value: "watching" });
  }
  if (watch.autoFix) {
    rows.push({ label: "Auto-fix", value: "on", muted: true });
  } else if (watch.autoFixBlocked?.reason === "paused") {
    rows.push({ label: "Auto-fix", value: "paused", muted: true });
  } else if (watch.autoFixBlocked) {
    const threadTitle = watch.autoFixBlocked.threadTitle?.trim();
    rows.push({
      label: "Auto-fix",
      value: "handled elsewhere",
      muted: true,
      ...(threadTitle ? { detail: `By ${threadTitle}` } : {}),
    });
  }
  return rows;
}

export function describeCiOutcomes(notifyOn: readonly string[]): string {
  const success = notifyOn.includes("success");
  const failure = notifyOn.includes("failure");
  return success && failure ? "pass or fail" : success ? "pass" : "fail";
}

/**
 * The branch chip's "Behind base" and "Ahead of base" counts, named after the
 * base. Compact and Minimal density hide that chip, so this is where those
 * readers find them. A zero is shown: it is a known count, and "up to date
 * with main" is the answer the operator came for.
 */
function readBranchDriftRows(drift: PrBranchDrift | undefined): PrTimelineRow[] {
  const counts = readPrBranchDrift(drift);
  if (!counts) {
    return [];
  }
  const rows: PrTimelineRow[] = [];
  if (counts.behind !== undefined) {
    rows.push({
      label: `Behind ${counts.baseBranch}`,
      value: pluralize(counts.behind, "commit"),
    });
  }
  if (counts.ahead !== undefined) {
    rows.push({
      label: `Ahead of ${counts.baseBranch}`,
      value: pluralize(counts.ahead, "commit"),
    });
  }
  return rows;
}

/**
 * Age rows. `createdAt` is immutable, so these stay exact against the wall
 * clock without any polling — a PR nobody has refreshed in a week still reports
 * its true age.
 *
 * Every row is "<event> <duration> ago". One grammar for the whole section
 * means "Opened" says the same thing whether or not the PR has landed, instead
 * of switching to a lifespan reading the moment it merges. The lifespan is
 * still there for anyone who wants it — it is the difference between the rows.
 */
const MERGE_QUEUE_STATE_LABELS = {
  not_queued: "Not queued",
  queued: "Waiting",
  group_checks_running: "Checks running",
  merging: "Merging",
  unmergeable: "Leaving",
  removed: "Removed",
  merged_by_queue: "Merged",
} as const;

/**
 * The Merge queue section: drawn while the base branch has a queue and the
 * PR is open. A merged PR's status line already says the queue landed it.
 */
function readMergeQueueSection(
  pr: PrSummary,
  now: number,
): { title: string; rows: PrTimelineRow[]; detail?: string } | undefined {
  const queue = pr.mergeQueue;
  if (!queue || resolveLifecycleState(pr) !== "open") return undefined;
  const noun = mergeQueueNoun(queue.kind);
  const title = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}${pr.baseRefName ? ` · ${pr.baseRefName}` : ""}`;
  const rows: PrTimelineRow[] = [];
  if (queue.position && (queue.state === "queued" || queue.state === "group_checks_running")) {
    rows.push({ label: "Position", value: `#${queue.position}` });
  }
  rows.push({ label: "State", value: MERGE_QUEUE_STATE_LABELS[queue.state] });
  const enqueuedAt = readTimestamp(queue.enqueuedAt);
  if (enqueuedAt !== undefined && queue.state !== "removed" && queue.state !== "not_queued") {
    rows.push({ label: "Joined", value: `${formatSpan(now - enqueuedAt)} ago` });
  }
  const removedAt = readTimestamp(queue.removedAt);
  if (queue.state === "removed" && removedAt !== undefined) {
    rows.push({ label: "Removed", value: `${formatSpan(now - removedAt)} ago` });
  }
  const detail = queue.state === "removed"
    ? describeMergeQueueRemoval(queue)
    : queue.state === "not_queued"
      ? `Merging adds it to the ${noun}.`
      : undefined;
  return { title, rows, ...(detail ? { detail } : {}) };
}

function readPrTimeline(pr: PrSummary, now: number): PrTimelineRow[] {
  const createdAt = readTimestamp(pr.createdAt);
  const lifecycleState = resolveLifecycleState(pr);
  const terminalAt =
    lifecycleState === "merged"
      ? readTimestamp(pr.mergedAt)
      : lifecycleState === "closed"
        ? readTimestamp(pr.closedAt)
        : undefined;
  const terminalLabel = lifecycleState === "merged" ? "Merged" : "Closed";

  const rows: PrTimelineRow[] = [];
  if (createdAt !== undefined) {
    rows.push({ label: "Opened", value: `${formatSpan(now - createdAt)} ago` });
  }
  if (terminalAt !== undefined) {
    rows.push({ label: terminalLabel, value: `${formatSpan(now - terminalAt)} ago` });
  }
  return rows;
}

/**
 * A peer's numbers are not ours to trust: clamp anything non-finite, negative,
 * or fractional out of the render path rather than letting it reach the DOM.
 */
function readCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}

function readTimestamp(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/**
 * Clock skew between a peer and this machine can make "now" precede a
 * timestamp; floor at zero so a card never reports a negative age.
 */
function formatSpan(ms: number): string {
  return formatRunningDurationMs(Math.max(0, ms));
}

function pluralize(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}
