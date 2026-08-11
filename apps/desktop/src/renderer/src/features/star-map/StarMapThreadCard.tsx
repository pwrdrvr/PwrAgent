import { type CSSProperties } from "react";
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
import {
  useStarMapCardDrag,
  type StarMapCardDrag,
} from "./useStarMapCardDrag";
import {
  visiblePullRequests,
  type StarMapCardFields,
} from "./star-map-preferences";
import type { StarMapSessionKeys } from "./attention";

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
  drag?: StarMapCardDrag;
  /** `instanceId::threadKey`; unique across clouds. */
  cardKey: string;
  /** Part of a multi-card selection, so it moves with the others. */
  selected?: boolean;
  /** This thread has a chat card open on the map, tethered to this card. */
  chatting?: boolean;
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
  // Thread keys carry a `backend:id` colon, which is legal in an id
  // attribute but parses as a pseudo-class in a CSS selector — anything
  // resolving this id via querySelector would silently find nothing.
  const chatStateId = `star-map-chat-open-${threadKey.replace(/[^\w-]/g, "-")}`;
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

  const { startDrag, consumeSuppressedClick } = useStarMapCardDrag({
    baseSlot: props.baseSlot,
    offset: props.offset,
    drag: props.drag,
    onToggleSelect: props.onToggleSelect,
  });

  return (
    // Shell owns position, drag and stacking so the card itself can stay a
    // plain container and every interactive part — the open-thread button,
    // the kebab, the chips — sits beside the others rather than nested
    // inside one another.
    <div
      className={`star-map-card-shell${
        props.entering ? " star-map-card-shell--entering" : ""
      }${props.selected ? " star-map-card-shell--selected" : ""}${
        props.chatting ? " star-map-card-shell--chatting" : ""
      }`}
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
          // The accent ring says "a chat card for this thread is open on
          // the map", which is otherwise sighted-only. It rides
          // `aria-describedby` rather than the label because it describes
          // the thread's state, not what the button does — the same rule
          // the hover cards follow (see AGENTS.md).
          aria-describedby={props.chatting ? chatStateId : undefined}
          onClick={() => {
            if (consumeSuppressedClick()) return;
            props.onOpen(thread);
          }}
        >
          {props.chatting ? (
            <span className="star-map-card__state" id={chatStateId}>
              Chat card open on the map
            </span>
          ) : null}
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
