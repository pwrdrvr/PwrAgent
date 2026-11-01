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
import { EyeIcon } from "../../icons";
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
  /** The thread branch's base drift, for the PR on that branch. */
  branchDrift?: PrBranchDrift;
  /** The thread's active PR watches; a CI watch draws the eye. */
  prWatches?: ThreadPrWatches;
  /** The thread's Auto-fix setting, which the hover card lists. */
  autoFix?: boolean;
  /**
   * The row's hover prefetch. The chips line arms it for the chips in the
   * flow; this chip sits on the title line, outside that line.
   */
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
};

/** Hover opens a peek; a click or the keyboard keeps it open. */
type OpenMode = "hover" | "pinned";

const POPOVER_GAP = 6;
const VIEWPORT_MARGIN = 8;

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
          watch={resolvePrChipWatch(props.prWatches, pr, props.autoFix === true)}
          onOpen={props.onOpen}
          onOpenContextMenu={props.onOpenContextMenu}
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
  const [position, setPosition] = useState<{ top: number; left: number }>();
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
    resolvePrChipWatch(props.prWatches, pr, props.autoFix === true);
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
        watch={resolvePrChipWatch(props.prWatches, cardPr, props.autoFix === true)}
        watchStopHint={watchStopHint}
      />,
    );
  }, [cardVisible, cardPr, cardDrift, props.prWatches, props.autoFix, watchStopHint, hideRowCard, updateCard]);

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

  // Place below the chip, right edges aligned, and flip above when the
  // list would run off the bottom of the window.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    const rect = trigger.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.right - width),
      window.innerWidth - width - VIEWPORT_MARGIN,
    );
    const below = rect.bottom + POPOVER_GAP;
    const top = below + height > window.innerHeight - VIEWPORT_MARGIN
      ? Math.max(VIEWPORT_MARGIN, rect.top - POPOVER_GAP - height)
      : below;
    setPosition((current) =>
      current && current.top === top && current.left === left
        ? current
        : { top, left });
  }, [open, rollup.ordered.length]);

  // An outside press or a scroll elsewhere closes it: the popover is fixed
  // to where the chip was, and a scrolled sidebar would leave it stranded.
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node
      && Boolean(popoverRef.current?.contains(target) || triggerRef.current?.contains(target));
    const onPointerDown = (event: PointerEvent): void => {
      if (!inside(event.target)) close();
    };
    const onScroll = (event: Event): void => {
      if (!inside(event.target)) close();
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

  const handleRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(index + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusRow(event.key === "Home" ? 0 : rollup.ordered.length - 1);
    } else if (event.key === "Tab") {
      // Hand focus to the chip before the rows unmount. Tab then moves on
      // from the chip; Shift+Tab stops on it.
      triggerRef.current?.focus();
      if (event.shiftKey) event.preventDefault();
      dismissImmediately();
    }
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
            className="pr-rollup-popover"
            style={position
              ? { top: position.top, left: position.left }
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
                return (
                  <li key={pr.url}>
                    <button
                      type="button"
                      className="pr-rollup-popover__row"
                      aria-label={`Open ${pr.org}/${pr.repo}#${pr.number}${
                        pr.title ? `, ${pr.title}` : ""
                      } (${status}) in browser${rowWaitingForCi ? ", waiting for CI" : ""}`}
                      aria-describedby={
                        cardUrl === pr.url && cardVisible ? cardId : undefined
                      }
                      onMouseEnter={(event) => showRowCard(pr, event.currentTarget, false)}
                      onFocus={(event) => showRowCard(pr, event.currentTarget, true)}
                      onBlur={hideRowCard}
                      onClick={() => {
                        dismissImmediately();
                        props.onOpen(pr.url);
                      }}
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
                      onKeyDown={(event) => handleRowKeyDown(event, index)}
                    >
                      <span
                        aria-hidden="true"
                        className={[
                          "pr-chip",
                          ...prChipModifierClasses(rowPresentation),
                        ].join(" ")}
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
                      </span>
                      <span className="pr-rollup-popover__text">
                        <span className="pr-rollup-popover__title">
                          {pr.title ?? `${pr.org}/${pr.repo}`}
                        </span>
                        <span className="pr-rollup-popover__status">{status}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>,
          document.body,
        )
        : null}
      {cardNode}
    </span>
  );
}
