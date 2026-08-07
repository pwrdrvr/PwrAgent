/**
 * A project rendered as a sun on the star map.
 *
 * Deliberately not a `StarMapInstanceCard`: a project has no celestial
 * icon, no connection state, and no viewer to open — it is a place, not a
 * machine. Its threads come from every instance in the federation, which
 * is the whole point of the lens.
 */
export function StarMapProjectBody(props: {
  label: string;
  projectKey: string;
  threadCount: number;
}) {
  return (
    <div className="star-map-project" data-project-key={props.projectKey}>
      <span className="star-map-project__glow" aria-hidden="true" />
      <span className="star-map-project__core" aria-hidden="true" />
      <span className="star-map-project__label" title={props.label}>
        <span className="star-map-project__name">{props.label}</span>
        <span className="star-map-project__count">{props.threadCount}</span>
      </span>
    </div>
  );
}
