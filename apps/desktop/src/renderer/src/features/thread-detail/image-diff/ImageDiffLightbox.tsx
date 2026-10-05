import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FitToWindowIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "../../../icons";
import { formatFileSize } from "../../../lib/format-bytes";
import { useModalDialog } from "../../../lib/useModalDialog";
import {
  tooltipHandlers,
  useViewportTooltip,
  ViewportTooltipProvider,
  type ViewportTooltip,
} from "../../../lib/useViewportTooltip";
import { ImageCopyButton } from "../ImageCopyButton";
import { useLightboxGestures } from "../useLightboxGestures";
import {
  buildSequence,
  formatExtent,
  indexOfStop,
  itemsForSides,
  planDiff,
  referenceExtent,
  resolvedSides,
  stepFile,
  stepStop,
  type Extent,
  type ImageDiffEntry,
  type ImageDiffItem,
  type ImageDiffStop,
  type ImageSideKey,
} from "./image-diff-model";
import { sideLabel, sideNote, type ImageDiffController } from "./ImageDiffPreview";
import { sideResolution, useImageSide } from "./image-preview-store";
import { usePixelDiff } from "./usePixelDiff";

/** How far a press may travel and still count as a click rather than a drag. */
const DISMISS_SLOP = 4;
/** How far "fit" enlarges a picture smaller than the window. */
const MAX_FIT_SCALE = 8;

function isPointerClick(start: { x: number; y: number } | null, event: ReactMouseEvent): boolean {
  if (!start || event.detail === 0) return false;
  return Math.abs(event.clientX - start.x) <= DISMISS_SLOP
    && Math.abs(event.clientY - start.y) <= DISMISS_SLOP;
}

function itemLabel(item: ImageDiffItem, sides: readonly ImageSideKey[]): string {
  return item === "diff" ? "Diff" : sideLabel(item, sides);
}

function basename(repoPath: string): string {
  return repoPath.split("/").pop() ?? repoPath;
}

/**
 * The Edits rail's image viewer: every image file's Before, After and a pixel
 * Diff of the two, in the shipped lightbox's chrome (`ImageLightbox` — same
 * scrim, close cookie, edge controls and bottom cluster, and the same rule
 * that nothing rides the top-left, where macOS draws the stoplights).
 *
 * What it adds is one view shared by a file's three items. Two pictures side
 * by side answer "did anything change"; flipping between them on the same
 * pixels at the same magnification answers "what". So switching item moves
 * nothing — the per-file view is keyed by the file, not the item, and only a
 * different file refits.
 *
 * The arrows walk one flat sequence over every image in the panel, and stop
 * at both ends instead of wrapping: knowing you have reached the end is the
 * point of walking a diff.
 */
