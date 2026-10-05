import {
  worktreeImageMediaType,
  type WorktreeImageRevision,
  type WorktreeOtherChangeEntry,
  type WorktreeOtherChangeStatus,
  type WorktreeUnpublishedCommit,
  type WorktreeUnpublishedCommitFile,
} from "@pwragent/shared";

/**
 * The image half of the Edits rail: which rows are pictures, which revisions
 * each compares, and the one flat walk the lightbox steps through. Ported from
 * PwrGit's `lightbox-sequence.ts` / `pixel-diff.ts` / `image-layout.ts`, and
 * kept free of React and the DOM so the rules are testable on their own.
 */

export type ImageSideKey = "before" | "after";
export type ImageDiffItem = ImageSideKey | "diff";

export type ImageDiffEntry = {
  /** Unique across the panel: a path can change in a commit and again since. */
  key: string;
  worktreePath: string;
  /** Absolute path, as the read IPC wants it. */
  path: string;
  repoPath: string;
  before: WorktreeImageRevision;
  after: WorktreeImageRevision;
  /**
   * Which sides exist, when the source says. Undefined for a commit's files:
   * the commit listing carries numstat, not a status, so an add looks like a
   * modify until the parent's blob turns out to be missing.
   */
  sides?: ImageSideKey[];
  /** Where the change lives, for the lightbox caption. */
  context: string;
};

export type Extent = { w: number; h: number };

/** One position in the walk: which image file, and which of its items. */
export type ImageDiffStop = { entryKey: string; item: ImageDiffItem };

/** Whether a row in the rail is a picture this feature previews. A binary
 *  flag is required, because git decides that, not the extension. */
export function isPreviewableImage(file: { binary?: boolean; repoPath: string }): boolean {
  return file.binary === true && worktreeImageMediaType(file.repoPath) !== undefined;
}

export function sidesForStatus(status: WorktreeOtherChangeStatus): ImageSideKey[] {
  switch (status) {
    case "added":
    case "untracked":
      return ["after"];
    case "deleted":
      return ["before"];
    default:
      return ["before", "after"];
  }
}

export function otherChangeImageEntry(
  change: WorktreeOtherChangeEntry,
  worktreePath: string,
): ImageDiffEntry {
  return {
    key: `worktree:${change.path}`,
    worktreePath,
    path: change.path,
    repoPath: change.repoPath,
    // `getOtherChangeDiff` compares the working tree against HEAD; so does this.
    before: { kind: "head" },
    after: { kind: "worktree" },
    sides: sidesForStatus(change.status),
    context: "Uncommitted",
  };
}

export function commitFileImageEntry(
  commit: Pick<WorktreeUnpublishedCommit, "sha" | "shortSha">,
  file: WorktreeUnpublishedCommitFile,
  worktreePath: string,
): ImageDiffEntry {
  return {
    key: `commit:${commit.sha}:${file.path}`,
    worktreePath,
    path: file.path,
    repoPath: file.repoPath,
    before: { kind: "commitParent", sha: commit.sha },
    after: { kind: "commit", sha: commit.sha },
    context: commit.shortSha,
  };
}

/** What a side resolved to, as far as deciding whether it exists. */
export type SideResolution = "pending" | "present" | "missing";

/**
 * The sides one entry contributes: the status's sides when the source has
 * one, otherwise both, less any that resolve `missing`. A status can still be
 * wrong about a side — a rename's new path is not in HEAD — so the status is
 * where the walk starts, not what it ends with. Unresolved sides stay in, so
 * the walk only ever shrinks as previews arrive.
 */
export function resolvedSides(
  entry: ImageDiffEntry,
  resolution: (side: ImageSideKey) => SideResolution,
): ImageSideKey[] {
  const candidates = entry.sides ?? ["before", "after"];
  const sides = candidates.filter((side) => resolution(side) !== "missing");
  // Every side missing means the read failed in a way that looks like
  // absence; keep the last so the stop can say so rather than vanish.
  return sides.length > 0 ? sides : candidates.slice(-1);
}

export function itemsForSides(sides: readonly ImageSideKey[]): ImageDiffItem[] {
  return sides.length === 2 ? ["before", "after", "diff"] : [...sides];
}

/**
 * Every stop across every image file, in the order the rail lists them: the
 * arrows run Before → After → Diff and straight into the next file's Before
 * without the reader doing anything different at the boundary.
 */
export function buildSequence(
  entries: readonly ImageDiffEntry[],
  sidesOf: (entry: ImageDiffEntry) => ImageSideKey[],
): ImageDiffStop[] {
  return entries.flatMap((entry) =>
    itemsForSides(sidesOf(entry)).map((item) => ({ entryKey: entry.key, item })),
  );
}

