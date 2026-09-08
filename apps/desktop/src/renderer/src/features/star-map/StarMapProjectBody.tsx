/**
 * A project rendered as a sun on the star map.
 *
 * Deliberately not a `StarMapInstanceCard`: a project has no celestial
 * icon, no connection state, and no viewer to open — it is a place, not a
 * machine. Its threads come from every instance in the federation, which
 * is the whole point of the lens.
 */
import { useViewportTooltip } from "../../lib/useViewportTooltip";

export function StarMapProjectBody(props: {
  label: string;
  projectKey: string;
  threadCount: number;
  onLoadMoreThreads?: () => void;
  loadingThreads?: boolean;
  /**
   * Counter-scale for the overview zoom, where the canvas shrinks under
   * the body. Composed into the centring transform rather than applied by
   * the caller, because `.star-map-project` centres itself on its origin
   * and a wrapper transform would move it off that origin.
   */
  scale?: number;
}) {
  const labelTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const scale = props.scale ?? 1;
  return (
    <div
      className="star-map-project"
      data-project-key={props.projectKey}
      style={
        scale === 1
          ? undefined
          : { transform: `translate(-50%, -50%) scale(${scale})` }
      }
    >
      {props.onLoadMoreThreads ? (
        <span className="star-map-instance__actions">
          <button type="button" className="star-map-instance__action"
            aria-label={`Load more threads from instances in ${props.label}`}
            disabled={props.loadingThreads}
            onClick={props.onLoadMoreThreads}
            onMouseEnter={(event) => labelTooltip.show(event.currentTarget, `Load more threads from instances in ${props.label}`)}
            onMouseLeave={labelTooltip.hide}
            onFocus={(event) => labelTooltip.show(event.currentTarget, `Load more threads from instances in ${props.label}`)}
            onBlur={labelTooltip.hide}
          >↓</button>
        </span>
      ) : null}
      <span className="star-map-project__glow" aria-hidden="true" />
      <span className="star-map-project__core" aria-hidden="true" />
      <span
        className="star-map-project__label"
        onMouseEnter={(event) =>
          labelTooltip.show(event.currentTarget, props.label)
        }
        onMouseLeave={labelTooltip.hide}
      >
        <span className="star-map-project__name">{props.label}</span>
        <span className="star-map-project__count">{props.threadCount}</span>
      </span>
      {labelTooltip.tooltipNode}
    </div>
  );
}
