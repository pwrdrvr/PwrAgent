import { type ReactNode, useEffect, useRef } from "react";
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
import { TranscriptImage } from "./TranscriptImage";

type ImageLightboxProps = {
  /** Image source — a data URL or any resolvable URL. */
  src: string;
  alt: string;
  /** Optional visible local-image metadata, such as a PDF page count. */
  caption?: ReactNode;
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
 * the top band, the control pill, the edge controls — floats over it in the
 * margins the viewport's insets reserve, so no part of the dialog is a dead
 * rectangle that merely looks dismissable. `app.css` carries the three-box
 * layout this depends on.
 */
export function ImageLightbox({
  src,
  alt,
  caption,
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
      <div className="image-lightbox__band">
        {gallery || caption ? (
          <p className="image-lightbox__meta">
            {gallery ? (
              <span className="image-lightbox__position" aria-live="polite">
                <b>{position}</b> / {total}
              </span>
            ) : null}
            {caption ? <span className="image-lightbox__caption">{caption}</span> : null}
          </p>
        ) : null}
        <button
          type="button"
          className="image-lightbox__close"
          aria-label="Close"
          onClick={onClose}
        >
          <CloseIcon size={18} aria-hidden="true" />
        </button>
      </div>
      <LightboxImage key={src} src={src} alt={alt} />
      {gallery ? (
        <button
          type="button"
          className="image-lightbox__nav image-lightbox__nav--previous"
          aria-label="Previous image"
          disabled={!onPrevious}
          title="Previous image (Left Arrow)"
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
          title="Next image (Right Arrow)"
          onClick={(event) => {
            event.stopPropagation();
            onNext?.();
          }}
        >
          <ChevronRightIcon size={22} aria-hidden="true" />
        </button>
      ) : null}
    </div>,
    document.body,
  );
}

function LightboxImage({ src, alt }: { src: string; alt: string }) {
  const gestures = useLightboxGestures();
  return <>
    <div ref={gestures.viewport} className="image-lightbox__viewport"
      tabIndex={0} aria-label="Image pan and zoom" onKeyDown={gestures.onKeyDown}>
      <TranscriptImage className="image-lightbox__image" src={src} alt={alt}
        data-panning={gestures.panning} draggable={false} onDragStart={(event) => event.preventDefault()}
        onLoad={(event) => gestures.onLoad(event.currentTarget)} style={gestures.imageStyle}
        {...gestures.imageHandlers} />
    </div>
    <div className="image-lightbox__toolbar">
      <button type="button" className="image-lightbox__tool" aria-label="Zoom out" title="Zoom out"
        onClick={() => gestures.zoom(1 / 1.5)} disabled={gestures.view.scale <= 0.1}>
        <ZoomOutIcon size={16} aria-hidden="true" />
      </button>
      {/* The readout carries the discoverability the text labels used to: it
          names the state the two magnifiers move. */}
      <span className="image-lightbox__zoom">{gestures.percent > 0 ? `${gestures.percent}%` : "—"}</span>
      <button type="button" className="image-lightbox__tool" aria-label="Zoom in" title="Zoom in"
        onClick={() => gestures.zoom(1.5)} disabled={gestures.view.scale >= 8}>
        <ZoomInIcon size={16} aria-hidden="true" />
      </button>
      <button type="button" className="image-lightbox__tool" aria-label="Fit to window" title="Fit to window"
        onClick={gestures.reset} disabled={gestures.atFit}>
        <FitToWindowIcon size={16} aria-hidden="true" />
      </button>
      <span className="image-lightbox__tool-divider" aria-hidden="true" />
      <ImageCopyButton src={src} appearance="icon" />
    </div>
  </>;
}
