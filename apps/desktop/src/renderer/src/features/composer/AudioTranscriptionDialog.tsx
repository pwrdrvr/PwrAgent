import { useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AUDIO_TRANSCRIPTION_PRICE, type AudioTranscriptionResult } from "../../../../shared/audio-transcription";
import { useModalDialog } from "../../lib/useModalDialog";

export function AudioTranscriptionDialog(props: {
  transcribe: () => Promise<AudioTranscriptionResult>;
  onInsert: (text: string) => boolean;
  onClose: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const titleId = useId();
  const detailsId = useId();
  const ref = useModalDialog({ onClose: props.onClose, returnFocus: props.returnFocus });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [transcript, setTranscript] = useState<string>();

  const transcribe = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await props.transcribe();
      if (result.kind === "error") setError(result.message);
      if (result.kind === "transcribed") setTranscript(result.text);
    } catch {
      setError("PwrAgent could not start audio transcription.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return createPortal(
    <div className="settings-confirm-modal">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={detailsId}
        className="settings-confirm-dialog audio-transcription-dialog"
      >
        <h2 id={titleId}>Transcribe audio</h2>
        <p id={detailsId}>
          PwrAgent sends the selected file (up to 25 MB) to OpenAI.
          {" "}OpenAI bills your API project {AUDIO_TRANSCRIPTION_PRICE} of audio.
        </p>
        {busy ? <p role="status">Waiting for audio transcription…</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {transcript ? (
          <p className="audio-transcription-dialog__preview" tabIndex={0} aria-label="Transcript preview">
            {transcript}
          </p>
        ) : null}
        <div className="settings-confirm-dialog__actions">
          <button className="button button--ghost" type="button" onClick={props.onClose}>
            Close
          </button>
          {transcript ? (
            <button
              className="button button--primary"
              type="button"
              onClick={() => {
                if (props.onInsert(transcript)) props.onClose();
                else setError("The draft is unavailable. Wait until it is editable to add the transcript.");
              }}
            >
              Add to draft
            </button>
          ) : (
            <button
              className="button button--primary"
              disabled={busy}
              type="button"
              onClick={() => void transcribe()}
            >
              Choose audio file…
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
