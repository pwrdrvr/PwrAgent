import { memo, useMemo, type CSSProperties } from "react";
import { useEventCallback } from "../../lib/useEventCallback";
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
  isThreadRemoteWorkHere,
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
import type { AlignmentGuide } from "./star-map-snapping";

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
type StarMapThreadCardProps = {
  thread: NavigationThreadSummary;
  sessionKeys?: StarMapSessionKeys;
  /**
   * Separate from `sessionKeys` on purpose: the caller withholds those from
   * remote cards because thinking/approval keys come from an unscoped event
   * stream. A draft is this window's own composer state, so it is just as
   * true of a peer's thread as of a local one.
   */
  hasUnsentDraft?: boolean;
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
   * The operator just picked this card out of the ⌘K palette and the camera
   * flew here. Wears a brief ring: the flight centres the card, and the
   * middle of the window is not something the eye picks out of a field of
   * identical cards on its own.
   */
  located?: boolean;
  /**
   * An Agent is pointing at this card, usually while it asks the operator
   * to confirm a change to it. A steady ring rather than `located`'s pulse,
   * because it lasts as long as the question does.
   */
  highlighted?: boolean;
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
};

/**
 * The screen rebuilds geometry and card-specific closures on live updates.
 * Keep the interaction closures current after commit, while the content
 * boundary compares the values that actually change a card's appearance.
 */
export function StarMapThreadCard(props: StarMapThreadCardProps) {
  const currentProps = useEventCallback(() => props);
  const handlers = useMemo(() => ({
    onOpen: (thread: NavigationThreadSummary) => currentProps().onOpen(thread),
    onToggleSelect: () => currentProps().onToggleSelect?.(),
    onMenuSelect: (key: string) =>
      currentProps().menuActions?.find((action) => action.key === key)?.onSelect(),
    snap: (offset: { dx: number; dy: number }) =>
      currentProps().drag?.snap?.(offset) ?? { ...offset, guides: [] },
    onGuidesChange: (guides: AlignmentGuide[]) =>
      currentProps().drag?.onGuidesChange?.(guides),
    onGroupDelta: (delta: { dx: number; dy: number }) =>
      currentProps().drag?.onGroupDelta?.(delta),
    onGroupCommit: (delta: { dx: number; dy: number }) =>
      currentProps().drag?.onGroupCommit?.(delta),
    onCommitOffset: (offset: { dx: number; dy: number }) =>
      currentProps().drag?.onCommitOffset(offset),
  }), [currentProps]);

  return (
    <StarMapThreadCardContent
      {...props}
      onOpen={handlers.onOpen}
      onToggleSelect={props.onToggleSelect ? handlers.onToggleSelect : undefined}
      menuActions={props.menuActions?.map((action) => ({
        ...action,
        onSelect: () => handlers.onMenuSelect(action.key),
      }))}
      drag={props.drag ? {
        ...props.drag,
        snap: props.drag.snap ? handlers.snap : undefined,
        onGuidesChange: props.drag.onGuidesChange ? handlers.onGuidesChange : undefined,
        onGroupDelta: props.drag.onGroupDelta ? handlers.onGroupDelta : undefined,
        onGroupCommit: props.drag.onGroupCommit ? handlers.onGroupCommit : undefined,
        onCommitOffset: handlers.onCommitOffset,
      } : undefined}
    />
  );
}

function samePoint(
  previous: { dx: number; dy: number } | undefined,
  next: { dx: number; dy: number } | undefined,
): boolean {
  return (previous?.dx ?? 0) === (next?.dx ?? 0)
    && (previous?.dy ?? 0) === (next?.dy ?? 0);
}

function sameCardProps(
  previous: StarMapThreadCardProps,
  next: StarMapThreadCardProps,
): boolean {
  const {
    baseSlot: previousSlot,
    offset: previousOffset,
    cardFields: previousFields,
    drag: previousDrag,
    menuActions: previousActions,
    ...previousRest
  } = previous;
  const {
    baseSlot: nextSlot,
    offset: nextOffset,
    cardFields: nextFields,
    drag: nextDrag,
    menuActions: nextActions,
    ...nextRest
  } = next;
  if (!samePoint(previousSlot, nextSlot) || !samePoint(previousOffset, nextOffset)) return false;
  for (const key of Object.keys(previousFields) as (keyof StarMapCardFields)[]) {
    if (previousFields[key] !== nextFields[key]) return false;
  }
  if (Boolean(previousDrag) !== Boolean(nextDrag)) return false;
  if (previousDrag && nextDrag) {
    for (const key of Object.keys(previousDrag) as (keyof StarMapCardDrag)[]) {
      if (previousDrag[key] !== nextDrag[key]) return false;
    }
  }
  if ((previousActions?.length ?? 0) !== (nextActions?.length ?? 0)) return false;
  for (let index = 0; index < (previousActions?.length ?? 0); index += 1) {
    const previousAction = previousActions![index];
    const nextAction = nextActions![index];
    // onSelect is a key-based proxy to the latest committed action, so its
    // allocation does not change what the menu displays or invokes.
    if (previousAction.key !== nextAction.key
      || previousAction.label !== nextAction.label
      || previousAction.disabled !== nextAction.disabled
      || previousAction.danger !== nextAction.danger) return false;
  }
  const keys = Object.keys(previousRest) as (keyof typeof previousRest)[];
  return keys.length === Object.keys(nextRest).length
    && keys.every((key) => previousRest[key] === nextRest[key]);
}

const StarMapThreadCardContent = memo(function StarMapThreadCardContent(
  props: StarMapThreadCardProps,
) {
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
      }${props.located ? " star-map-card-shell--located" : ""}${
        props.highlighted ? " star-map-card-shell--highlighted" : ""
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
          <ThreadRowStatus
            remoteWork={isThreadRemoteWorkHere(thread)}
            status={status}
          />
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
            hasUnsentDraft={props.hasUnsentDraft}
            includeLinkedDirectories={props.cardFields.primaryDirectory}
            linkedDirectoryMode="label"
            // In the instance lenses the lane and the watermark already say
            // which machine this is; under the projects lens they do not.
            hideInstanceChip={!props.showInstanceChip}
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
}, sameCardProps);
