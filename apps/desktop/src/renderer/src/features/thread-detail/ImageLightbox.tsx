import { type FocusEvent, type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FitToWindowIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "../../icons";
import { ImageCopyButton } from "./ImageCopyButton";
import { useLightboxGestures } from "./useLightboxGestures";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { TranscriptImage } from "./TranscriptImage";

type ImageLightboxProps = {
  /** Image source — a data URL or any resolvable URL. */
  src: string;
  alt: string;
  /** Optional visible local-image metadata, such as a PDF page count. */
  caption?: ReactNode;
  /** Extra controls for the pill, after the copy button — a caller with more
   *  than one thing to copy (Mermaid's diagram source) supplies them. */
  actions?: ReactNode;
  /** More specific accessible name for callers that expand a non-photo image. */
  dialogLabel?: string;
  /** One-based position within an optional image gallery. */
  position?: number;
  /** Total number of images in an optional gallery. */
  total?: number;
  onClose: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
};

/** How far a press may travel and still count as a click rather than a drag. */
const DISMISS_SLOP = 4;

/**
 * The single full-size local-raster viewer used for pasted Composer attachments,
 * Composer PDF page previews, and sent transcript images. Portaled to `<body>`
 * so it escapes any clipping/stacking ancestor; closes on the scrim, the
 * accent close cookie, or Escape. Transcript galleries add visible edge controls
 * plus Left/Right Arrow navigation. `TranscriptImage` resolves embedded data
 * URLs to object URLs, so both image sources render the same way.
 *
 * Everything that is not the image is scrim, and scrim dismisses. The chrome —
 * the close cookie, the bottom cluster, the edge controls — floats over it in
 * the margins the viewport's insets reserve, so no part of the dialog is a
 * dead rectangle that merely looks dismissable. `app.css` carries the
 * three-box layout this depends on, and the rule that the top-left and
 * top-right corners belong to the OS rather than to this dialog.
 */
export function ImageLightbox({
  src,
  alt,
  caption,
  actions,
  dialogLabel = "Expanded image",
  position,
  total,
  onClose,
  onNext,
  onPrevious,
}: ImageLightboxProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  /**
   * Recorded in the capture phase, because the image stops pointer events from
   * reaching the dialog — that is what keeps a pan from being read as a press
   * on the scrim. Without the capture phase the record left by an earlier press
   * would still be sitting here when a pan released over the scrim, and the
   * click that follows would close a lightbox the operator was navigating.
   */
  const press = useRef<{ x: number; y: number; scrim: boolean } | null>(null);
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const gallery = typeof total === "number" && total > 1;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const dialog = dialogRef.current;
    const wheel = (event: WheelEvent) => {
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    dialog?.addEventListener("wheel", wheel, { passive: false });
    return () => {
      dialog?.removeEventListener("wheel", wheel);
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      // The focused image viewport owns arrows for panning; the rest of
      // the dialog retains gallery navigation.
      if (event.target instanceof HTMLElement && event.target.matches(".image-lightbox__viewport")) return;
      if (event.key === "ArrowLeft" && onPrevious) {
        event.stopPropagation();
        event.preventDefault();
        onPrevious();
        return;
      }
      if (event.key === "ArrowRight" && onNext) {
        event.stopPropagation();
        event.preventDefault();
        onNext();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose, onNext, onPrevious]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="image-lightbox"
      data-gallery={gallery}
      data-meta={gallery || Boolean(caption)}
      onPointerDownCapture={(event) => {
        // Scrim is the dialog itself and the viewport's empty letterbox.
        // Naming them, rather than excluding every control, means a control
        // that forgets to stop propagation still cannot dismiss by accident.
        press.current = {
          x: event.clientX,
          y: event.clientY,
          scrim:
            event.target === dialogRef.current
            || (event.target instanceof Element
              && event.target.classList.contains("image-lightbox__viewport")),
        };
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
      onClick={(event) => {
        const start = press.current;
        press.current = null;
        if (!start || !start.scrim) return;
        // A press that travelled is a drag the operator aborted over the
        // scrim, not a click on it.
        if (Math.abs(event.clientX - start.x) > DISMISS_SLOP) return;
        if (Math.abs(event.clientY - start.y) > DISMISS_SLOP) return;
        onClose();
      }}
    >
      <button
        type="button"
        className="image-lightbox__close"
        aria-label="Close"
        onClick={onClose}
        {...hint(tooltip, "Close (Esc)")}
      >
        <CloseIcon size={18} aria-hidden="true" />
      </button>
      <LightboxImage key={src} src={src} alt={alt} actions={actions}
        meta={gallery || caption ? (
          <p className="image-lightbox__meta">
            {gallery ? (
              <span className="image-lightbox__position" aria-live="polite">
                <b>{position}</b> / {total}
              </span>
            ) : null}
            {caption ? <span className="image-lightbox__caption">{caption}</span> : null}
          </p>
        ) : null} />
      {gallery ? (
        <button
          type="button"
          className="image-lightbox__nav image-lightbox__nav--previous"
          aria-label="Previous image"
          disabled={!onPrevious}
          {...hint(tooltip, "Previous image (Left Arrow)")}
          onClick={(event) => {
            event.stopPropagation();
            onPrevious?.();
          }}
        >
          <ChevronLeftIcon size={22} aria-hidden="true" />
        </button>
      ) : null}
      {gallery ? (
        <button
          type="button"
          className="image-lightbox__nav image-lightbox__nav--next"
          aria-label="Next image"
          disabled={!onNext}
          {...hint(tooltip, "Next image (Right Arrow)")}
          onClick={(event) => {
            event.stopPropagation();
            onNext?.();
          }}
        >
          <ChevronRightIcon size={22} aria-hidden="true" />
        </button>
      ) : null}
      {tooltip.tooltipNode}
    </div>,
    document.body,
  );
}

/**
 * Hover and focus handlers for one control's tooltip.
 *
 * Not the native `title` attribute, and not the CSS pseudo-element tooltip
 * either: `.image-lightbox` is `overflow: hidden`, which clips the pseudo
 * element, and every control here is an unlabelled glyph, so "what does this
 * do" has to be answerable. `useViewportTooltip` portals out of the clip and
 * already knows to stay clear of the macOS stoplights and the win32 title
 * strip.
 */
function hint(tooltip: ReturnType<typeof useViewportTooltip>, label: string) {
  return {
    onMouseEnter: (event: MouseEvent<HTMLElement>) => tooltip.show(event.currentTarget, label),
    onMouseLeave: tooltip.hide,
    onFocus: (event: FocusEvent<HTMLElement>) => tooltip.show(event.currentTarget, label),
    onBlur: tooltip.hide,
  };
}

function LightboxImage({ src, alt, meta, actions }: {
  src: string;
  alt: string;
  meta: ReactNode;
  actions: ReactNode;
}) {
  const gestures = useLightboxGestures();
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  return <>
    <div ref={gestures.viewport} className="image-lightbox__viewport"
      tabIndex={0} aria-label="Image pan and zoom" onKeyDown={gestures.onKeyDown}>
      <TranscriptImage className="image-lightbox__image" src={src} alt={alt}
        data-panning={gestures.panning} draggable={false} onDragStart={(event) => event.preventDefault()}
        onLoad={(event) => gestures.onLoad(event.currentTarget)} style={gestures.imageStyle}
        {...gestures.imageHandlers} />
    </div>
    {/* The bottom cluster. Nothing rides the top corners: macOS draws its
        stoplights in the top-left of the renderer and win32/linux draw caption
        buttons in the top-right, and this dialog covers both. */}
    <div className="image-lightbox__chrome">
      {meta}
      <div className="image-lightbox__toolbar">
        <button type="button" className="image-lightbox__tool" aria-label="Zoom out"
          aria-disabled={gestures.view.scale <= 0.1}
          onClick={() => { if (gestures.view.scale > 0.1) gestures.zoom(1 / 1.5); }}
          {...hint(tooltip, "Zoom out")}>
          <ZoomOutIcon size={16} aria-hidden="true" />
        </button>
        {/* The readout carries the discoverability the text labels used to: it
            names the state the two magnifiers change. */}
        <span className="image-lightbox__zoom">{gestures.percent > 0 ? `${gestures.percent}%` : "\u2014"}</span>
        <button type="button" className="image-lightbox__tool" aria-label="Zoom in"
          aria-disabled={gestures.view.scale >= 8}
          onClick={() => { if (gestures.view.scale < 8) gestures.zoom(1.5); }}
          {...hint(tooltip, "Zoom in")}>
          <ZoomInIcon size={16} aria-hidden="true" />
        </button>
        <button type="button" className="image-lightbox__tool" aria-label="Fit to window"
          aria-disabled={gestures.atFit}
          onClick={() => { if (!gestures.atFit) gestures.reset(); }}
          {...hint(tooltip, "Fit the whole image in the window")}>
          <FitToWindowIcon size={16} aria-hidden="true" />
        </button>
        <span className="image-lightbox__tool-divider" aria-hidden="true" />
        <ImageCopyButton src={src} appearance="pill" />
        {actions}
      </div>
      {tooltip.tooltipNode}
    </div>
  </>;
}
