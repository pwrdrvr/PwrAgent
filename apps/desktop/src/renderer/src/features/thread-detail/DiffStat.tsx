/**
 * Added/removed line counts rendered consistently everywhere: `+A` (green)
 * then `-R` (red), no comma, monospace — matching the thread-row dirty chip.
 * Pass `className="diff-stat--chip"` for the pill treatment.
 */
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
