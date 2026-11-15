export function SkillPickerHeader(props: {
  loading?: boolean;
  onDismiss: () => void;
  onRefresh: () => void | Promise<void>;
}) {
  return (
    <div className="composer__skill-picker-header">
      <span>Skills</span>
      <button
        aria-label="Refresh skills"
        className="composer__skill-picker-refresh"
        disabled={props.loading}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => { void props.onRefresh(); }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            props.onDismiss();
          }
        }}
        type="button"
      >
        {props.loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
