import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  buildThreadIdentityKey,
  type CelestialIconId,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { CelestialIcon } from "../../icons";
import { PrChip } from "../pr-status/PrChip";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import {
  StarMapCardMenu,
  type StarMapCardMenuAction,
} from "./StarMapCardMenu";
import { ThreadMetaChips } from "../navigation/ThreadMetaChips";
import {
  getThreadRowStatus,
  ThreadRowStatus,
} from "../navigation/ThreadRowStatus";
import { pointerDeltaToCanvas, resolveCardDragOffset } from "./star-map-layout";
import type { AlignmentGuide } from "./star-map-snapping";
import {
  visiblePullRequests,
  type StarMapCardFields,
} from "./star-map-preferences";
import type { StarMapSessionKeys } from "./attention";

const DRAG_THRESHOLD_PX = 4;

/**
 * Compact attention card floating in an instance's lane. Mirrors the
 * thread-row anatomy (status cookie, title, meta chips, PR chips) a smidge
 * denser: project chips keep their meaning icons but drop the literal
 * "Local"/"Worktree" labels (linkedDirectoryMode="label"), and there is no
 * actions cluster.
 *
 * Positioned via left/top (never inline transform) so the rise/bubble
 * keyframes own the transform channel without snapping the card back to
 * its anchor origin mid-animation.
 */
