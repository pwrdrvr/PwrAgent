import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "../../icons";
import { copyImage } from "../../lib/copy-image";
import {
  tooltipHandlers,
  useInheritedViewportTooltip,
  useViewportTooltip,
} from "../../lib/useViewportTooltip";

/**
 * `chip` for the Mermaid strip's bordered row; `pill` for the lightbox's
 * floating control pill. Both draw a glyph beside a one-word label — two copy
 * glyphs alone, which is what the Mermaid viewer shows, are indistinguishable.
 */
export type ClipboardActionAppearance = "chip" | "pill";

export function ImageCopyButton({ src, appearance }: { src: string; appearance: ClipboardActionAppearance }) {
  return <ClipboardActionButton key={src} label="Copy image" text="image"
    appearance={appearance} copy={() => copyImage(src)} />;
}

export function ClipboardActionButton({ label, text, copy, appearance }: {
  /** The accessible name and the tooltip. Contains `text`, so the visible word
   *  is inside the name the control answers to (WCAG 2.5.3). */
  label: string;
  /** The visible word beside the glyph. */
  text: string;
  copy: () => Promise<void>;
  appearance: ClipboardActionAppearance;
}) {
  const [status, setStatus] = useState<"idle" | "pending" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  // Inside the lightbox this is the dialog's own tooltip, so the pill never
  // shows two at once — including for a copy control the CALLER passed in, which
  // no prop from here could reach. On the Mermaid card's strip there is no
  // surrounding tooltip and this one stands alone; it portals out either way,
  // which is what a `overflow: hidden` surface needs.
  const inherited = useInheritedViewportTooltip();
  const ownTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const activeTooltip = inherited ?? ownTooltip;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; window.clearTimeout(timer.current); };
  }, []);
  return <>
    {/* The label stays the accessible name through every state: it is how the
        control is found by name, so the glyph carries the outcome and the word
        holds still. */}
    <button type="button" aria-label={label} data-status={status}
      className={appearance === "pill"
        ? "image-lightbox__tool image-lightbox__tool--labelled"
        : "image-viewer__button image-viewer__button--labelled"}
      disabled={status === "pending"}
      {...tooltipHandlers(activeTooltip, label)}
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
      {status === "copied"
        ? <CheckIcon size={appearance === "pill" ? 16 : 14} aria-hidden="true" />
        : <CopyIcon size={appearance === "pill" ? 16 : 14} aria-hidden="true" />}
      <span>{text}</span>
    </button>
    <span className="image-viewer__status" role={status === "failed" ? "alert" : "status"}>
      {status === "failed" ? `${label} failed. Try again or use the context menu.` : status === "copied" ? `${label} succeeded` : ""}
    </span>
    {inherited ? null : ownTooltip.tooltipNode}
  </>;
}
