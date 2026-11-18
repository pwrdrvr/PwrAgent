import { useLayoutEffect, useRef } from "react";
import type { ComposerDictationView } from "./useComposerDictation";

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

export function ComposerDictationFeedback({ phase, text, error }: ComposerDictationView) {
  if (phase === "idle" && !text && !error) return null;
  return (
    <div className="composer__dictation-feedback">
      {error ? <p className="composer__meta composer__meta--error" role="alert">{error}</p> : null}
      {phase !== "idle" ? (
        <p className="composer__meta" aria-live="polite">
          {phase === "connecting" ? "Connecting to OpenAI…"
            : phase === "listening" ? "Listening…"
              : "Finalizing transcript…"}
        </p>
      ) : null}
      {text ? <TranscriptPreview text={text} /> : null}
    </div>
  );
}
