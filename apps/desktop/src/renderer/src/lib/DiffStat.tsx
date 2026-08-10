/** Added/removed line counts rendered consistently across renderer surfaces. */
export function DiffStat(props: {
  additions: number;
  removals: number;
  className?: string;
}) {
  return (
    <span
      className={`diff-stat${props.className ? ` ${props.className}` : ""}`}
      aria-label={`+${props.additions.toLocaleString()} -${props.removals.toLocaleString()}`}
    >
      <span className="diff-stat__added">
        +{props.additions.toLocaleString()}
      </span>
      <span className="diff-stat__removed">
        -{props.removals.toLocaleString()}
      </span>
    </span>
  );
}
