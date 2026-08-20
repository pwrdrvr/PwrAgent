/**
 * The matched run of an autocomplete row's label, marked up so the operator
 * can see why a row is in the list.
 *
 * Its own module because more than one composer surface renders
 * autocomplete rows, and a second copy would be free to drift on which
 * span carries `.composer__autocomplete-match` — the one thing every
 * surface's highlight styling hangs off.
 */
export function HighlightedAutocompleteLabel(props: {
  label: string;
  matchAnywhere?: boolean;
  query: string;
}) {
  const matchIndex = !props.query
    ? -1
    : props.matchAnywhere
      ? props.label.toLowerCase().indexOf(props.query.toLowerCase())
      : props.label.toLowerCase().startsWith(props.query.toLowerCase())
        ? 0
        : -1;
  if (matchIndex < 0) {
    return <span>{props.label}</span>;
  }

  return (
    <span>
      {props.label.slice(0, matchIndex)}
      <span className="composer__autocomplete-match">
        {props.label.slice(matchIndex, matchIndex + props.query.length)}
      </span>
      {props.label.slice(matchIndex + props.query.length)}
    </span>
  );
}
