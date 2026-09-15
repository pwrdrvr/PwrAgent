import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "../../icons";
import { copyImage } from "../../lib/copy-image";

export function ImageCopyButton({ src, appearance }: { src: string; appearance?: ClipboardActionAppearance }) {
  return <ClipboardActionButton key={src} label="Copy image" appearance={appearance} copy={() => copyImage(src)} />;
}

/** `text` for a labelled toolbar row (the Mermaid strip); `icon` for the
 *  lightbox's control pill, where the label becomes the accessible name and
 *  the tooltip instead of visible ink. */
export type ClipboardActionAppearance = "text" | "icon";

export function ClipboardActionButton({ label, copy, appearance = "text" }: {
  label: string;
  copy: () => Promise<void>;
  appearance?: ClipboardActionAppearance;
}) {
  const [status, setStatus] = useState<"idle" | "pending" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const icon = appearance === "icon";
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; window.clearTimeout(timer.current); };
  }, []);
  return <>
    {/* The label stays the accessible name through every state: it is how the
        control is found by name, and "Copied" would move it out from under
        anyone searching for it. */}
    <button type="button" className={icon ? "image-lightbox__tool" : "image-viewer__button"}
      data-status={status} aria-label={icon ? label : undefined} title={icon ? label : undefined}
      disabled={status === "pending"}
      onClick={(event) => {
        event.stopPropagation();
        window.clearTimeout(timer.current);
        setStatus("pending");
        void copy().then(() => {
          if (!mounted.current) return;
          setStatus("copied");
          timer.current = window.setTimeout(() => setStatus("idle"), 1400);
        }).catch(() => { if (mounted.current) setStatus("failed"); });
      }}>
      {icon
        ? status === "copied" ? <CheckIcon size={16} aria-hidden="true" /> : <CopyIcon size={16} aria-hidden="true" />
        : status === "copied" ? "Copied" : label}
    </button>
    <span className="image-viewer__status" role={status === "failed" ? "alert" : "status"}>
      {status === "failed" ? `${label} failed. Try again or use the context menu.` : status === "copied" ? `${label} succeeded` : ""}
    </span>
  </>;
}
