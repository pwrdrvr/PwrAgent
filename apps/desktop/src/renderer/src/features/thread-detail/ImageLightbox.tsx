import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from "../../icons";
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

/**
 * The single full-size local-raster viewer used for pasted Composer attachments,
 * Composer PDF page previews, and sent transcript images. Portaled to `<body>`
 * so it escapes any clipping/stacking ancestor; closes on the scrim, the
 * accent close cookie, or Escape. Transcript galleries add visible edge controls
 * plus Left/Right Arrow navigation. `TranscriptImage` resolves embedded data
 * URLs to object URLs, so both image sources render the same way.
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
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
      onClick={onClose}
    >
      {typeof total === "number" && total > 1 ? (
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
      <div
        className="image-lightbox__content"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <button
          type="button"
          className="image-lightbox__close"
          aria-label="Close"
          onClick={onClose}
        >
          <CloseIcon size={18} aria-hidden="true" />
        </button>
        <LightboxImage key={src} src={src} alt={alt} />
        {typeof position === "number" && typeof total === "number" && total > 1 ? (
          <p className="image-lightbox__position" aria-live="polite">
            <b>{position}</b> / {total}
          </p>
        ) : null}
        {caption ? <p className="image-lightbox__caption">{caption}</p> : null}
      </div>
      {typeof total === "number" && total > 1 ? (
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
    <div className="image-lightbox__toolbar">
      <button type="button" className="image-viewer__button" onClick={() => gestures.zoom(1 / 1.5)}
        disabled={gestures.view.scale <= 0.1}>Zoom out</button>
      <button type="button" className="image-viewer__button" onClick={() => gestures.zoom(1.5)}
        disabled={gestures.view.scale >= 8}>Zoom in</button>
      <button type="button" className="image-viewer__button" onClick={gestures.reset}>Fit to window</button>
      <ImageCopyButton src={src} />
    </div>
    <div ref={gestures.viewport} className="image-lightbox__viewport" data-panning={gestures.panning}
      tabIndex={0} aria-label="Image pan and zoom" title="Use arrow keys to pan"
      onKeyDown={gestures.onKeyDown} {...gestures.pointerHandlers}>
      <TranscriptImage className="image-lightbox__image" src={src} alt={alt}
        draggable={false} onDragStart={(event) => event.preventDefault()}
        onLoad={(event) => gestures.onLoad(event.currentTarget)} style={gestures.imageStyle} />
    </div>
  </>;
}
