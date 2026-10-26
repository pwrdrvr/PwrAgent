type TranscriptRewindMarkerProps = {
  label: string;
  /** Present only where the provider kept the removed turns. */
  undo?: {
    busy: boolean;
    disabledReason?: string;
    onUndo: () => void;
  };
};

/** The row that stands where a rewind removed turns. */
export function TranscriptRewindMarker(props: TranscriptRewindMarkerProps) {
  const undo = props.undo;
  const unavailable = Boolean(undo?.busy || undo?.disabledReason);
  return (
    <div className="transcript-rewind-marker">
      <span>
        {props.label}
        {undo ? (
          <>
            {" · "}
            {/* aria-disabled, as the prompt's rewind button: a disabled
                button takes no hover, which would hide the reason. */}
            <button
              aria-disabled={unavailable ? true : undefined}
              aria-label="Undo rewind"
              className={undo.disabledReason
                ? "transcript-rewind-marker__undo tooltip-target"
                : "transcript-rewind-marker__undo"}
              data-tooltip={undo.disabledReason}
              type="button"
              onClick={() => {
                if (!unavailable) undo.onUndo();
              }}
            >
              {undo.busy ? "Undoing..." : "Undo"}
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}
