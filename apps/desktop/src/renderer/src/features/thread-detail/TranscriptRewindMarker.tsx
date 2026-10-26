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
  return (
    <div className="transcript-rewind-marker">
      <span>
        {props.label}
        {undo ? (
          <>
            {" · "}
            <button
              aria-label="Undo rewind"
              className={undo.disabledReason
                ? "transcript-rewind-marker__undo tooltip-target"
                : "transcript-rewind-marker__undo"}
              data-tooltip={undo.disabledReason}
              disabled={undo.busy || Boolean(undo.disabledReason)}
              type="button"
              onClick={undo.onUndo}
            >
              {undo.busy ? "Undoing..." : "Undo"}
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}
