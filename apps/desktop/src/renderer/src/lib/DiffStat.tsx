/**
 * Added/removed line counts rendered consistently everywhere: `+A` (green)
 * then `-R` (red), no comma, monospace — matching the thread-row dirty chip.
 * Pass `className="diff-stat--chip"` for the pill treatment.
 *
 * Lives in `lib/` rather than beside the edits panel so surfaces outside
 * thread-detail (the PR chip hover card) can render the same `+A -R` without a
 * feature-to-feature import — the same move `format-duration.ts` made.
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
