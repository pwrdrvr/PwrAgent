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
import { useModalDialog } from "../../lib/useModalDialog";
import {
  tooltipHandlers,
  useViewportTooltip,
  ViewportTooltipProvider,
  type ViewportTooltip,
} from "../../lib/useViewportTooltip";
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
  // Focus lands on the frame rather than the first control, so opening the
  // lightbox raises no control's tooltip.
  const dialogRef = useModalDialog<HTMLDivElement>({ onClose, initialFocus: "dialog" });
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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    const wheel = (event: WheelEvent) => {
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    dialog?.addEventListener("wheel", wheel, { passive: false });
    return () => {
      dialog?.removeEventListener("wheel", wheel);
      document.body.style.overflow = previousOverflow;
    };
  }, [dialogRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
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
  }, [onNext, onPrevious]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <ViewportTooltipProvider value={tooltip}>
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
        // Keyboard activation of a control synthesises a click with no
        // `pointerdown` behind it and reports (0, 0), so it would otherwise be
        // matched against whatever record an aborted press left here.
        if (event.detail === 0) return;
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
        {...tooltipHandlers(tooltip, "Close (Esc)")}
      >
        <CloseIcon size={18} aria-hidden="true" />
      </button>
      {/* Outside the keyed subtree below, because a live region only announces
          mutations to a region that was already mounted — one rebuilt with the
          image on every gallery step says nothing at all. The visible plate
          rides the bottom cluster and is not itself live. */}
      {gallery ? (
        <span className="image-viewer__status" role="status" aria-live="polite">
          Image {position} of {total}
        </span>
      ) : null}
      <LightboxImage key={src} src={src} alt={alt} actions={actions} tooltip={tooltip}
        meta={gallery || caption ? (
          <p className="image-lightbox__meta">
            {gallery ? (
              <span className="image-lightbox__position">
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
          // `aria-disabled`, not `disabled`, for the same reason the pill's
          // controls use it: a disabled button fires no pointer events, so the
          // greyed-out edge control could never raise the tooltip naming the
          // key that pages the gallery.
          aria-disabled={!onPrevious}
          {...tooltipHandlers(tooltip, "Previous image (Left Arrow)")}
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
          aria-disabled={!onNext}
          {...tooltipHandlers(tooltip, "Next image (Right Arrow)")}
          onClick={(event) => {
            event.stopPropagation();
            onNext?.();
          }}
        >
          <ChevronRightIcon size={22} aria-hidden="true" />
        </button>
      ) : null}
      {tooltip.tooltipNode}
    </div>
    </ViewportTooltipProvider>,
    document.body,
  );
}

function LightboxImage({ src, alt, meta, actions, tooltip }: {
  src: string;
  alt: string;
  meta: ReactNode;
  actions: ReactNode;
  /** The dialog's one tooltip. Per-control instances do not know about each
   *  other, so a control left showing one on focus would still be showing it
   *  while a hover raised a second. */
  tooltip: ViewportTooltip;
}) {
  const gestures = useLightboxGestures();
  return <>
    {/* Focus, not hover: this box is the scrim, so a hover tooltip would pop
        every time the pointer crossed the letterbox. On focus it is the only
        thing that names the arrow-key pan the `onKeyDown` below implements. */}
    <div ref={gestures.viewport} className="image-lightbox__viewport"
      tabIndex={0} aria-label="Image pan and zoom" onKeyDown={gestures.onKeyDown}
      onFocus={(event) => tooltip.show(event.currentTarget, "Use arrow keys to pan")}
      onBlur={tooltip.hide}>
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
          {...tooltipHandlers(tooltip, "Zoom out")}>
          <ZoomOutIcon size={16} aria-hidden="true" />
        </button>
        {/* The readout carries the discoverability the text labels used to: it
            names the state the two magnifiers change. */}
        <span className="image-lightbox__zoom">{gestures.percent > 0 ? `${gestures.percent}%` : "\u2014"}</span>
        <button type="button" className="image-lightbox__tool" aria-label="Zoom in"
          aria-disabled={gestures.view.scale >= 8}
          onClick={() => { if (gestures.view.scale < 8) gestures.zoom(1.5); }}
          {...tooltipHandlers(tooltip, "Zoom in")}>
          <ZoomInIcon size={16} aria-hidden="true" />
        </button>
        <button type="button" className="image-lightbox__tool" aria-label="Fit to window"
          aria-disabled={gestures.atFit}
          onClick={() => { if (!gestures.atFit) gestures.reset(); }}
          {...tooltipHandlers(tooltip, "Fit the whole image in the window")}>
          <FitToWindowIcon size={16} aria-hidden="true" />
        </button>
        <span className="image-lightbox__tool-divider" aria-hidden="true" />
        <ImageCopyButton src={src} appearance="pill" />
        {actions}
      </div>
    </div>
  </>;
}
