import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import type { PrSummary } from "@pwragent/shared";
import { CloseIcon, EyeIcon } from "../../icons";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { useHoverTransitionGrace } from "../../lib/useHoverTransitionGrace";
import { TOOLTIP_HOVER_DELAY_MS, useViewportTooltip } from "../../lib/useViewportTooltip";
import { statusPulseRef } from "../../lib/status-pulse";
import {
  resolvePrChipWatch,
  type ThreadPrWatches,
} from "../pr-watches/useThreadPrWatchIndicators";
import { PrChip } from "./PrChip";
import { PrStatusCard } from "./PrStatusCard";
import { placeRollupPopover } from "./pr-rollup-popover-placement";
import {
  prChipModifierClasses,
  prStatusLabel,
  resolvePrChipPresentation,
} from "./pr-chip-state";
import { prBranchBehindLabel, type PrBranchDrift } from "./pr-branch-drift";
import { prNumberLabel, prRollupLabel, resolvePrRollup } from "./pr-rollup";

type PrRollupChipProps = {
  prs: PrSummary[];
  /** Names the popover for assistive tech: "Pull requests for <title>". */
  threadTitle: string;
  /** Newline-joined URLs of the PRs that need their org/repo prefix. */
  repoPrefixedUrls: string;
  onOpen: (url: string) => void;
  onOpenContextMenu?: (
    pr: PrSummary,
    position: { x: number; y: number; anchorTop?: number },
  ) => void;
  /**
   * Detaches one PR: Delete on the chip or a popover row, or a row's ✕. The
   * title line draws no ✕ on the chip itself; Minimal has no room for it.
   */
  onDetach?: (pr: PrSummary) => void;
  /** The popover's Detach all, with every PR the chip rolls up. */
  onDetachAll?: (prs: readonly PrSummary[]) => void;
  /** The thread branch's base drift, for the PR on that branch. */
  branchDrift?: PrBranchDrift;
  /** The thread's active PR watches; a CI watch draws the eye. */
  prWatches?: ThreadPrWatches;
  /**
   * The repository whose PRs the thread's Auto-fix repairs, which the hover
   * card lists. From `resolveThreadAutoFixRepository`.
   */
  autoFixRepository?: string;
  /**
   * The row's hover prefetch. The chips line arms it for the chips in the
   * flow; this chip sits on the title line, outside that line.
   */
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
};

/** Hover opens a peek; a click or the keyboard keeps it open. */
type OpenMode = "hover" | "pinned";

/**
 * The Minimal density's single PR chip, on the row's title line.
 *
 * One PR renders as the ordinary `PrChip`, so its hover card and context
 * menu behave as everywhere else. Several render as one chip wearing the
 * least ready PR's state (`resolvePrRollup`), with a scrollable popover that
 * lists them all. When exactly one of them is open, the chip names that PR
 * and counts the rest (`#12 +3`); otherwise it shows the count. The popover opens on hover and stays open while the pointer
 * moves into it; a click or Enter keeps it open until Escape, an outside
 * click, or a choice.
 */
export const PrRollupChip = memo(function PrRollupChip(props: PrRollupChipProps) {
  if (props.prs.length === 1) {
    const pr = props.prs[0]!;
    return (
      <span
        className="thread-row__pr-rollup"
        onMouseEnter={props.onHoverStart}
        onMouseLeave={props.onHoverEnd}
      >
        <PrChip
          pr={pr}
          showRepoPrefix={props.repoPrefixedUrls.split("\n").includes(pr.url)}
          branchDrift={props.branchDrift?.url === pr.url ? props.branchDrift : undefined}
          watch={resolvePrChipWatch(props.prWatches, pr, props.autoFixRepository)}
          onOpen={props.onOpen}
          onOpenContextMenu={props.onOpenContextMenu}
          onDetach={props.onDetach}
          hideDetachButton
        />
      </span>
    );
  }
  return <MultiPrRollupChip {...props} />;
});