/**
 * Where a stop sits in the walk. A stop that no longer exists — the Before of
 * a file that turned out to be an add — lands on that file's first remaining
 * item, so the viewer stays on the picture rather than jumping to the start.
 */
export function indexOfStop(
  sequence: readonly ImageDiffStop[],
  stop: ImageDiffStop,
): number {
  const exact = sequence.findIndex(
    (candidate) => candidate.entryKey === stop.entryKey && candidate.item === stop.item,
  );
  if (exact !== -1) {
    return exact;
  }
  const sameFile = sequence.findIndex((candidate) => candidate.entryKey === stop.entryKey);
  return sameFile === -1 ? 0 : sameFile;
}

/**
 * Stepping, clamped at both ends. Deliberately no wrap-around: an arrow that
 * does nothing at the last diff of the last file is how you learn you have
 * seen everything; one that silently starts over hides that.
 */
export function stepStop(
  sequence: readonly ImageDiffStop[],
  at: number,
  by: number,
): number {
  // Lower bound last: an empty sequence's upper bound is -1.
  return Math.max(0, Math.min(sequence.length - 1, at + by));
}

/**
 * The first stop of the next (or previous) file, clamped. Going back from the
 * middle of a file returns to that file's start first, the way a previous-
 * track button does — otherwise Shift+Left from a file's Diff skips its own
 * Before entirely.
 */
export function stepFile(
  sequence: readonly ImageDiffStop[],
  at: number,
  by: 1 | -1,
): number {
  const current = sequence[at];
  if (!current) {
    return stepStop(sequence, at, 0);
  }
  if (by === 1) {
    const next = sequence.findIndex(
      (stop, index) => index > at && stop.entryKey !== current.entryKey,
    );
    return next === -1 ? at : next;
  }
  const fileStart = sequence.findIndex((stop) => stop.entryKey === current.entryKey);
  if (fileStart < at) {
    return fileStart;
  }
  const previous = sequence[fileStart - 1];
  if (!previous) {
    return at;
  }
  return sequence.findIndex((stop) => stop.entryKey === previous.entryKey);
}

/**
 * The box every revision is drawn into: the larger of the two, so a 2x asset
 * and its 1x twin share one coordinate space. That shared space is what lets
 * zoom and pan carry across Before, After and Diff.
 */
export function referenceExtent(sides: readonly (Extent | undefined)[]): Extent | undefined {
  const measured = sides.filter((side): side is Extent => side !== undefined);
  if (measured.length === 0) {
    return undefined;
  }
  return {
    w: Math.max(...measured.map((side) => side.w)),
    h: Math.max(...measured.map((side) => side.h)),
  };
}

/** Aspect ratios this close count as the same shape — a 2x export rounds. */
const ASPECT_TOLERANCE = 0.005;

export type DiffPlan = {
  /** The canvas both revisions are rendered into before comparing. */
  size: Extent;
  /**
   * `stretch` scales each revision to fill the canvas — right when the two
   * are the same shape, so the only difference is resolution. `anchor` draws
   * each at natural size in the top-left, so the overhang of the larger one
   * compares against transparency and counts as changed: the honest answer
   * for two different shapes.
   */
  fit: "stretch" | "anchor";
  /** Set when the revisions differ in size, for the caption. */
  mismatch?: { before: Extent; after: Extent };
  /** Whether `stretch` is a sane reading of this pair, for the toggle. */
  canStretch: boolean;
};

function sameShape(a: Extent, b: Extent): boolean {
  if (a.h === 0 || b.h === 0) {
    return false;
  }
  return Math.abs(a.w / a.h / (b.w / b.h) - 1) <= ASPECT_TOLERANCE;
}

/**
 * pixelmatch compares two buffers of the SAME dimensions and nothing else. A
 * repository is not a test suite — re-exporting a sprite at another size is an
 * ordinary commit — so this decides what the comparison means instead of
 * refusing it. `stretch` is the caller's "Scale to match" override; undefined
 * follows the shapes.
 */
export function planDiff(before: Extent, after: Extent, stretch?: boolean): DiffPlan {
  if (before.w === after.w && before.h === after.h) {
    return { size: before, fit: "anchor", canStretch: false };
  }
  const canStretch = sameShape(before, after);
  return {
    // Always the larger box. Downscaling the bigger revision to meet the
    // smaller would resample away the very differences this exists to show.
    size: { w: Math.max(before.w, after.w), h: Math.max(before.h, after.h) },
    fit: (stretch ?? canStretch) ? "stretch" : "anchor",
    mismatch: { before, after },
    canStretch,
  };
}

export function formatExtent(extent: Extent): string {
  return `${extent.w}×${extent.h}`;
}