export function ImageDiffLightbox({
  entries,
  controller,
  initialStop,
  onClose,
}: {
  /** Every image row in the panel, in the order the rail lists them. */
  entries: readonly ImageDiffEntry[];
  controller: ImageDiffController;
  initialStop: ImageDiffStop;
  onClose: () => void;
}) {
  const { store, generation } = controller;
  const dialogRef = useModalDialog<HTMLDivElement>({ onClose, initialFocus: "dialog" });
  const press = useRef<{ x: number; y: number; scrim: boolean } | null>(null);
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const [stop, setStop] = useState(initialStop);
  // Bumped as previews resolve, so a file that turns out to be an add drops
  // its Before from the walk. The store itself is not React state.
  const [resolved, setResolved] = useState(0);

  const sidesOf = useCallback(
    (entry: ImageDiffEntry) =>
      resolvedSides(entry, (side) => sideResolution(store.peek(entry, side))),
    [store],
  );
  const sequence = useMemo(
    () => buildSequence(entries, sidesOf),
    // `resolved` and `generation` are the store changing under `sidesOf`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, sidesOf, resolved, generation],
  );
  // The file on screen left the panel — committed, reverted, or the thread
  // moved on. Close rather than land on whichever file happens to be first.
  const present = entries.some((candidate) => candidate.key === stop.entryKey);
  useEffect(() => {
    if (!present) onClose();
  }, [onClose, present]);
  const position = indexOfStop(sequence, stop);
  const current = sequence[position];
  const entryIndex = entries.findIndex((entry) => entry.key === current?.entryKey);
  const entry = entries[entryIndex];

  // This file and its neighbours, so a step lands on a picture rather than a
  // spinner, and so an add's missing Before is known before the walk gets there.
  useEffect(() => {
    let active = true;
    for (const neighbour of entries.slice(Math.max(0, entryIndex - 1), entryIndex + 2)) {
      for (const side of neighbour.sides ?? (["before", "after"] as const)) {
        void store.load(neighbour, side).then(() => {
          if (active) setResolved((count) => count + 1);
        });
      }
    }
    return () => {
      active = false;
    };
  }, [entries, entryIndex, store, generation]);

  const moveTo = useCallback((index: number) => {
    const target = sequence[index];
    if (!target) return;
    // A new file remounts its view, taking a focused zoom control with it;
    // the trap would then pull focus onto some control in the new view and
    // raise its tooltip mid-walk. The frame is where focus started.
    const dialog = dialogRef.current;
    if (target.entryKey !== current?.entryKey
      && dialog && document.activeElement !== dialog
      && dialog.contains(document.activeElement)) {
      dialog.focus({ preventScroll: true });
    }
    setStop(target);
  }, [current?.entryKey, dialogRef, sequence]);

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
      // The focused viewport owns the arrows for panning, as in ImageLightbox.
      if (event.target instanceof HTMLElement && event.target.matches(".image-lightbox__viewport")) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      event.stopPropagation();
      event.preventDefault();
      const by = event.key === "ArrowLeft" ? -1 : 1;
      moveTo(event.shiftKey ? stepFile(sequence, position, by) : stepStop(sequence, position, by));
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [moveTo, position, sequence]);

  if (typeof document === "undefined" || !present || !entry || !current) {
    return null;
  }
  const sides = sidesOf(entry);
  const gallery = sequence.length > 1;
  const atStart = position === 0;
  const atEnd = position >= sequence.length - 1;
  const label = itemLabel(current.item, sides);

  return createPortal(
    <ViewportTooltipProvider value={tooltip}>
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="image-lightbox image-diff-lightbox"
      data-gallery={gallery}
      data-meta="true"
      onPointerDownCapture={(event) => {
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
      aria-label={`Image changes: ${entry.repoPath}`}
      onClick={(event) => {
        const start = press.current;
        press.current = null;
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
      {/* Mounted once, outside the keyed file view: a live region only
          announces changes to a region that was already there. */}
      <span className="image-viewer__status" role="status" aria-live="polite">
        {`${label}, ${basename(entry.repoPath)}, ${position + 1} of ${sequence.length}`}
      </span>
      <ImageDiffFileView
        key={entry.key}
        entry={entry}
        item={current.item}
        sides={sides}
        controller={controller}
        position={position + 1}
        total={sequence.length}
        tooltip={tooltip}
        onItem={(item) => moveTo(indexOfStop(sequence, { entryKey: entry.key, item }))}
      />
      {gallery ? (
        <button
          type="button"
          className="image-lightbox__nav image-lightbox__nav--previous"
          aria-label="Previous"
          aria-disabled={atStart}
          {...tooltipHandlers(tooltip, "Previous (Left Arrow, Shift for previous file)")}
          onClick={(event) => {
            event.stopPropagation();
            if (!atStart) moveTo(stepStop(sequence, position, -1));
          }}
        >
          <ChevronLeftIcon size={22} aria-hidden="true" />
        </button>
      ) : null}
      {gallery ? (
        <button
          type="button"
          className="image-lightbox__nav image-lightbox__nav--next"
          aria-label="Next"
          aria-disabled={atEnd}
          {...tooltipHandlers(tooltip, "Next (Right Arrow, Shift for next file)")}
          onClick={(event) => {
            event.stopPropagation();
            if (!atEnd) moveTo(stepStop(sequence, position, 1));
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

/** One file's viewport and bottom cluster. Keyed by the file, so the view is
 *  shared by its Before, After and Diff and refits only for another file. */
function ImageDiffFileView({ entry, item, sides, controller, position, total, tooltip, onItem }: {
  entry: ImageDiffEntry;
  item: ImageDiffItem;
  sides: ImageSideKey[];
  controller: ImageDiffController;
  position: number;
  total: number;
  tooltip: ViewportTooltip;
  onItem: (item: ImageDiffItem) => void;
}) {
  const gestures = useLightboxGestures({ maxFitScale: MAX_FIT_SCALE });
  const { setNaturalSize } = gestures;
  const before = useImageSide({
    store: controller.store,
    entry,
    side: "before",
    enabled: sides.includes("before"),
    generation: controller.generation,
  });
  const after = useImageSide({
    store: controller.store,
    entry,
    side: "after",
    enabled: sides.includes("after"),
    generation: controller.generation,
  });
  const states = { before, after };
  // The store measures each picture as it arrives; this is the fallback for a
  // runtime where that decode failed, from the `<img>` itself.
  const [measured, setMeasured] = useState<Partial<Record<ImageSideKey, Extent>>>({});
  const extentOf = (side: ImageSideKey): Extent | undefined => {
    const state = states[side];
    if (state.kind !== "image" || !sides.includes(side)) return undefined;
    return state.extent ?? measured[side];
  };
  const beforeExtent = extentOf("before");
  const afterExtent = extentOf("after");
  const reference = referenceExtent([beforeExtent, afterExtent]);
  useEffect(() => {
    if (reference) setNaturalSize(reference.w, reference.h);
  }, [reference?.w, reference?.h, setNaturalSize]); // eslint-disable-line react-hooks/exhaustive-deps -- the extent object is rebuilt every render

  // null until the operator disagrees with what the shapes imply.
  const [stretch, setStretch] = useState<boolean>();
  const plan = beforeExtent && afterExtent ? planDiff(beforeExtent, afterExtent, stretch) : undefined;
  // Latched: a retina comparison costs a few hundred milliseconds, and
  // Before → Diff → After → Diff is exactly what this viewer is for.
  const [diffRequested, setDiffRequested] = useState(item === "diff");
  useEffect(() => {
    if (item === "diff") setDiffRequested(true);
  }, [item]);
  const diff = usePixelDiff({
    enabled: diffRequested,
    before: before.kind === "image" ? before.blob : undefined,
    after: after.kind === "image" ? after.blob : undefined,
    plan,
  });

  const items = itemsForSides(sides);
  const shown = item === "diff" ? undefined : states[item];
  const fills = !plan || plan.fit === "stretch";
  const layerStyle = (extent: Extent | undefined) =>
    fills || !extent || !reference
      ? undefined
      : { width: `${(extent.w / reference.w) * 100}%`, height: `${(extent.h / reference.h) * 100}%` };
  const copySrc = item === "diff"
    ? (diff.kind === "ready" ? diff.url : undefined)
    : (shown?.kind === "image" ? shown.url : undefined);

  // A side that settled without a picture (too large, an LFS pointer, an
  // unreadable blob) means there is no plan and never will be; say which.
  const blocker = (["before", "after"] as const).find((side) => {
    const state = states[side];
    return state.kind !== "image" && state.kind !== "loading";
  });
  const noCompare = blocker
    ? `Nothing to compare. ${sideLabel(blocker, sides)}: ${sideNote(states[blocker])}`
    : undefined;

  let overlay: string | undefined;
  if (item === "diff") {
    if (noCompare) overlay = noCompare;
    else if (diff.kind === "working" || (diff.kind === "idle" && !plan)) overlay = "Comparing…";
    else if (diff.kind === "failed") overlay = `Couldn’t compare: ${diff.reason}`;
  } else if (shown && shown.kind !== "image") {
    overlay = sideNote(shown);
  }

  let detail: string;
  if (item === "diff") {
    detail = diff.kind === "ready"
      ? `${((diff.changed / diff.total) * 100).toFixed(2)}% changed · ${diff.changed.toLocaleString()} px`
      : noCompare ? "Nothing to compare"
      : diff.kind === "failed" ? "Couldn’t compare" : "Comparing…";
    if (plan?.mismatch) {
      detail += ` · sizes differ: ${formatExtent(plan.mismatch.before)} vs ${formatExtent(plan.mismatch.after)}`;
    }
  } else if (shown?.kind === "image") {
    const extent = extentOf(item);
    detail = [extent ? formatExtent(extent) : undefined, formatFileSize(shown.bytes)]
      .filter(Boolean)
      .join(" · ");
  } else {
    detail = shown ? sideNote(shown) : "";
  }
  const atActual = gestures.percent === 100;

  return <>
    <div ref={gestures.viewport}
      className="image-lightbox__viewport"
      tabIndex={0}
      aria-label="Image pan and zoom"
      onKeyDown={gestures.onKeyDown}
      onFocus={(event) => tooltip.show(event.currentTarget, "Use arrow keys to pan")}
      onBlur={tooltip.hide}>
      {reference && gestures.imageStyle ? (
        <div
          className="image-lightbox__image image-diff-lightbox__canvas"
          data-panning={gestures.panning}
          data-pixelated={gestures.percent > 200}
          style={gestures.imageStyle}
          {...gestures.imageHandlers}
          onDoubleClick={() => {
            if (gestures.atFit && gestures.percent > 0 && !atActual) gestures.zoom(100 / gestures.percent);
            else gestures.reset();
          }}
        >
          {/* Both revisions stay mounted and only the inactive one is
              hidden: switching is then instant instead of a re-decode, and
              the Diff tab never waits on a side nobody has looked at. */}
          {(["before", "after"] as const).map((side) => {
            const state = states[side];
            if (state.kind !== "image" || !sides.includes(side)) return null;
            return (
              <img key={side}
                className="image-diff-lightbox__layer"
                data-active={item === side}
                src={state.url}
                alt={item === side ? `${entry.repoPath}, ${sideLabel(side, sides).toLowerCase()}` : ""}
                aria-hidden={item === side ? undefined : true}
                draggable={false}
                style={layerStyle(extentOf(side))}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  if (state.extent || image.naturalWidth === 0) return;
                  setMeasured((previous) => ({ ...previous, [side]: { w: image.naturalWidth, h: image.naturalHeight } }));
                }} />
            );
          })}
          {diff.kind === "ready" ? (
            <img className="image-diff-lightbox__layer"
              data-active={item === "diff"}
              src={diff.url}
              alt={item === "diff" ? `${entry.repoPath}, pixel diff` : ""}
              aria-hidden={item === "diff" ? undefined : true}
              draggable={false} />
          ) : null}
        </div>
      ) : (["before", "after"] as const).map((side) => {
        // No size yet means the store could not measure, and the canvas needs
        // one to exist. A hidden `<img>` still loads, and reports it.
        const state = states[side];
        if (state.kind !== "image" || !sides.includes(side)) return null;
        return (
          <img key={side} className="image-diff-lightbox__probe" src={state.url} alt="" hidden
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth === 0) return;
              setMeasured((previous) => ({ ...previous, [side]: { w: image.naturalWidth, h: image.naturalHeight } }));
            }} />
        );
      })}
      {overlay || !reference ? (
        <p className="image-diff-lightbox__note">{overlay ?? sideNote({ kind: "loading" })}</p>
      ) : null}
    </div>
    <div className="image-lightbox__chrome">
      <p className="image-lightbox__meta">
        {total > 1 ? (
          <span className="image-lightbox__position">
            <b>{position}</b> / {total}
          </span>
        ) : null}
        <span className="image-lightbox__caption" {...tooltipHandlers(tooltip, `${entry.repoPath} · ${entry.context}`)}>
          {entry.repoPath}
        </span>
        <span className="image-diff-lightbox__detail">{detail}</span>
        {item === "diff" && diff.kind === "ready" ? (
          <span className="image-diff-lightbox__legend">
            <span className="image-diff-lightbox__swatch" data-kind="changed" aria-hidden="true" />
            changed
            <span className="image-diff-lightbox__swatch" data-kind="aa" aria-hidden="true" />
            anti-aliased
          </span>
        ) : null}
      </p>
      <div className="image-lightbox__toolbar">
        {items.length > 1 ? <>
          <div className="image-diff-lightbox__items" role="group" aria-label="Revision">
            {items.map((kind) => (
              <button type="button" key={kind}
                className="image-diff-lightbox__item"
                aria-pressed={kind === item}
                onClick={() => onItem(kind)}>
                {itemLabel(kind, sides)}
              </button>
            ))}
          </div>
          <span className="image-lightbox__tool-divider" aria-hidden="true" />
        </> : (
          <span className="image-diff-lightbox__single">{itemLabel(item, sides)}</span>
        )}
        <button type="button" className="image-lightbox__tool" aria-label="Zoom out"
          aria-disabled={gestures.view.scale <= 0.1}
          onClick={() => { if (gestures.view.scale > 0.1) gestures.zoom(1 / 1.5); }}
          {...tooltipHandlers(tooltip, "Zoom out")}>
          <ZoomOutIcon size={16} aria-hidden="true" />
        </button>
        <span className="image-lightbox__zoom">{gestures.percent > 0 ? `${gestures.percent}%` : "—"}</span>
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
        {item === "diff" && plan?.mismatch && plan.canStretch ? <>
          <span className="image-lightbox__tool-divider" aria-hidden="true" />
          <button type="button" className="image-lightbox__tool image-lightbox__tool--labelled image-diff-lightbox__stretch"
            aria-pressed={plan.fit === "stretch"}
            onClick={() => setStretch(plan.fit !== "stretch")}
            {...tooltipHandlers(tooltip, "Scale the smaller revision up to the larger before comparing")}>
            Scale to match
          </button>
        </> : null}
        {copySrc ? <>
          <span className="image-lightbox__tool-divider" aria-hidden="true" />
          <ImageCopyButton src={copySrc} appearance="pill" />
        </> : null}
      </div>
    </div>
  </>;
}
