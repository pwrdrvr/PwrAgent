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
 */

/** One project section's box, in px from the top of the list's scrollport. */
export type ProjectBlockBox = { key: string; top: number; bottom: number };

export type ProjectSpy = { current: string | null; inView: string[] };

export const NO_PROJECT_SPY: ProjectSpy = { current: null, inView: [] };

/** A dragged width is announced and saved, so it moves in whole pixels. */
export const PROJECT_INDEX_KEYBOARD_STEP = 16;

/**
 * Which project the list is in, and which are on screen.
 *
 * Current is the first section whose bottom is below the list's top edge,
 * which is the section whose sticky header is stuck there. It is never "the
 * most visible" section, which flips back and forth inside a tall project.
 */
export function spyProjects(
  blocks: readonly ProjectBlockBox[],
  viewportHeight: number,
): ProjectSpy {
  let current: string | null = null;
  const inView: string[] = [];
  for (const block of blocks) {
    if (block.bottom <= 1) continue;
    if (block.top >= viewportHeight) break;
    if (current === null) current = block.key;
    inView.push(block.key);
  }
  return { current, inView };
}

export function sameProjectSpy(a: ProjectSpy, b: ProjectSpy): boolean {
  return (
    a.current === b.current
    && a.inView.length === b.inView.length
    && a.inView.every((key, index) => key === b.inView[index])
  );
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
