import { useEffect, useLayoutEffect, useRef } from "react";
import type { ComposerDictationView, DictationLevelListener } from "./useComposerDictation";

type LevelSource = (listener: DictationLevelListener) => () => void;

// Draws the microphone level straight to the element: it changes ten times a
// second, which must not render the composer.
function InputLevel({ onLevel }: { onLevel: LevelSource }) {
  const fill = useRef<HTMLSpanElement>(null);
  useEffect(() => onLevel((level) => {
    fill.current?.style.setProperty("--dictation-level", level.toFixed(2));
  }), [onLevel]);
  return (
    <span className="composer__dictation-level" aria-hidden="true">
      <span ref={fill} />
    </span>
  );
}

function TranscriptPreview({ text }: { text: string }) {
  const preview = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    const element = preview.current;
    if (element && following.current) {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    }
  }, [text]);

  return (
    <div
      ref={preview}
      className="composer__meta composer__dictation-preview"
      role="region"
      aria-label="Live transcript"
      tabIndex={0}
      onScroll={({ currentTarget }) => {
        const { scrollTop, scrollHeight, clientHeight } = currentTarget;
        // scrollTop can be fractional even when the other measurements are integers.
        following.current = scrollHeight - clientHeight - scrollTop <= 1;
      }}
    >
      {text}
    </div>
  );
}

export function ComposerDictationFeedback({ phase, text, error, onLevel }: ComposerDictationView & {
  onLevel: LevelSource;
}) {
  if (phase === "idle" && !text && !error) return null;
  return (
    <div className="composer__dictation-feedback">
      {error ? <p className="composer__meta composer__meta--error" role="alert">{error}</p> : null}
      {phase !== "idle" ? (
        <p className="composer__meta composer__dictation-status" aria-live="polite">
          {phase === "listening" ? <InputLevel onLevel={onLevel} /> : null}
          {phase === "connecting" ? "Connecting to OpenAI and the microphone…"
            : phase === "listening" ? "Listening… Press Enter to add this to the draft."
              : "Finalizing transcript…"}
        </p>
      ) : null}
      {text ? <TranscriptPreview text={text} /> : null}
    </div>
  );
}
