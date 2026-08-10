import type { PrSummary } from "@pwragent/shared";
import { DiffStat } from "../../lib/DiffStat";
import { formatRunningDurationMs } from "../../lib/format-duration";
import {
  prPhaseLabel,
  prStatusLabel,
  resolveChipState,
  resolveLifecycleState,
} from "./pr-chip-state";

export function PrStatusCard(props: {
  pr: PrSummary;
  withStatusPills?: boolean;
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
  const total = additions + deletions;
  if (total > 0) {
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

function readPrTimeline(
  pr: PrSummary,
  now: number,
): { label: string; value: string }[] {
  const createdAt = readTimestamp(pr.createdAt);
  const lifecycleState = resolveLifecycleState(pr);
  const terminalAt =
    lifecycleState === "merged"
      ? readTimestamp(pr.mergedAt)
      : lifecycleState === "closed"
        ? readTimestamp(pr.closedAt)
        : undefined;
  const terminalLabel = lifecycleState === "merged" ? "Merged" : "Closed";

  const rows: { label: string; value: string }[] = [];
  if (createdAt !== undefined) {
    rows.push({ label: "Opened", value: `${formatSpan(now - createdAt)} ago` });
  }
  if (terminalAt !== undefined) {
    rows.push({ label: terminalLabel, value: `${formatSpan(now - terminalAt)} ago` });
  }
  return rows;
}

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

function formatSpan(ms: number): string {
  return formatRunningDurationMs(Math.max(0, ms));
}

function pluralize(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}
