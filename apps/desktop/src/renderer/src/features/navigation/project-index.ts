/**
 * The sidebar's project index: a name-only column beside the thread list
 * that shows where every project is and jumps to one. Pure rules here; the
 * component is `ProjectIndex.tsx`, the wiring is in `Sidebar.tsx`.
 *
 * A port of PwrGit's repo index (pwrdrvr/PwrGit#494,
 * `features/sidebar/repo-index.ts`), so the two sidebars read alike. Design:
 * the PwrAgent Claude Design project, "Sidebar Project Index UX Review".
 *
 * The column's fit is CSS, not measurement: `.project-index` takes the width
 * of its longest name, is capped at the sidebar's width past the list's
 * 280px floor, and a container query hides it when that cap falls below its
 * 7-character minimum. See `.sidebar__lanes` in app.css.
 *
 * Names drag to reorder the pinned projects, as the Directories list's
 * folders do, through the same rules (`directory-pin-drop.ts`). Design: the
 * PwrAgent Claude Design project, "Project Index Reorder UX Review".
 */

/** One project section's box, in the same coordinates as the viewport edges. */
export type ProjectBlockBox = { key: string; top: number; bottom: number };

export type ProjectSpy = { current: string | null; inView: string[] };

export const NO_PROJECT_SPY: ProjectSpy = { current: null, inView: [] };

/**
 * A project's running turns, split into this machine's and its peers'.
 * `counts.active` already includes the peer turns, so the local count is the
 * difference. A federation window fronts one peer, whose turns are its own,
 * so it has no remote split. The project's header and its name in the index
 * both read this, so the two never disagree.
 */
export function splitProjectTurnCounts(
  counts: { active: number; activeRemote?: number } | undefined,
  federationViewer: boolean,
): { local: number; remote: number } {
  const total = counts?.active ?? 0;
  const remote = federationViewer ? 0 : Math.min(total, counts?.activeRemote ?? 0);
  return { local: total - remote, remote };
}

/**
 * Which turn marks a project's name wears: the accent scanner for a turn on
 * this machine, the grey scanner for a peer's, as in the project's header and
 * the Attention tab.
 */
export function projectTurnMarks(
  counts: { active: number; activeRemote?: number } | undefined,
  federationViewer: boolean,
): { active: boolean; activeRemote: boolean } {
  const { local, remote } = splitProjectTurnCounts(counts, federationViewer);
  return { active: local > 0, activeRemote: remote > 0 };
}

/** A dragged width is announced and saved, so it moves in whole pixels. */
export const PROJECT_INDEX_KEYBOARD_STEP = 16;

/**
 * Which project the list is in, and which are on screen.
 *
 * Current is the first section whose bottom is below the line the headers
 * stick to, which is the section whose sticky header is stuck there. It is
 * never "the most visible" section, which flips back and forth inside a tall
 * project. `stickyTop` is the list's top edge plus the selected thread's dock
 * reserve: a section ending under the dock has lost its header, and shows
 * nothing the operator can read.
 */
export function spyProjects(
  count: number,
  readBlock: (index: number) => ProjectBlockBox,
  viewportBottom: number,
  stickyTop = 0,
): ProjectSpy {
  // The Directories list lays out its project sections in DOM order with
  // non-overlapping, increasing bounds. Only their headers are sticky.
  // Find the first section past the existing 1px cutoff, then read through
  // the viewport.
  let first = 0;
  let end = count;
  while (first < end) {
    const middle = first + Math.floor((end - first) / 2);
    if (readBlock(middle).bottom <= stickyTop + 1) first = middle + 1;
    else end = middle;
  }

  const inView: string[] = [];
  for (let index = first; index < count; index += 1) {
    const block = readBlock(index);
    if (block.top >= viewportBottom) break;
    inView.push(block.key);
  }
  return { current: inView[0] ?? null, inView };
}