function MultiPrRollupChip(props: PrRollupChipProps) {
  const rollup = resolvePrRollup(props.prs)!;
  const repoPrefixed = new Set(props.repoPrefixedUrls.split("\n"));
  const presentation = resolvePrChipPresentation(rollup.representative);
  const leadLabel = rollup.lead
    ? prNumberLabel(rollup.lead, repoPrefixed.has(rollup.lead.url))
    : undefined;
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const popoverId = useId();
  const [openMode, setOpenMode] = useState<OpenMode | null>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    maxHeight: number;
    /** The side the chip that opened the list is on: each row's PR chip sits there. */
    chipSide: "left" | "right";
  }>();
  const open = openMode !== null;
  const {
    show: showCard,
    showAfterDelay: showCardAfterDelay,
    hide: hideRowCard,
    update: updateCard,
    visible: cardVisible,
    tooltipId: cardId,
    tooltipNode: cardNode,
  } = useViewportTooltip({
    className: "pr-status-card",
    placement: "beside",
    getAnchorRect: (target) =>
      popoverRef.current?.getBoundingClientRect() ?? target.getBoundingClientRect(),
  });
  const [cardUrl, setCardUrl] = useState<string>();
  const watchFor = (pr: PrSummary) =>
    resolvePrChipWatch(props.prWatches, pr, props.autoFixRepository);
  const watchStopHint = Boolean(props.onOpenContextMenu);
  const waitingForCi = rollup.ordered.some((pr) => watchFor(pr)?.ci);
  // Read from the live list, so a status update reaches an open card.
  const cardPr = rollup.ordered.find((pr) => pr.url === cardUrl);
  const cardDrift = props.branchDrift?.url === cardUrl ? props.branchDrift : undefined;

  useEffect(() => {
    if (!cardVisible) return;
    if (!cardPr) {
      hideRowCard();
      return;
    }
    updateCard(
      <PrStatusCard
        pr={cardPr}
        branchDrift={cardDrift}
        watch={resolvePrChipWatch(props.prWatches, cardPr, props.autoFixRepository)}
        watchStopHint={watchStopHint}
      />,
    );
  }, [cardVisible, cardPr, cardDrift, props.prWatches, props.autoFixRepository, watchStopHint, hideRowCard, updateCard]);

  const clearHoverTimer = (): void => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };
  // The first hover waits; moving between visible cards and focus show at once.
  const showRowCard = (pr: PrSummary, row: HTMLElement, immediate: boolean): void => {
    setCardUrl(pr.url);
    const content = (
      <PrStatusCard
        pr={pr}
        branchDrift={props.branchDrift?.url === pr.url ? props.branchDrift : undefined}
        watch={watchFor(pr)}
        watchStopHint={watchStopHint}
      />
    );
    if (immediate || cardVisible) {
      showCard(row, content);
    } else {
      showCardAfterDelay(row, content);
    }
  };
  const close = useCallback((): void => {
    setOpenMode(null);
    setPosition(undefined);
    hideRowCard();
  }, [hideRowCard]);
  const { cancelHoverDismiss, dismissAfterGrace, dismissImmediately } =
    useHoverTransitionGrace(close);

  useEffect(() => () => {
    clearHoverTimer();
  }, []);

  useDismissableLayer({
    open,
    onDismiss: close,
    surfaceRef: popoverRef,
    triggerRef,
  });

  // Below the chip, else above; a list too tall for either side scrolls.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    // Measured past any cap from the last placement, so a list that grew
    // while open can take the room it now needs.
    const list = popover.querySelector<HTMLElement>(".pr-rollup-popover__list");
    const contentHeight = list
      ? popover.offsetHeight - list.clientHeight + list.scrollHeight
      : popover.offsetHeight;
    const chip = trigger.getBoundingClientRect();
    const placed = placeRollupPopover({
      chip,
      width: popover.offsetWidth,
      contentHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    // The rows' chips, and their ✕, sit on the side nearest the pointer.
    const next = {
      ...placed,
      chipSide: (chip.left + chip.right) / 2 < placed.left + popover.offsetWidth / 2
        ? "left" as const
        : "right" as const,
    };
    setPosition((current) =>
      current
      && current.top === next.top
      && current.left === next.left
      && current.maxHeight === next.maxHeight
      && current.chipSide === next.chipSide
        ? current
        : next);
  }, [open, rollup.ordered.length]);

  // An outside press or a scroll of the chip's ancestors closes it: the
  // popover is fixed to where the chip was. Sibling panes (including the
  // auto-scrolling transcript) cannot move that anchor.
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node
      && Boolean(popoverRef.current?.contains(target) || triggerRef.current?.contains(target));
    const onPointerDown = (event: PointerEvent): void => {
      if (!inside(event.target)) close();
    };
    const onScroll = (event: Event): void => {
      const target = event.target;
      if (
        target === window
        || target === document
        || (target instanceof Node && target.contains(triggerRef.current))
      ) {
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  const focusRow = (index: number): void => {
    const rows = popoverRef.current?.querySelectorAll<HTMLButtonElement>(
      ".pr-rollup-popover__row",
    );
    if (!rows || rows.length === 0) return;
    rows[(index + rows.length) % rows.length]!.focus();
  };

  const openPinned = (focusFirst: boolean): void => {
    clearHoverTimer();
    cancelHoverDismiss();
    setOpenMode("pinned");
    if (focusFirst) {
      // The rows exist after this commit.
      window.requestAnimationFrame(() => focusRow(0));
    }
  };

  const handleTriggerActivate = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
  ): void => {
    // The row selects its thread on click; the chip opens the list instead.
    event.preventDefault();
    event.stopPropagation();
    if (openMode === "pinned") {
      dismissImmediately();
      return;
    }
    openPinned(event.type === "keydown");
  };

  // Detaching keeps the list open. Focus moves to the row that slides into
  // the detached one's place, or to the new last row.
  const detachRow = (pr: PrSummary, index: number, refocus: boolean): void => {
    if (!props.onDetach) return;
    hideRowCard();
    props.onDetach(pr);
    if (refocus) {
      window.requestAnimationFrame(() => {
        // A confirmation dialog took focus: leave it there.
        const active = document.activeElement;
        if (active && active !== document.body && !popoverRef.current?.contains(active)) {
          return;
        }
        const rows = popoverRef.current?.querySelectorAll<HTMLButtonElement>(
          ".pr-rollup-popover__row",
        );
        if (rows && rows.length > 0) rows[Math.min(index, rows.length - 1)]!.focus();
      });
    }
  };

  const handleRowKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    pr: PrSummary,
    index: number,
  ): void => {
    if (
      props.onDetach
      && (event.key === "Delete" || event.key === "Backspace")
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
      && !event.shiftKey
    ) {
      event.preventDefault();
      detachRow(pr, index, true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(index + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusRow(event.key === "Home" ? 0 : rollup.ordered.length - 1);
    } else if (event.key === "Tab") {
      // Tab steps from the rows to Detach all, when there is one.
      const detachAll = popoverRef.current?.querySelector<HTMLButtonElement>(
        ".pr-rollup-popover__detach-all",
      );
      if (!event.shiftKey && detachAll) {
        event.preventDefault();
        detachAll.focus();
        return;
      }
      leavePopover(event.shiftKey, event);
    }
  };

  // Hand focus to the chip before the rows unmount. Tab then moves on from
  // the chip; Shift+Tab stops on it.
  const leavePopover = (backwards: boolean, event: KeyboardEvent<HTMLElement>): void => {
    triggerRef.current?.focus();
    if (backwards) event.preventDefault();
    dismissImmediately();
  };

  const className = [
    "pr-chip",
    "pr-chip--rollup",
    ...prChipModifierClasses(presentation),
  ].join(" ");
  const dotRef = presentation.hasFailingChecksStillRunning ? statusPulseRef : undefined;

  return (
    <span
      className="thread-row__pr-rollup"
      onMouseEnter={props.onHoverStart}
      onMouseLeave={props.onHoverEnd}
    >
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-label={`${props.prs.length} pull requests, ${
          leadLabel ? `${leadLabel} open, ` : ""
        }${rollup.summary}${waitingForCi ? ", waiting for CI" : ""}`}
        className={className}
        data-pr-rollup=""
        draggable={false}
        onClick={handleTriggerActivate}
        onDragStart={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
            handleTriggerActivate(event);
          }
        }}
        onMouseEnter={() => {
          cancelHoverDismiss();
          if (open) return;
          clearHoverTimer();
          hoverTimerRef.current = window.setTimeout(() => {
            hoverTimerRef.current = null;
            setOpenMode((current) => current ?? "hover");
          }, TOOLTIP_HOVER_DELAY_MS);
        }}
        onMouseLeave={() => {
          clearHoverTimer();
          if (openMode === "hover") dismissAfterGrace();
        }}
      >
        {leadLabel ? (
          <>
            {/* The draft bar marks the lead PR, so it centers under its
                dot and number rather than the whole pill. */}
            <span className="pr-chip__lead">
              <span className="pr-chip__dot" aria-hidden="true" ref={dotRef} />
              <span className="pr-chip__label">{leadLabel}</span>
              {presentation.isDraft
                ? <span className="pr-chip__draft-bar" aria-hidden="true" />
                : null}
            </span>
            <span className="pr-chip__more">+{props.prs.length - 1}</span>
            {waitingForCi ? (
              <span className="pr-chip__watch" aria-hidden="true">
                <EyeIcon size={12} />
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="pr-chip__dot" aria-hidden="true" ref={dotRef} />
            <span className="pr-chip__label">{prRollupLabel(props.prs)}</span>
            {waitingForCi ? (
              <span className="pr-chip__watch" aria-hidden="true">
                <EyeIcon size={12} />
              </span>
            ) : null}
            {presentation.isDraft
              ? <span className="pr-chip__draft-bar" aria-hidden="true" />
              : null}
          </>
        )}
      </span>
      {open
        ? createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            role="group"
            aria-label={`Pull requests for ${props.threadTitle}`}
            className={position?.chipSide === "left"
              ? "pr-rollup-popover pr-rollup-popover--chips-left"
              : "pr-rollup-popover"}
            style={position
              ? { top: position.top, left: position.left, maxHeight: position.maxHeight }
              : { top: 0, left: 0, visibility: "hidden" }}
            onMouseEnter={cancelHoverDismiss}
            onMouseLeave={() => {
              hideRowCard();
              if (openMode === "hover") dismissAfterGrace();
            }}
          >
            <div className="pr-rollup-popover__head">
              <span className="pr-rollup-popover__eyebrow">
                {props.prs.length} pull requests
              </span>
              <span className="pr-rollup-popover__summary">{rollup.summary}</span>
            </div>
            {/* A scrolled list moves the row out from under its card. */}
            <ul className="pr-rollup-popover__list" onScroll={hideRowCard}>
              {rollup.ordered.map((pr, index) => {
                const label = prNumberLabel(pr, repoPrefixed.has(pr.url));
                const behind = props.branchDrift?.url === pr.url
                  ? prBranchBehindLabel(props.branchDrift)
                  : undefined;
                const status = behind
                  ? `${prStatusLabel(pr)} · ${behind}`
                  : prStatusLabel(pr);
                const rowPresentation = resolvePrChipPresentation(pr);
                const rowWaitingForCi = Boolean(watchFor(pr)?.ci);
                const openRow = (): void => {
                  dismissImmediately();
                  props.onOpen(pr.url);
                };
                return (
                  // The card and the PR menu cover the row's chip too.
                  <li
                    key={pr.url}
                    onMouseEnter={(event) => showRowCard(pr, event.currentTarget, false)}
                    onContextMenu={(event) => {
                      if (!props.onOpenContextMenu) return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      dismissImmediately();
                      props.onOpenContextMenu(pr, {
                        x: event.clientX,
                        y: event.clientY,
                        anchorTop: rect.top,
                      });
                    }}
                  >
                    <button
                      type="button"
                      className="pr-rollup-popover__row"
                      aria-label={`Open ${pr.org}/${pr.repo}#${pr.number}${
                        pr.title ? `, ${pr.title}` : ""
                      } (${status}) in browser${rowWaitingForCi ? ", waiting for CI" : ""}`}
                      aria-describedby={
                        cardUrl === pr.url && cardVisible ? cardId : undefined
                      }
                      onFocus={(event) => showRowCard(pr, event.currentTarget, true)}
                      onBlur={hideRowCard}
                      onClick={openRow}
                      aria-keyshortcuts={props.onDetach ? "Delete Backspace" : undefined}
                      onKeyDown={(event) => handleRowKeyDown(event, pr, index)}
                    >
                      <span className="pr-rollup-popover__title">
                        {pr.title ?? `${pr.org}/${pr.repo}`}
                      </span>
                      <span className="pr-rollup-popover__status">{status}</span>
                    </button>
                    {/* The chip as Mission Control draws it, ✕ included. It is
                        a pointer shortcut beside the row's button, not a second
                        control: its number opens the PR as the row does, and
                        Delete on the row is the keyboard's detach. */}
                    <span
                      aria-hidden="true"
                      className={[
                        "pr-chip",
                        "pr-rollup-popover__chip",
                        ...prChipModifierClasses(rowPresentation),
                      ].join(" ")}
                      onClick={openRow}
                    >
                      <span
                        className="pr-chip__dot"
                        ref={rowPresentation.hasFailingChecksStillRunning ? statusPulseRef : undefined}
                      />
                      <span className="pr-chip__label">{label}</span>
                      {rowWaitingForCi ? (
                        <span className="pr-chip__watch">
                          <EyeIcon size={12} />
                        </span>
                      ) : null}
                      {props.onDetach ? (
                        <span
                          className="pr-chip__detach"
                          title={`Detach ${pr.org}/${pr.repo}#${pr.number} from thread`}
                          onMouseEnter={hideRowCard}
                          onClick={(event) => {
                            event.stopPropagation();
                            detachRow(pr, index, false);
                          }}
                        >
                          <CloseIcon size={11} aria-hidden="true" />
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            {props.onDetachAll ? (
              <div className="pr-rollup-popover__foot">
                <button
                  type="button"
                  className="pr-rollup-popover__detach-all"
                  onMouseEnter={hideRowCard}
                  onKeyDown={(event) => {
                    if (event.key !== "Tab") return;
                    if (event.shiftKey) {
                      event.preventDefault();
                      focusRow(rollup.ordered.length - 1);
                      return;
                    }
                    leavePopover(false, event);
                  }}
                  onClick={() => {
                    const prs = rollup.ordered;
                    // The chip outlives the list, so the confirmation returns
                    // focus there rather than to an unmounted button.
                    triggerRef.current?.focus();
                    dismissImmediately();
                    props.onDetachAll?.(prs);
                  }}
                >
                  Detach all
                </button>
              </div>
            ) : null}
          </div>,
          document.body,
        )
        : null}
      {cardNode}
    </span>
  );
}
