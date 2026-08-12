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

function pluralize(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}
