import { type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
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
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import {
  tooltipHandlers,
  useViewportTooltip,
  ViewportTooltipProvider,
  type ViewportTooltip,
} from "../../lib/useViewportTooltip";
import { TranscriptImage } from "./TranscriptImage";
import { interactiveSvgDocument } from "./interactive-svg-document";
import { loadImageBlob } from "../../lib/load-image-blob";
import { useInteractiveSvgPreferences } from "../../lib/interactive-svg-preferences";

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
  /** Enables an isolated document view for transcript SVG links. */
  interactiveSvg?: boolean;
  onClose: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
};

/** How far a press may travel and still count as a click rather than a drag. */
const DISMISS_SLOP = 4;

/** Whether a click is the release of the press recorded at `start`, rather
 *  than a keyboard activation (which reports no pointer) or the end of a drag. */
function isPointerClick(start: { x: number; y: number } | null, event: ReactMouseEvent): boolean {
  if (!start || event.detail === 0) return false;
  return Math.abs(event.clientX - start.x) <= DISMISS_SLOP
    && Math.abs(event.clientY - start.y) <= DISMISS_SLOP;
}

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
  interactiveSvg = false,
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
      // A text field (the SVG search) owns its arrows for the caret.
      if (event.target instanceof HTMLElement
        && (event.target.matches("input, textarea, select") || event.target.isContentEditable)) return;
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
        // matched against whatever record an aborted press left here. A press
        // that travelled is a drag the operator aborted over the scrim.
        if (!start?.scrim || !isPointerClick(start, event)) return;
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
        interactiveSvg={interactiveSvg} onClose={onClose}
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

