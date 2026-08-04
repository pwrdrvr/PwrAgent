import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";

type TranscriptCopyButtonProps = {
  as?: "button" | "span";
  children?: ReactNode;
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

  const label = copied ? props.copiedLabel ?? "Copied" : props.label;
  const activate = (event: {
    preventDefault: () => void;
    stopPropagation: () => void;
  }): void => {
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
  };

  if (props.as === "span") {
    return (
      <span
        role="button"
        tabIndex={0}
        className={["transcript-copy-button", props.className].filter(Boolean).join(" ")}
        data-copied={copied ? "true" : undefined}
        aria-label={label}
        title={label}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            activate(event);
          }
        }}
      >
        {props.children}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={["transcript-copy-button", props.className].filter(Boolean).join(" ")}
      data-copied={copied ? "true" : undefined}
      aria-label={label}
      title={label}
      onClick={activate}
    >
      {props.children}
    </button>
  );
}
