/**
 * A filesystem path that truncates in the middle rather than at the tail.
 *
 * `text-overflow: ellipsis` always eats the end of the string, which for a
 * path is the only part that identifies it: three profile directories under
 * one long temp home clip to the same visible prefix. Splitting at the last
 * separator and pinning that final segment keeps `/default`, `/work`,
 * `/.codex` on screen and ellipsizes the shared prefix instead.
 *
 * The full value stays on the container's `title`, and the two spans have no
 * separator between them, so the accessible name and any text selection read
 * as the original path.
 */
export function SettingsSplitPath(props: {
  className?: string;
  /** Display form — usually `tildifyPath(value)`. */
  value: string;
  /** Hover/`title` form. Defaults to `value`. Pass the untildified path. */
  title?: string;
}) {
  const separator = Math.max(
    props.value.lastIndexOf("/"),
    props.value.lastIndexOf("\\"),
  );
  // `> 0` rather than `>= 0`: a root-level `/work` has nothing to ellipsize,
  // so it stays one span instead of becoming an empty head plus the whole
  // value pinned, which would size the box to the full string.
  const split = separator > 0;
  const head = split ? props.value.slice(0, separator) : props.value;
  const tail = split ? props.value.slice(separator) : "";

  return (
    <span
      className={`settings-splitpath${props.className ? ` ${props.className}` : ""}`}
      title={props.title ?? props.value}
    >
      <span className="settings-splitpath__head">{head}</span>
      {tail ? <span className="settings-splitpath__tail">{tail}</span> : null}
    </span>
  );
}
