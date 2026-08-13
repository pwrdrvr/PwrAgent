import type { PrSummary } from "@pwragent/shared";
import { BranchIcon } from "../../icons";
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
  const branch = readPrBranch(pr);

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

/**
 * How many trailing characters the branch row keeps when the name is too long
 * for one line. Twelve is enough to carry a trailing `-1.0` / short-sha style
 * discriminator plus the word before it, and — at the card's 11px mono — short
 * enough that the fixed tail can never outgrow the 244px content column.
 */
const BRANCH_TAIL_CHARS = 12;

/** `full` is the name as one string; `head`/`tail` are the visual split only. */
type PrBranch = { full: string; head: string; tail: string };

/**
 * Split the head branch for the CSS middle-truncation trick: only the `head`
 * span flexes, so the browser drops its ellipsis where the two halves meet
 * instead of at one end.
 *
 * Middle rather than either end is the whole point. Branch names on a thread
 * share BOTH a prefix (`claude/`, `agent/`) and, often, a suffix convention —
 * so start- or end-truncation can render two different branches identically,
 * which is exactly the confusion this row exists to remove.
 */
function readPrBranch(pr: PrSummary): PrBranch | undefined {
  const branch = pr.headRefName?.trim();
  if (!branch) {
    return undefined;
  }
  const clusters = splitGraphemes(branch);
  // The tail never truncates, so never hand it more than half the name — on a
  // short branch a fixed 12 would swallow the whole string.
  const tailLength = Math.min(BRANCH_TAIL_CHARS, Math.floor(clusters.length / 2));
  if (tailLength <= 0) {
    return { full: branch, head: branch, tail: "" };
  }
  return {
    full: branch,
    head: clusters.slice(0, clusters.length - tailLength).join(""),
    tail: clusters.slice(clusters.length - tailLength).join(""),
  };
}

/**
 * Split into grapheme clusters — what a reader calls a character — rather than
 * code points.
 *
 * Code points are not a safe cut: macOS normalizes filenames to NFD and a loose
 * git ref IS a file, so `chore/déjà-vu-dedupe` really does reach us with `a`
 * followed by a separate U+0300. Cutting between them drops the accent from the
 * head (`déja`) and starts the tail with a bare combining mark, which renders as
 * a dotted circle or lands on the ellipsis. ZWJ emoji tear the same way.
 *
 * Clusters also bound the tail's WIDTH, which the fixed `flex: 0 0 auto` tail
 * depends on: an arbitrarily long ZWJ sequence is still one glyph, so 12
 * clusters can never exceed roughly 12em.
 */
function splitGraphemes(value: string): string[] {
  if (typeof Intl.Segmenter !== "function") {
    return [...value];
  }
  // Fixed locale: cluster boundaries are effectively locale-invariant, and
  // pinning it keeps the split identical on every operator's machine.
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  return [...segmenter.segment(value)].map((segment) => segment.segment);
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
