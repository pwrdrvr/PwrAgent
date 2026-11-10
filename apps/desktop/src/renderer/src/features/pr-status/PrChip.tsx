import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { PrSummary } from "@pwragent/shared";
import { CloseIcon, EyeIcon } from "../../icons";
import { copyText } from "../../lib/copy-text";
import { sidebarPrCardBridge, type BridgedHoverCard } from "../../lib/hover-card-bridge";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { observeElementVisibility } from "../../lib/observe-element-visibility";
import { statusPulseRef } from "../../lib/status-pulse";
import type { PrChipWatch } from "../pr-watches/useThreadPrWatchIndicators";
import { PrChipContextMenu } from "./PrChipContextMenu";
import type { PrBranchDrift } from "./pr-branch-drift";
import {
  prChipModifierClasses,
  prStatusLabel,
  resolvePrChipPresentation,
} from "./pr-chip-state";
import { PrStatusCard } from "./PrStatusCard";
import { prNumberLabel } from "./pr-rollup";

type PrChipProps = {
  pr: PrSummary;
  /** Render the org/repo prefix when the PR needs repository context. */
  showRepoPrefix: boolean;
  /**
   * Set when the chip is rendered next to explicit status pills (the Pull
   * Requests card). The chip then DEFERS draft + merge-conflict to those
   * pills: the dot stays mirrored to the check state — so it agrees with the
   * sibling "Checks …" pill instead of competing with it — and the draft bar
   * is dropped. Standalone chips (sidebar rows) leave this off and surface
   * draft / conflict on the chip itself, since there are no pills there.
   */
  withStatusPills?: boolean;
  /**
   * The thread branch's base drift, when this is the PR on that branch. The
   * card shows it as its Local branch section.
   */
  branchDrift?: PrBranchDrift;
  /**
   * What wakes this chip's thread for the PR. A CI watch draws the eye; the
   * card lists every kind. Keep its identity stable for unchanged data, or the
   * memo stops bailing out.
   */
  watch?: PrChipWatch;
  onOpen: (url: string) => void;
  onOpenContextMenu?: (
    pr: PrSummary,
    position: { x: number; y: number; anchorTop?: number },
  ) => void;
  onDetach?: (pr: PrSummary) => void;
  /**
   * Keeps Delete and the menu's Detach but draws no ✕. Minimal's title line
   * has no room for it.
   */
  hideDetachButton?: boolean;
  /**
   * The sidebar's card: it opens beside the sidebar, the pointer can cross
   * into it (`sidebarPrCardBridge`), and its footer offers Copy URL and
   * Detach.
   */
  cardActions?: boolean;
  onVisibilityChange?: (visible: boolean) => void;
};

/** The sidebar, so the card opens past its edge rather than over the rows. */
function sidebarAnchorRect(target: HTMLElement): DOMRect {
  return (target.closest(".sidebar") ?? target).getBoundingClientRect();
}

/**
 * Whether the card sits clear of the sidebar, where the pointer can reach it
 * without crossing other rows. A card that fell back over the rows (a narrow
 * window) does not qualify, and neither does one with no laid-out box.
 */
function cardIsBesideSidebar(card: Element | null, target: HTMLElement): boolean {
  const sidebar = target.closest(".sidebar");
  if (!card || !sidebar) return false;
  const box = card.getBoundingClientRect();
  const edges = sidebar.getBoundingClientRect();
  return box.width > 0 && (box.left >= edges.right || box.right <= edges.left);
}

