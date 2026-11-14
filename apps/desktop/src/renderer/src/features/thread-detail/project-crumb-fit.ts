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

/** `whole`: never truncate. `floor`: truncate, but not below the floor. */
export function projectCrumbFit(label: string): ProjectCrumbFit {
  // Code points, not UTF-16 units, so an emoji counts as one character.
  return Array.from(label).length <= PROJECT_CRUMB_WHOLE_MAX_CHARS
    ? "whole"
    : "floor";
}
