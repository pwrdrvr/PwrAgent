import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  buildThreadIdentityKey,
  type CelestialIconId,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { CelestialIcon } from "../../icons";
import { PrChip } from "../pr-status/PrChip";
import {
  StarMapCardMenu,
  type StarMapCardMenuAction,
} from "./StarMapCardMenu";
import { ThreadMetaChips } from "../navigation/ThreadMetaChips";
import {
  getThreadRowStatus,
  ThreadRowStatus,
} from "../navigation/ThreadRowStatus";
import { clampToCloudRadius, STAR_MAP_CLOUD_RADIUS } from "./star-map-layout";
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
  /** Present when the card is draggable; receives the clamped offset. */
  onCommitOffset?: (offset: { dx: number; dy: number }) => void;
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
    // Shell owns position, drag and stacking so the card itself can stay a
    // plain container and every interactive part — the open-thread button,
    // the kebab, the chips — sits beside the others rather than nested
    // inside one another.
    <div
      className={`star-map-card-shell${
        props.entering ? " star-map-card-shell--entering" : ""
      }`}
      style={style}
      data-thread-key={threadKey}
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
          <span className="star-map-card__title" title={thread.title}>
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
