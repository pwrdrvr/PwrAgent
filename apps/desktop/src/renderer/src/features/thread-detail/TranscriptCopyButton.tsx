import { useEffect, useRef, useState } from "react";
import { CopyIcon } from "../../icons";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";

type TranscriptCopyButtonProps = {
  className?: string;
  copiedLabel?: string;
  desktopApi?: Pick<DesktopApi, "copyText">;
  label: string;
  text: string;
};

export function TranscriptCopyButton(props: TranscriptCopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  return (
    <button
      type="button"
      className={["transcript-copy-button", props.className].filter(Boolean).join(" ")}
      data-copied={copied ? "true" : undefined}
      aria-label={copied ? props.copiedLabel ?? "Copied" : props.label}
      title={copied ? props.copiedLabel ?? "Copied" : props.label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyText(props.text, props.desktopApi)
          .then(() => {
            if (resetTimerRef.current) {
              window.clearTimeout(resetTimerRef.current);
            }
            setCopied(true);
            resetTimerRef.current = window.setTimeout(() => {
              setCopied(false);
              resetTimerRef.current = undefined;
            }, 1400);
          })
          .catch((error: unknown) => {
            console.error("Failed to copy transcript text", error);
          });
      }}
    >
      <CopyIcon size={14} aria-hidden="true" />
    </button>
  );
}