function LightboxImage({ src, alt, meta, actions, tooltip, interactiveSvg, onClose }: {
  src: string;
  alt: string;
  meta: ReactNode;
  actions: ReactNode;
  interactiveSvg: boolean;
  onClose: () => void;
  /** The dialog's one tooltip. Per-control instances do not know about each
   *  other, so a control left showing one on focus would still be showing it
   *  while a hover raised a second. */
  tooltip: ViewportTooltip;
}) {
  const gestures = useLightboxGestures();
  const [svgDocument, setSvgDocument] = useState<string>();
  const [svgColorScheme, setSvgColorScheme] = useState<"light" | "dark">("light");
  const [svgActive, setSvgActive] = useState(false);
  const [svgSearchOpen, setSvgSearchOpen] = useState(false);
  const [svgSearchTerm, setSvgSearchTerm] = useState("");
  const [svgSearchError, setSvgSearchError] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const search = useRef<HTMLFormElement>(null);
  useDismissableLayer({
    open: svgActive && svgSearchOpen,
    onDismiss: () => setSvgSearchOpen(false),
    surfaceRef: search,
  });
  const preferences = useInteractiveSvgPreferences();
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [noticeSkip, setNoticeSkip] = useState(false);
  const [noticeAutoOpen, setNoticeAutoOpen] = useState(false);
  const [noticeSaving, setNoticeSaving] = useState(false);
  const [noticeError, setNoticeError] = useState(false);
  const notice = useRef<HTMLDivElement>(null);
  const noticeOpener = useRef<HTMLElement | null>(null);
  const noticeTitleId = useId();
  const noticeBodyId = useId();
  /** Where a press on the image began, so a pan is not read as a click. */
  const imagePress = useRef<{ x: number; y: number } | null>(null);
  const autoOpened = useRef(false);
  /** Bumped whenever the notice closes, so a save still in flight when the
   *  operator cancels cannot go on to run the scripts. */
  const noticeGeneration = useRef(0);
  const closeNotice = (): void => {
    noticeGeneration.current += 1;
    setNoticeOpen(false);
    if (noticeOpener.current?.isConnected) noticeOpener.current.focus();
    noticeOpener.current = null;
  };
  useDismissableLayer({ open: noticeOpen, onDismiss: closeNotice, surfaceRef: notice });

  useEffect(() => {
    if (!interactiveSvg) return;
    const controller = new AbortController();
    setSvgDocument(undefined);
    // Read once per image: a theme change while the frame is open leaves the
    // frame on its old scheme, which still matches the frame element's pin.
    const colorScheme = getComputedStyle(document.documentElement).colorScheme === "dark" ? "dark" : "light";
    void (async () => {
      try {
        const blob = await loadImageBlob(src, controller.signal);
        if (blob.type !== "image/svg+xml" || blob.size > 16 * 1024 * 1024) {
          throw new Error("SVG format or size is not supported");
        }
        const document = interactiveSvgDocument(await blob.text(), colorScheme);
        if (controller.signal.aborted) return;
        setSvgColorScheme(colorScheme);
        setSvgDocument(document);
      } catch (error) {
        if (!controller.signal.aborted) console.error("Failed to inspect SVG", error);
      }
    })();
    return () => controller.abort();
  }, [interactiveSvg, src]);
  // Once per image: Preview after an automatic open stays on the preview.
  useEffect(() => {
    if (!svgDocument || !preferences.autoOpen || autoOpened.current) return;
    autoOpened.current = true;
    setSvgActive(true);
  }, [preferences.autoOpen, svgDocument]);
  useEffect(() => {
    if (!svgActive) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data === "pwragent-interactive-svg-escape") {
        if (svgSearchOpen) setSvgSearchOpen(false);
        else onClose();
      } else if (event.data === "pwragent-interactive-svg-search") {
        setSvgSearchError(false);
        setSvgSearchOpen(true);
      } else if (event.data === "pwragent-interactive-svg-search-error") {
        setSvgSearchError(true);
        setSvgSearchOpen(true);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onClose, svgActive, svgSearchOpen]);

  const startInteractiveSvg = (): void => {
    // The operator chose for this image; a later "open ready to use" must not
    // override a Preview they pick after it.
    autoOpened.current = true;
    noticeGeneration.current += 1;
    setNoticeOpen(false);
    noticeOpener.current = null;
    setSvgSearchOpen(false);
    setSvgActive(true);
  };
  const showPreview = (): void => {
    setSvgActive(false);
    setSvgSearchOpen(false);
  };
  /** The SVG's scripts are untrusted code, so they run only once the operator
   *  has accepted the notice, here or in an earlier "Don't ask again". */
  const requestInteractiveSvg = (): void => {
    if (preferences.skipNotice || preferences.autoOpen) {
      startInteractiveSvg();
      return;
    }
    // Already asking: keep the operator's choices and the original opener,
    // not the notice's own Cancel button.
    if (noticeOpen) return;
    noticeOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setNoticeSkip(false);
    setNoticeAutoOpen(false);
    setNoticeError(false);
    setNoticeOpen(true);
  };
  const acceptNotice = async (): Promise<void> => {
    const patch = {
      ...(noticeSkip || noticeAutoOpen ? { interactiveSvgSkipNotice: true } : {}),
      ...(noticeAutoOpen ? { interactiveSvgAutoOpen: true } : {}),
    };
    if (preferences.save && Object.keys(patch).length > 0) {
      const generation = noticeGeneration.current;
      setNoticeSaving(true);
      setNoticeError(false);
      const saved = await preferences.save(patch).catch(() => false);
      setNoticeSaving(false);
      if (generation !== noticeGeneration.current) return;
      if (!saved) {
        setNoticeError(true);
        return;
      }
    }
    startInteractiveSvg();
  };
  const interactOnClick = Boolean(svgDocument) && !svgActive;
  const interactHint = "Click to enable SVG interaction";

  return <>
    {/* Focus, not hover: this box is the scrim, so a hover tooltip would pop
        every time the pointer crossed the letterbox. On focus it is the only
        thing that names the arrow-key pan the `onKeyDown` below implements. */}
    <div ref={svgActive ? undefined : gestures.viewport}
      className={svgActive
        ? "image-lightbox__viewport image-lightbox__viewport--interactive"
        : "image-lightbox__viewport"}
      tabIndex={svgActive ? undefined : 0}
      aria-label={svgActive ? undefined : "Image pan and zoom"}
      onKeyDown={svgActive ? undefined : gestures.onKeyDown}
      onFocus={svgActive ? undefined : (event) => tooltip.show(event.currentTarget, "Use arrow keys to pan")}
      onBlur={svgActive ? undefined : tooltip.hide}>
      {svgActive && svgDocument ? (
        <iframe ref={frame} className="image-lightbox__interactive-svg"
          title={`Interactive SVG: ${alt}`}
          sandbox="allow-scripts" referrerPolicy="no-referrer"
          style={{ colorScheme: svgColorScheme }}
          srcDoc={svgDocument} />
      ) : (
        <TranscriptImage className="image-lightbox__image" src={src} alt={alt}
          data-panning={gestures.panning} data-interact-on-click={interactOnClick} draggable={false} onDragStart={(event) => event.preventDefault()}
          onLoad={(event) => gestures.onLoad(event.currentTarget)} style={gestures.imageStyle}
          {...gestures.imageHandlers}
          {...(interactOnClick && !noticeOpen ? tooltipHandlers(tooltip, interactHint) : {})}
          // The SVG is read after the lightbox opens, under a pointer that is
          // usually already on the image: no enter event follows, so the first
          // movement raises the hint instead.
          onMouseMove={interactOnClick && !noticeOpen && !tooltip.visible ? (event) => {
            if (event.buttons === 0) tooltip.show(event.currentTarget, interactHint);
          } : undefined}
          onPointerDown={(event) => {
            imagePress.current = { x: event.clientX, y: event.clientY };
            if (interactOnClick) tooltip.hide();
            gestures.imageHandlers.onPointerDown(event);
          }}
          onClick={interactOnClick ? (event) => {
            const start = imagePress.current;
            imagePress.current = null;
            // A press that travelled is a pan, the image's other gesture.
            if (isPointerClick(start, event)) requestInteractiveSvg();
          } : undefined} />
      )}
      {svgActive && svgSearchOpen ? (
        <form ref={search} className="image-lightbox__svg-search" onSubmit={(event) => {
          event.preventDefault();
          frame.current?.contentWindow?.postMessage({
            type: "pwragent-interactive-svg-search-term",
            term: svgSearchTerm,
          }, "*");
          setSvgSearchOpen(false);
        }}>
          <input aria-label="Search SVG frames" autoFocus value={svgSearchTerm}
            onChange={(event) => setSvgSearchTerm(event.target.value)} />
          <button type="submit">Find</button>
          <button type="button" onClick={() => setSvgSearchOpen(false)}>Cancel</button>
          {svgSearchError ? <span role="alert">Invalid search expression</span> : null}
        </form>
      ) : null}
    </div>
    {/* The bottom cluster. Nothing rides the top corners: macOS draws its
        stoplights in the top-left of the renderer and win32/linux draw caption
        buttons in the top-right, and this dialog covers both. */}
    <div className="image-lightbox__chrome">
      {meta}
      <div className="image-lightbox__toolbar">
        {svgActive ? <span className="image-lightbox__interactive-label">Interactive SVG</span> : <>
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
        </>}
        <span className="image-lightbox__tool-divider" aria-hidden="true" />
        {svgDocument && !svgActive ? (
          <span className="image-lightbox__interactive-hint">This SVG has interactive controls</span>
        ) : null}
        {svgDocument ? (
          <button type="button" className={`image-lightbox__tool image-lightbox__tool--labelled${svgActive ? "" : " image-lightbox__tool--interactive-available"}`}
            aria-label={svgActive ? "Show image preview" : "Interact with SVG"}
            onClick={svgActive ? showPreview : requestInteractiveSvg}
            {...tooltipHandlers(tooltip, svgActive ? "Show image preview" : "Use SVG hover, zoom, and search controls in an isolated view")}>
            {svgActive ? "Preview" : "Interact"}
          </button>
        ) : null}
        <ImageCopyButton src={src} appearance="pill" />
        {actions}
      </div>
    </div>
    {noticeOpen ? (
      <div ref={notice} className="image-lightbox__svg-notice" role="dialog"
        aria-labelledby={noticeTitleId} aria-describedby={noticeBodyId}>
        <p id={noticeTitleId} className="image-lightbox__svg-notice-title">Run this SVG&rsquo;s scripts?</p>
        <p id={noticeBodyId} className="image-lightbox__svg-notice-body">
          This SVG contains code. PwrAgent runs it in an isolated frame with no network or file
          access, but malicious code can break out of isolation. Run it only if you trust where it
          came from: you accept the risk of running it on this computer.
        </p>
        {preferences.save ? <>
          <label className="composer__checkbox image-lightbox__svg-notice-option">
            <input type="checkbox" checked={noticeSkip || noticeAutoOpen}
              disabled={noticeSaving || noticeAutoOpen}
              onChange={(event) => setNoticeSkip(event.currentTarget.checked)} />
            <span>Don&rsquo;t ask again</span>
          </label>
          <label className="composer__checkbox image-lightbox__svg-notice-option">
            <input type="checkbox" checked={noticeAutoOpen} disabled={noticeSaving}
              onChange={(event) => setNoticeAutoOpen(event.currentTarget.checked)} />
            <span>Open SVGs ready to use from now on</span>
          </label>
        </> : null}
        {noticeError ? (
          <p className="image-lightbox__svg-notice-error" role="alert">
            Couldn&rsquo;t save that choice. Try again, or clear the checkboxes to run it once.
          </p>
        ) : null}
        <div className="image-lightbox__svg-notice-actions">
          {/* Focus starts on the safe choice, not on running the code. */}
          <button type="button" className="image-lightbox__tool image-lightbox__tool--labelled"
            autoFocus onClick={closeNotice}>
            Cancel
          </button>
          <button type="button" className="image-lightbox__svg-notice-run" disabled={noticeSaving}
            onClick={() => { void acceptNotice(); }}>
            Run scripts
          </button>
        </div>
      </div>
    ) : null}
  </>;
}
