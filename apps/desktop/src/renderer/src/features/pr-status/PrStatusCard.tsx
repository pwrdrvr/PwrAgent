import type { PrSummary } from "@pwragent/shared";
import { formatRunningDurationMs } from "../../lib/format-duration";
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
      <div className="pr-status-card__status">
        <span
          aria-hidden="true"
          className={`pr-status-card__dot pr-status-card__dot--${dotState}`}
        />
        <span>{prStatusLabel(pr)}</span>
      </div>
      {changes ? (
        <div className="pr-status-card__section">
          <span className="pr-status-card__section-title">Changes</span>
          <div className="pr-status-card__diff">
            <span>
              {changes.additions !== undefined ? (
                <span className="pr-status-card__additions">
                  {`+${formatCount(changes.additions)}`}
                </span>
              ) : null}
              {changes.deletions !== undefined ? (
                <span className="pr-status-card__deletions">
                  {`−${formatCount(changes.deletions)}`}
                </span>
              ) : null}
            </span>
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

/**
 * Compact spoken form of the card's data, appended to the chip's accessible
 * name. `useViewportTooltip` renders into a portal that nothing points at with
 * `aria-describedby`, so without this the card would be sighted-only.
 */
export function prStatsAccessibleSummary(
  pr: PrSummary,
  now: number = Date.now(),
): string {
  const parts: string[] = [];
  const changes = readPrChanges(pr);
  if (changes?.additions !== undefined) {
    parts.push(`${formatCount(changes.additions)} added`);
  }
  if (changes?.deletions !== undefined) {
    parts.push(`${formatCount(changes.deletions)} removed`);
  }
  if (changes?.files) {
    parts.push(changes.files);
  }
  if (changes?.commits) {
    parts.push(changes.commits);
  }
  for (const row of readPrTimeline(pr, now)) {
    parts.push(`${row.label.toLowerCase()} ${row.value}`);
  }
  return parts.join(", ");
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
  additions?: number;
  deletions?: number;
  files?: string;
  commits?: string;
  meter?: { additionsPercent: number };
};

function readPrChanges(pr: PrSummary): PrChanges | undefined {
  const additions = readCount(pr.additions);
  const deletions = readCount(pr.deletions);
  const changedFiles = readCount(pr.changedFiles);
  const commitCount = readCount(pr.commitCount);
  if (
    additions === undefined
    && deletions === undefined
    && changedFiles === undefined
    && commitCount === undefined
  ) {
    return undefined;
  }

  const changes: PrChanges = {};
  if (additions !== undefined) {
    changes.additions = additions;
  }
  if (deletions !== undefined) {
    changes.deletions = deletions;
  }
  if (changedFiles !== undefined) {
    changes.files = pluralize(changedFiles, "file");
  }
  if (commitCount !== undefined) {
    changes.commits = pluralize(commitCount, "commit");
  }

  // The meter is the point of the section — it says "mostly deletions" before
  // anyone reads a digit — but it can only be honest when both halves are known
  // and something actually changed.
  const total = (additions ?? 0) + (deletions ?? 0);
  if (additions !== undefined && deletions !== undefined && total > 0) {
    // Floor each visible segment at 2% so a +2/−900 PR still shows green.
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
 * Age rows. `createdAt` is immutable, so these stay exact against the wall
 * clock without any polling — a PR nobody has refreshed in a week still reports
 * its true age.
 *
 * Every row is "<event> <duration> ago". One grammar for the whole section
 * means "Opened" says the same thing whether or not the PR has landed, instead
 * of switching to a lifespan reading the moment it merges. The lifespan is
 * still there for anyone who wants it — it is the difference between the rows.
 */
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

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function pluralize(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
}