export function StarMapThreadCard(props: {
  thread: NavigationThreadSummary;
  sessionKeys?: StarMapSessionKeys;
  entering?: boolean;
  /** Staggered rise-in offset so a cloud settles like a constellation. */
  riseDelayMs?: number;
  /** Default slot offset from the instance anchor, in px. */
  baseSlot: { dx: number; dy: number };
  /** Synced drag offset layered on top of the slot. */
  offset?: { dx: number; dy: number };
  /** Card width for this lane (dense federations narrow it). */
  width: number;
  /** Lane position, so dragged-into-overlap cards paint front-to-back. */
  stackIndex: number;
  /** Which chips this card carries (operator preference). */
  cardFields: StarMapCardFields;
  /** Orbit rings centre cards on their slot; lanes hang them from the top. */
  centered?: boolean;
  /** Owning instance's celestial mark, watermarked behind the content. */
  instanceIcon?: CelestialIconId;
  /**
   * Present when the card is draggable. Radius and commit travel together
   * so a draggable card cannot exist without the region it drags in.
   */
  drag?: {
    /**
     * Where drag resistance begins, measured from the INSTANCE BODY — one
     * region shared by the whole cloud (`cloudDetentRadius`), not a
     * per-card allowance, so any card can be placed where any other card
     * sits. Past it the drag is resisted, not stopped.
     */
    detentRadius: number;
    /**
     * Current canvas scale. Pointer deltas arrive in screen pixels but the
     * card is positioned in canvas pixels, so without this the card moves
     * `scale` times too far and slides out from under the cursor.
     */
    scale: number;
    /**
     * Snap a proposed offset against the rest of the arrangement. The
     * screen owns this because it is the only thing that knows where every
     * other card sits; the card would otherwise have to reconstruct the
     * whole map to align with one neighbour.
     */
    snap?: (offset: { dx: number; dy: number }) => {
      dx: number;
      dy: number;
      guides: AlignmentGuide[];
    };
    /** Guides to draw while this drag is live; empty clears them. */
    onGuidesChange?: (guides: AlignmentGuide[]) => void;
    /**
     * How far this drag has travelled, so the screen can carry the rest of
     * a multi-card selection along. Fired per frame during the drag and
     * once more on release, when the movement becomes durable.
     */
    onGroupDelta?: (delta: { dx: number; dy: number }) => void;
    onGroupCommit?: (delta: { dx: number; dy: number }) => void;
    onCommitOffset: (offset: { dx: number; dy: number }) => void;
  };
  /** `instanceId::threadKey`; unique across clouds. */
  cardKey: string;
  /** Part of a multi-card selection, so it moves with the others. */
  selected?: boolean;
  /**
   * Add or remove this card from the selection. Deliberately outside
   * `drag`: amending a selection has to work before the durable instance
   * id lands, which is the one thing that gates dragging.
   */
  onToggleSelect?: () => void;
  onOpen: (thread: NavigationThreadSummary) => void;
  /** Kebab entries; the kebab is hidden when empty. */
  menuActions?: StarMapCardMenuAction[];
  /**
   * Projects lens only: the sun is a project, so the machine is the thing
   * you cannot otherwise tell from the card's position.
   */
  showInstanceChip?: boolean;
}) {
  const thread = props.thread;
  const threadKey = buildThreadIdentityKey(thread.source, thread.id);
  const status = getThreadRowStatus(
    thread,
    props.sessionKeys?.thinkingThreadKeys,
  );
  // Set while a pointer-drag exceeded the threshold, so the click that the
  // browser fires on release does not also open the thread.
  const suppressClickRef = useRef(false);
  // Cards live inside the clipped, transformed canvas, and a native
  // `title` cannot be styled, times out differently per platform, and
  // does not wrap on macOS Electron — see UI-THEME.md.
  // Same layering problem the PR chip's card has: this tooltip portals to
  // document.body while the card that opened it lives inside the Star Map
  // layer (z-index 120, in the root stacking context), so the default
  // `.viewport-tooltip` layer of 90 paints underneath the map.
  const titleTooltip = useViewportTooltip({
    className: "viewport-tooltip star-map-card__tooltip",
  });
  const left = props.baseSlot.dx + (props.offset?.dx ?? 0);
  const top = props.baseSlot.dy + (props.offset?.dy ?? 0);
  const style: CSSProperties = {
    width: props.width,
    left,
    top,
    marginLeft: -props.width / 2,
    ...(props.centered ? { transform: "translateY(-50%)" } : {}),
    zIndex: props.stackIndex,
    ...(props.riseDelayMs
      ? { animationDelay: `${props.riseDelayMs}ms` }
      : {}),
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Modifier-click amends the selection rather than opening or dragging.
    // It is the platform convention, and the only way to correct a marquee
    // that swept up one card too many without starting the sweep over.
    // Gated on the handler so lenses with no selection (Projects) keep
    // modifier-click opening the thread instead of doing nothing at all.
    const toggleSelect = props.onToggleSelect;
    if (toggleSelect && (event.shiftKey || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      suppressClickRef.current = true;
      toggleSelect();
      return;
    }
    const drag = props.drag;
    if (!drag) return;
    const element = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffset = props.offset ?? { dx: 0, dy: 0 };
    let dragging = false;
    let lastDx = startOffset.dx;
    let lastDy = startOffset.dy;
    let frame = 0;
    const move = (pointerEvent: globalThis.PointerEvent) => {
      const screenX = pointerEvent.clientX - startX;
      const screenY = pointerEvent.clientY - startY;
      // The threshold is about human intent, so it stays in screen pixels;
      // only the movement itself converts into canvas space.
      if (
        !dragging
        && Math.hypot(screenX, screenY) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      dragging = true;
      suppressClickRef.current = true;
      const delta = pointerDeltaToCanvas({
        dx: screenX,
        dy: screenY,
        scale: drag.scale,
      });
      const resolved = resolveCardDragOffset({
        baseSlot: props.baseSlot,
        offset: {
          dx: startOffset.dx + delta.dx,
          dy: startOffset.dy + delta.dy,
        },
        detentRadius: drag.detentRadius,
      });
      const snapped = drag.snap ? drag.snap(resolved) : undefined;
      lastDx = snapped ? snapped.dx : resolved.dx;
      lastDy = snapped ? snapped.dy : resolved.dy;
      drag.onGuidesChange?.(snapped?.guides ?? []);
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          element.style.left = `${props.baseSlot.dx + lastDx}px`;
          element.style.top = `${props.baseSlot.dy + lastDy}px`;
          drag.onGroupDelta?.({
            dx: lastDx - startOffset.dx,
            dy: lastDy - startOffset.dy,
          });
        });
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      drag.onGuidesChange?.([]);
      if (dragging) {
        drag.onCommitOffset({ dx: lastDx, dy: lastDy });
        drag.onGroupCommit?.({
          dx: lastDx - startOffset.dx,
          dy: lastDy - startOffset.dy,
        });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return (
    // Shell owns position, drag and stacking so the card itself can stay a
    // plain container and every interactive part — the open-thread button,
    // the kebab, the chips — sits beside the others rather than nested
    // inside one another.
    <div
      className={`star-map-card-shell${
        props.entering ? " star-map-card-shell--entering" : ""
      }${props.selected ? " star-map-card-shell--selected" : ""}`}
      style={style}
      data-thread-key={threadKey}
      data-card-key={props.cardKey}
      onPointerDown={startDrag}
    >
      {/* Top-right, and large: the next card covers this one's bottom, so
          the mark has to live in the strip that stays visible. */}
      {props.instanceIcon ? (
        <span className="star-map-card__watermark" aria-hidden="true">
          <CelestialIcon icon={props.instanceIcon} size={104} />
        </span>
      ) : null}
      {props.menuActions && props.menuActions.length > 0 ? (
        <StarMapCardMenu actions={props.menuActions} threadTitle={thread.title} />
      ) : null}
      <div className="star-map-card">
        {/* The card's primary action. It carries the heading line and
            stretches over the whole card via `.star-map-card__open::after`
            (see app.css), but it stays a SIBLING of the chip flow for the
            same reason the kebab sits outside it: the chips own real
            buttons (copy path, copy branch, PR links), and a button inside
            a button is neither valid nor operable — axe reports it as
            `nested-interactive`. */}
        <button
          type="button"
          className="star-map-card__heading star-map-card__open"
          // Names the action rather than letting the button's whole content
          // become its accessible name; the chips stay readable as content,
          // and the kebab beside it gets a distinct name of its own.
          aria-label={`Open thread: ${thread.title}`}
          onClick={() => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            props.onOpen(thread);
          }}
        >
          <ThreadRowStatus status={status} />
          <span
            className="star-map-card__title"
            onMouseEnter={(event) =>
              titleTooltip.show(event.currentTarget, thread.title)
            }
            onMouseLeave={titleTooltip.hide}
          >
            {thread.title}
          </span>
        </button>
        <span className="star-map-card__chips">
          <ThreadMetaChips
            thread={thread}
            hasApprovalRequest={
              props.sessionKeys?.approvalRequestThreadKeys?.[threadKey] === true
            }
            hasInputRequest={
              props.sessionKeys?.inputRequestThreadKeys?.[threadKey] === true
            }
            includeLinkedDirectories={props.cardFields.primaryDirectory}
            linkedDirectoryMode="label"
            // In the instance lenses the lane and the watermark already say
            // which machine this is; under the projects lens they do not.
            hideInstanceChip={!props.showInstanceChip}
            hidePinChip
            chipVisibility={{
              provider: props.cardFields.provider,
              branch: props.cardFields.branch,
              maxLinkedDirectories: props.cardFields.secondaryDirectories
                ? undefined
                : 1,
            }}
          />
          {visiblePullRequests(thread.prs, props.cardFields).map((pr) => (
            <PrChip
              key={`${pr.org}/${pr.repo}#${pr.number}`}
              pr={pr}
              showRepoPrefix={false}
              onOpen={(url) => {
                if (typeof window !== "undefined") {
                  window.open(url, "_blank", "noopener,noreferrer");
                }
              }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