export function sameProjectSpy(a: ProjectSpy, b: ProjectSpy): boolean {
  return (
    a.current === b.current
    && a.inView.length === b.inView.length
    && a.inView.every((key, index) => key === b.inView[index])
  );
}

/**
 * Where a jump scrolls the Directories list so the project's section starts
 * at the top, and how much blank tail the list needs for that to be possible.
 * A project near the end has too little list below it to reach the top; the
 * tail supplies exactly the missing height. It is dropped once it scrolls out
 * of view (`jumpTailIsOffscreen`). A port of PwrGit's `jumpScrollPlan`.
 *
 * "The top" is where the section's header sticks: `topInset` below the list's
 * edge while the selected thread's dock is there. Landed higher, the header
 * would stick below its own place and cover the project's first rows.
 */
export function jumpScrollPlan(input: {
  scrollTop: number;
  /** The section's top, relative to the list's top edge. */
  blockTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** The tail already drawn, in px. */
  tailHeight: number;
  /** Where the headers stick, below the list's top edge, in px. */
  topInset?: number;
}): { scrollTop: number; tailHeight: number } {
  const target = Math.max(
    0,
    Math.round(input.scrollTop + input.blockTop - (input.topInset ?? 0)),
  );
  const maxScroll = Math.max(0, input.scrollHeight - input.clientHeight);
  const missing = target - maxScroll;
  return {
    scrollTop: target,
    tailHeight: missing > 0 ? input.tailHeight + missing : input.tailHeight,
  };
}

/**
 * A jump's landing, held until the operator scrolls: the dock's reserve it
 * placed the project under, and whether it has already moved for a shrink.
 */
export type JumpLanding = { reserve: number; lowered: boolean };

/**
 * Whether a held landing lands again when the dock's reserve changes to
 * `reserve`, and how it is held after.
 *
 * The jump itself can move the dock: scrolling the open thread's row out of
 * view brings it to the top, scrolling it back in sends it away. A reserve
 * that grew always lands again, or the stuck header slides over the first
 * rows, and so does one that shrank while the dock stays (its card settling
 * to its drawn height). The dock leaving leaves the header resting in its
 * own place with the strip above showing; landing again is tidier, but
 * landing flush can be what scrolls the open thread's row away and brings
 * the dock back. So the dock's leaving moves the list once per landing, and
 * the answer always settles.
 */
export function jumpRelanding(
  landing: JumpLanding,
  reserve: number,
): JumpLanding | undefined {
  if (reserve === landing.reserve) return undefined;
  if (reserve > 0) return { reserve, lowered: landing.lowered };
  return landing.lowered ? undefined : { reserve, lowered: true };
}

/** The tail can go when none of it is on screen: removing it then moves
 *  nothing the reader can see. */
export function jumpTailIsOffscreen(tailTop: number, viewportBottom: number): boolean {
  return tailTop >= viewportBottom;
}

/**
 * Typeahead: the next name after `from` (wrapping) that starts with `query`,
 * case-insensitively. A query of one repeated letter cycles through the names
 * starting with it, the way a native list does. -1 when nothing matches.
 */
export function projectTypeaheadIndex(
  names: readonly string[],
  from: number,
  query: string,
): number {
  if (query === "" || names.length === 0) return -1;
  const lowered = query.toLocaleLowerCase();
  const repeated = lowered.length > 1 && [...lowered].every((ch) => ch === lowered[0]);
  const needle = repeated ? lowered[0]! : lowered;
  // A fresh multi-letter query may still match the item it started on.
  const start = repeated || lowered.length === 1 ? from + 1 : from;
  for (let step = 0; step < names.length; step += 1) {
    const index = (((start + step) % names.length) + names.length) % names.length;
    if (names[index]!.toLocaleLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/**
 * A dragged index width, kept inside what the sidebar can give it right now:
 * no narrower than its shortest useful truncation, no wider than the width
 * past the list's floor. Rounded, because it is persisted and announced.
 */
export function clampProjectIndexWidth(raw: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(Math.max(min, max), raw)));
}
