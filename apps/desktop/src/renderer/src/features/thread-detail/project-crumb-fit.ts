/**
 * How the thread header's project name gives way when the breadcrumb runs
 * out of room.
 *
 * The name and the thread title are both shrinkable flex items. With no
 * floor on the name, the two shared the squeeze, and a five-letter project
 * like `codex` came out as `cod…` beside a 40-character title: the ellipsis
 * took as much room as the two letters it hid.
 *
 * So a short name is never cut. Its whole width is its floor
 * (`min-width: max-content`) and the title gives way instead. A long name
 * still truncates, but keeps the 12ch floor in app.css, about a dozen
 * characters. Every name longer than
 * `PROJECT_CRUMB_WHOLE_MAX_CHARS` is wider than that floor by several
 * characters, so a truncation always hides more than the ellipsis costs.
 */
export const PROJECT_CRUMB_WHOLE_MAX_CHARS = 20;

export type ProjectCrumbFit = "whole" | "floor";

/**
 * East Asian wide and fullwidth characters, and emoji, draw about twice as
 * wide as a Latin letter, so each counts as two columns. Without that, a
 * 20-character CJK name stayed whole at about twice the intended width.
 */
const WIDE_CHARACTER =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]|\p{Extended_Pictographic}/u;

/** The label's width in Latin-letter columns, by code point. */
export function projectCrumbColumns(label: string): number {
  let columns = 0;
  for (const character of label) {
    columns += WIDE_CHARACTER.test(character) ? 2 : 1;
  }
  return columns;
}

/** `whole`: never truncate. `floor`: truncate, but not below the floor. */
export function projectCrumbFit(label: string): ProjectCrumbFit {
  return projectCrumbColumns(label) <= PROJECT_CRUMB_WHOLE_MAX_CHARS
    ? "whole"
    : "floor";
}