export const PrChip = memo(function PrChip(props: PrChipProps) {
  const { pr } = props;
  const contextMenuInvokerRef = useRef<HTMLSpanElement>(null);
  const onVisibilityChange = props.onVisibilityChange;
  useEffect(() => {
    const element = contextMenuInvokerRef.current;
    if (element && onVisibilityChange) {
      return observeElementVisibility(element, onVisibilityChange);
    }
  }, [onVisibilityChange]);
  const [contextMenuPosition, setContextMenuPosition] = useState<{
    x: number;
    y: number;
    anchorTop?: number;
  }>();
  const cardActions = Boolean(props.cardActions);
  const tooltipController = useViewportTooltip(cardActions
    ? {
      className: "pr-status-card pr-status-card--actions",
      placement: "beside",
      getAnchorRect: sidebarAnchorRect,
      interactive: {
        onPointerEnter: () => sidebarPrCardBridge.enterCard(bridgeCardRef.current),
        onPointerLeave: () => sidebarPrCardBridge.leaveCard(bridgeCardRef.current),
      },
    }
    : { className: "pr-status-card" });
  const hideTooltip = tooltipController.hide;
  // This chip's card, as the shared bridge knows it.
  const bridgeCardRef = useRef<BridgedHoverCard>({ hide: hideTooltip });
  bridgeCardRef.current.hide = hideTooltip;
  const updateTooltip = tooltipController.update;
  const label = prNumberLabel(pr, props.showRepoPrefix);
  const presentation = resolvePrChipPresentation(pr, {
    withStatusPills: props.withStatusPills,
  });
  const chipState = presentation.chipState;
  const status = prStatusLabel(pr);
  // Creating this element is not rendering it: it stays an inert object until
  // `show` hands it to the portal on hover/focus, so a sidebar full of chips
  // mounts exactly zero cards.
  // Only a supplied menu can stop a watch; the standalone menu copies.
  const watchStopHint = Boolean(props.onOpenContextMenu);
  const onDetach = props.onDetach;
  const card = (
    <>
      <PrStatusCard
        pr={pr}
        withStatusPills={props.withStatusPills}
        branchDrift={props.branchDrift}
        watch={props.watch}
        watchStopHint={watchStopHint}
      />
      {/* Pointer shortcuts, out of the Tab order like the chip's ✕: the
          keyboard detaches with Delete on the chip, and copies from its
          menu. */}
      {cardActions ? (
        <div className="pr-status-card__actions">
          <button
            type="button"
            tabIndex={-1}
            className="pr-status-card__action"
            onClick={() => {
              hideTooltip();
              void copyText(pr.url);
            }}
          >
            Copy URL
          </button>
          {onDetach ? (
            <button
              type="button"
              tabIndex={-1}
              className="pr-status-card__action pr-status-card__action--detach"
              onClick={() => {
                hideTooltip();
                onDetach(pr);
              }}
            >
              Detach
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
  const latestCardRef = useRef(card);
  latestCardRef.current = card;
  const tooltipVisible = tooltipController.visible;

  // Status updates keep arriving while the pointer rests on a chip, so push
  // fresh numbers into an already-open card instead of freezing it at
  // hover-time values (same behavior the context-window card has).
  //
  // The guard is not optional: a React element is a new object on every render,
  // so feeding one straight into `update` would set state on every render that
  // very update caused. Compare the card's DATA and push only when it moved.
  // Tracking the key while hidden (rather than skipping the effect entirely)
  // is what keeps a hidden chip from pushing stale-keyed content on its next
  // hover — the delayed callback reads `latestCardRef` when it expires, while
  // immediate focus hands over the freshly built card directly.
  const cardKey = [
    pr.org,
    pr.repo,
    pr.number,
    pr.title,
    pr.headRefName,
    status,
    chipState,
    props.withStatusPills,
    pr.additions,
    pr.deletions,
    pr.changedFiles,
    pr.commitCount,
    pr.createdAt,
    pr.mergedAt,
    pr.closedAt,
    props.branchDrift?.baseBranch,
    props.branchDrift?.behind,
    props.branchDrift?.ahead,
    props.watch?.ci?.runAttempt,
    props.watch?.ci?.notifyOn.join(","),
    Boolean(props.watch?.ci),
    Boolean(props.watch?.terminal),
    Boolean(props.watch?.autoFix),
    props.watch?.autoFixBlocked?.reason,
    props.watch?.autoFixBlocked?.reason === "handled_by_other_thread"
      ? props.watch.autoFixBlocked.threadTitle
      : undefined,
    watchStopHint,
    cardActions,
    Boolean(onDetach),
  ].join("|");
  const pushedCardKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const moved = pushedCardKeyRef.current !== cardKey;
    pushedCardKeyRef.current = cardKey;
    if (!moved || !tooltipVisible) {
      return;
    }
    updateTooltip(latestCardRef.current);
  }, [cardKey, tooltipVisible, updateTooltip]);

  // The bridge tracks which sidebar card is up, so entering another chip can
  // close this one at once.
  useEffect(() => {
    if (!cardActions) return;
    const bridgeCard = bridgeCardRef.current;
    if (tooltipVisible) {
      sidebarPrCardBridge.shown(bridgeCard);
    } else {
      sidebarPrCardBridge.hidden(bridgeCard);
    }
  }, [cardActions, tooltipVisible]);
  useEffect(() => {
    const bridgeCard = bridgeCardRef.current;
    return () => sidebarPrCardBridge.hidden(bridgeCard);
  }, []);

  // `resolvePrChipPresentation` owns the draft / conflict / checks-running
  // rules, including the "defer to the sibling status pills" case, so the
  // composer's Tiptap-rendered chip reaches the same classes from the same
  // reading of the PR.
  const isDraft = presentation.isDraft;
  const className = ["pr-chip", ...prChipModifierClasses(presentation)].join(" ");

  // role="button" span (not a real <button>) so the chip is legal HTML
  // inside the row's main <button>. stopPropagation prevents the row's
  // "select thread" click from firing when the user is opening a PR.
  const handleActivate = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    tooltipController.hide();
    event.currentTarget.blur();
    props.onOpen(pr.url);
  };
  const handleDetach = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    props.onDetach?.(pr);
  };

  return (
    <>
      <span
        ref={contextMenuInvokerRef}
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-label={`Open ${pr.org}/${pr.repo}#${pr.number} (${status}) in browser${
          props.watch?.ci ? ", waiting for CI" : ""
        }`}
        // The card's numbers are a DESCRIPTION, not part of this control's
        // name — packing them into the label makes every chip in a sidebar
        // read like a paragraph. The portal sits outside this subtree, so
        // pointing at it by id is what makes the card audible at all.
        aria-describedby={tooltipVisible ? tooltipController.tooltipId : undefined}
        className={className}
        data-pr-chip=""
        data-pr-url={pr.url}
        draggable={false}
        // Focus moving onto the card's own buttons keeps it.
        onBlur={(event) => {
          if (!tooltipController.contains(event.relatedTarget as Node | null)) {
            tooltipController.hide();
          }
        }}
        onClick={handleActivate}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          window.getSelection()?.removeAllRanges();
          tooltipController.hide();
          const rect = event.currentTarget.getBoundingClientRect();
          const position = {
            x: event.clientX,
            y: event.clientY,
            anchorTop: rect.top,
          };
          if (props.onOpenContextMenu) {
            props.onOpenContextMenu(pr, position);
          } else {
            contextMenuInvokerRef.current = event.currentTarget;
            setContextMenuPosition(position);
          }
        }}
        onDragStart={(event) => event.preventDefault()}
        onFocus={(event) => tooltipController.show(event.currentTarget, card)}
        // The ✕ is pointer-only, so Delete is the keyboard's way to detach.
        aria-keyshortcuts={props.onDetach ? "Delete Backspace" : undefined}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            handleActivate(event);
          } else if (
            props.onDetach
            && (event.key === "Delete" || event.key === "Backspace")
            && !event.metaKey
            && !event.ctrlKey
            && !event.altKey
            && !event.shiftKey
          ) {
            tooltipController.hide();
            handleDetach(event);
          }
        }}
        onMouseEnter={(event) => {
          // Another sidebar card is up: swap to this one at once.
          if (cardActions && sidebarPrCardBridge.enterTrigger(bridgeCardRef.current)) {
            tooltipController.show(event.currentTarget, latestCardRef.current);
            return;
          }
          tooltipController.showAfterDelay(
            event.currentTarget,
            () => latestCardRef.current,
          );
        }}
        onMouseLeave={(event) => {
          // Bridge to a card the pointer can reach; one drawn over the rows
          // closes as before, so it never blocks the next row.
          if (
            cardActions
            && tooltipVisible
            && cardIsBesideSidebar(
              document.getElementById(tooltipController.tooltipId),
              event.currentTarget,
            )
          ) {
            sidebarPrCardBridge.leaveTrigger(bridgeCardRef.current);
            return;
          }
          tooltipController.hide();
        }}
      >
        <span
          className="pr-chip__dot"
          aria-hidden="true"
          ref={presentation.hasFailingChecksStillRunning ? statusPulseRef : undefined}
        />
        <span className="pr-chip__label">{label}</span>
        {props.watch?.ci ? (
          // Not a target: the chip is the control, and the card explains it.
          <span className="pr-chip__watch" aria-hidden="true">
            <EyeIcon size={12} />
          </span>
        ) : null}
        {props.onDetach && !props.hideDetachButton ? (
          // A pointer shortcut, not a second control: a button inside the
          // chip's button is nested-interactive, and at 16px it is under the
          // 24px target floor. Keyboards detach with Delete on the chip or
          // from its menu.
          <span
            aria-hidden="true"
            className="pr-chip__detach"
            title={`Detach ${pr.org}/${pr.repo}#${pr.number} from thread`}
            onClick={handleDetach}
          >
            <CloseIcon size={11} aria-hidden="true" />
          </span>
        ) : null}
        {isDraft ? <span className="pr-chip__draft-bar" aria-hidden="true" /> : null}
      </span>
      {tooltipController.tooltipNode}
      {contextMenuPosition && contextMenuInvokerRef.current ? (
        <PrChipContextMenu
          position={contextMenuPosition}
          pr={pr}
          onDetach={props.onDetach ? () => props.onDetach?.(pr) : undefined}
          returnFocusTo={contextMenuInvokerRef.current}
          onClose={() => setContextMenuPosition(undefined)}
        />
      ) : null}
    </>
  );
});
