import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  buildThreadIdentityKey,
  type CelestialIconId,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { CelestialIcon } from "../../icons";
import { PrChip } from "../pr-status/PrChip";
import { ThreadMetaChips } from "../navigation/ThreadMetaChips";
import {
  getThreadRowStatus,
  ThreadRowStatus,
} from "../navigation/ThreadRowStatus";
import { clampToCloudRadius, STAR_MAP_CLOUD_RADIUS } from "./star-map-layout";
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
  /** Owning instance's celestial mark, watermarked behind the content. */
  instanceIcon?: CelestialIconId;
  /** Present when the card is draggable; receives the clamped offset. */
  onCommitOffset?: (offset: { dx: number; dy: number }) => void;
  onOpen: (thread: NavigationThreadSummary) => void;
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
  const left = props.baseSlot.dx + (props.offset?.dx ?? 0);
  const top = props.baseSlot.dy + (props.offset?.dy ?? 0);
  const style: CSSProperties = {
    width: props.width,
    left,
    top,
    marginLeft: -props.width / 2,
    zIndex: props.stackIndex,
    ...(props.riseDelayMs
      ? { animationDelay: `${props.riseDelayMs}ms` }
      : {}),
  };

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!props.onCommitOffset || event.button !== 0) return;
    const element = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffset = props.offset ?? { dx: 0, dy: 0 };
    let dragging = false;
    let lastDx = startOffset.dx;
    let lastDy = startOffset.dy;
    let frame = 0;
    const move = (pointerEvent: globalThis.PointerEvent) => {
      const deltaX = pointerEvent.clientX - startX;
      const deltaY = pointerEvent.clientY - startY;
      if (
        !dragging
        && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      dragging = true;
      suppressClickRef.current = true;
      const clamped = clampToCloudRadius(
        startOffset.dx + deltaX,
        startOffset.dy + deltaY,
        STAR_MAP_CLOUD_RADIUS,
      );
      lastDx = clamped.dx;
      lastDy = clamped.dy;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          element.style.left = `${props.baseSlot.dx + lastDx}px`;
          element.style.top = `${props.baseSlot.dy + lastDy}px`;
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
      if (dragging) {
        props.onCommitOffset?.({ dx: lastDx, dy: lastDy });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return (
    <button
      type="button"
      className={`star-map-card${props.entering ? " star-map-card--entering" : ""}`}
      style={style}
      data-thread-key={threadKey}
      onPointerDown={startDrag}
      onClick={() => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        props.onOpen(thread);
      }}
    >
      {/* Top-right, and large: the next card covers this one's bottom, so
          the mark has to live in the strip that stays visible. */}
      {props.instanceIcon ? (
        <span className="star-map-card__watermark" aria-hidden="true">
          <CelestialIcon icon={props.instanceIcon} size={104} />
        </span>
      ) : null}
      <span className="star-map-card__heading">
        <ThreadRowStatus status={status} />
        <span className="star-map-card__title" title={thread.title}>
          {thread.title}
        </span>
      </span>
      <span className="star-map-card__chips">
        <ThreadMetaChips
          thread={thread}
          hasApprovalRequest={
            props.sessionKeys?.approvalRequestThreadKeys?.[threadKey] === true
          }
          hasInputRequest={
            props.sessionKeys?.inputRequestThreadKeys?.[threadKey] === true
          }
          includeLinkedDirectories
          linkedDirectoryMode="label"
          // The lane and the watermark already say which machine this is.
          hideInstanceChip
        />
        {thread.prs?.map((pr) => (
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
    </button>
  );
}
