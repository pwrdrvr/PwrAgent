import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { buildPullRequestStatusKey, type NavigationThreadSummary, type PrSummary } from "@pwragent/shared/contracts/navigation";
import { CloseIcon, EyeIcon } from "../../icons";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { useHoverTransitionGrace } from "../../lib/useHoverTransitionGrace";
import { TOOLTIP_HOVER_DELAY_MS, useViewportTooltip } from "../../lib/useViewportTooltip";
import { statusPulseRef } from "../../lib/status-pulse";
import { useThreadPullRequestAttachments, type PullRequestAttachmentThread } from "../../lib/useThreadPullRequestAttachments";
import {
  resolvePrChipWatch,
  type ThreadPrWatches,
} from "../pr-watches/useThreadPrWatchIndicators";
import { MAX_COMPACT_STACK_MEMBERSHIPS, type CompactStackMembership } from "@pwragent/shared/stacks/stack-status";
import { sidebarPrCardBridge } from "../../lib/hover-card-bridge";
import { getDesktopApi } from "../../lib/desktop-api";
import { useSelectedStackDetails } from "../stacks/useSelectedStackDetails";
import { StackHeading, StackNode, StackTrunk } from "../stacks/StackBody";
import { groupStackRollup, knownPrStatus, stackHealthLabel, stackMembershipForPr, staleStackSpine } from "../stacks/stack-pr-data";
import { PrChip } from "./PrChip";
import { PrCardActions } from "./PrCardActions";
import { PrStatusCard } from "./PrStatusCard";
import { placeRollupPopover } from "./pr-rollup-popover-placement";
import {
  prChipModifierClasses,
  prStatusLabel,
  resolveLifecycleState,
  resolvePrChipPresentation,
} from "./pr-chip-state";
import { prBranchBehindLabel, type PrBranchDrift } from "./pr-branch-drift";
import {
  prNumberLabel,
  prOverflowLabel,
  prRollupLabel,
  prStackTimeLabel,
  resolvePrOverflow,
  resolvePrRollup,
} from "./pr-rollup";

type PrRollupChipProps = {
  prs: PrSummary[];
  stackThread?: NavigationThreadSummary;
  /** Newline-joined URLs whose readiness the stack chip represents. */
  heldPrUrls?: string;
  /** Names the popover for assistive tech: "Pull requests for <title>". */
  threadTitle: string;
  /** Newline-joined URLs of the PRs that need their org/repo prefix. */
  repoPrefixedUrls: string;
  /** Owner identity for a compact row whose attached PRs were truncated. */
  attachmentThread?: PullRequestAttachmentThread;
  needsRepoPrefix?: (pr: PrSummary, prs: PrSummary[]) => boolean;
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
  /**
   * `overflow` is Mission Control's `+N PRs` chip, drawn after the lead PR's
   * own chip (`resolvePrOverflow`). It counts and wears the state of the PRs
   * the lead leaves out, and opens the same list of every PR.
   */
  variant?: "rollup" | "overflow";
  /** Each attached PR's card can merge it, as the lead chip's does. */
  merge?: ComponentProps<typeof PrChip>["merge"];
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
  if (props.variant === "overflow") {
    return props.prs.length > 1 ? <MultiPrRollupChip {...props} /> : null;
  }
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
          stackThread={props.stackThread}
          branchDrift={props.branchDrift?.prKey === buildPullRequestStatusKey(pr) ? props.branchDrift : undefined}
          watch={resolvePrChipWatch(props.prWatches, pr, props.autoFixRepository)}
          onOpen={props.onOpen}
          onOpenContextMenu={props.onOpenContextMenu}
          onDetach={props.onDetach}
          hideDetachButton
          cardActions
          merge={props.merge}
        />
      </span>
    );
  }
  return <MultiPrRollupChip {...props} />;
});

function MultiPrRollupChip(props: PrRollupChipProps) {
  const [openMode, setOpenMode] = useState<OpenMode | null>(null);
  const open = openMode !== null;
  const attachments = useThreadPullRequestAttachments(open ? props.attachmentThread : undefined);
  const incomplete = Boolean(props.attachmentThread?.prsTruncated && !attachments.prs);
  const listPrs = attachments.prs ?? props.prs;
  const count = attachments.prs?.length ?? props.attachmentThread?.prCount ?? props.prs.length;
  const countUnknown = incomplete && props.attachmentThread?.prCount === undefined;
  const countLabel = `${count}${countUnknown ? "+" : ""}`;
  const moreCount = Math.max(0, count - 1);
  const rollup = resolvePrRollup(props.prs)!;
  const listRollup = listPrs === props.prs ? rollup : resolvePrRollup(listPrs);
  const stackPreview = props.stackThread?.stackMemberships;
  const needStackDetails = open && Boolean(stackPreview && (stackPreview.length >= MAX_COMPACT_STACK_MEMBERSHIPS
    || stackPreview.some(({ count, trunk }) => count > 1 && !trunk)));
  const stackDetails = useSelectedStackDetails({
    thread: needStackDetails ? props.stackThread : undefined,
    desktopApi: needStackDetails ? getDesktopApi() : undefined,
    allowLegacyLookup: false,
  });
  const entries = open ? groupStackRollup(listRollup?.ordered ?? [], props.stackThread, stackDetails.stacks) : [];
  const ordered = entries.flatMap((entry) => "stack" in entry ? entry.rows.map(({ pr }) => pr) : [entry]);
  const orderIndices = new Map(ordered.map((pr, index) => [pr.url, index]));
  const groupCount = entries.length;
  const held = props.heldPrUrls && new Set(props.heldPrUrls.split("\n"));
  const visiblePreview = held ? props.prs.filter((pr) => !held.has(pr.url)) : props.prs;
  const signalPrs = held ? listPrs.filter((pr) => !held.has(pr.url)) : listPrs;
  const overflow = props.variant === "overflow";
  const overflowLabel = countUnknown ? "More PRs" : prOverflowLabel(moreCount);
  // The PRs the chip itself speaks for: all of them, or the ones the lead
  // chip beside it leaves out. The list always holds every PR.
  const overflowLead = overflow ? resolvePrOverflow(visiblePreview)?.lead ?? visiblePreview[0] : undefined;
  const chipRollup = resolvePrRollup(overflowLead ? signalPrs.filter((pr) => pr.url !== overflowLead.url) : signalPrs);
  const repoPrefixed = new Set(props.repoPrefixedUrls.split("\n"));
  const summaryText = incomplete ? (attachments.failed ? "Couldn’t load all PRs" : "Loading PRs…")
    : held ? resolvePrRollup(signalPrs)?.summary ?? "Held by lower stack layers" : listRollup?.summary;
  const presentation = chipRollup && resolvePrChipPresentation(chipRollup.representative);
  const lead = chipRollup?.lead;
  const leadLabel = lead && !overflow
    ? prNumberLabel(lead, repoPrefixed.has(lead.url) || props.needsRepoPrefix?.(lead, listPrs) === true)
    : undefined;
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const popoverId = useId();
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    maxHeight: number;
    /** The side the chip that opened the list is on: each row's PR chip sits there. */
    chipSide: "left" | "right";
  }>();
  const { cancelHoverDismiss, dismissAfterGrace, dismissImmediately } =
    useHoverTransitionGrace(() => close());
  const { cancelHoverDismiss: holdCard, dismissAfterGrace: releaseCard } =
    useHoverTransitionGrace(() => hideRowCard());
  const leaveCard = (): void => {
    releaseCard();
    if (openMode === "hover") dismissAfterGrace();
  };
  const {
    show: showCard,
    showAfterDelay: showCardAfterDelay,
    hide: hideRowCard,
    update: updateCard,
    visible: cardVisible,
    tooltipId: cardId,
    tooltipNode: cardNode,
    getElement: getCardElement,
  } = useViewportTooltip({
    className: "pr-status-card pr-status-card--actions",
    placement: "beside",
    getAnchorRect: (target) =>
      popoverRef.current?.getBoundingClientRect() ?? target.getBoundingClientRect(),
    interactive: {
      bridge: true,
      onPointerEnter: () => {
        holdCard();
        cancelHoverDismiss();
      },
      onPointerLeave: leaveCard,
    },
  });
  const [cardUrl, setCardUrl] = useState<string>();
  // The row a PR menu opened from, outlined until focus comes back.
  const [menuTargetUrl, setMenuTargetUrl] = useState<string>();
  const openingMenuRef = useRef(false);
  const watchFor = (pr: PrSummary) =>
    resolvePrChipWatch(props.prWatches, pr, props.autoFixRepository);
  const watchStopHint = Boolean(props.onOpenContextMenu);
  const waitingForCi = chipRollup?.ordered.some((pr) => watchFor(pr)?.ci);
  // Read from the live list, so a status update reaches an open card.
  const cardPr = ordered.find((pr) => pr.url === cardUrl);
  const latestCardRef = useRef<ReactNode>(null);
  const relayoutCard = useCallback(() => updateCard(latestCardRef.current), [updateCard]);
  const { branchDrift, prWatches, autoFixRepository, merge, onDetach, stackThread } = props;
  const renderCard = useCallback((pr: PrSummary) => (
    <>
      <PrStatusCard
        pr={pr}
        branchDrift={branchDrift?.prKey === buildPullRequestStatusKey(pr) ? branchDrift : undefined}
        watch={resolvePrChipWatch(prWatches, pr, autoFixRepository)}
        watchStopHint={watchStopHint}
        stack={stackThread && stackMembershipForPr(stackThread, pr)}
        stackThread={stackThread}
      />
      <PrCardActions
        pr={pr}
        merge={merge}
        onDismiss={hideRowCard}
        onDetach={onDetach ? () => {
          // The trigger survives the detach confirmation and the list shortening.
          triggerRef.current?.focus();
          dismissImmediately();
          onDetach(pr);
        } : undefined}
        onLayoutChange={relayoutCard}
      />
    </>
  ), [branchDrift, prWatches, autoFixRepository, watchStopHint, merge, hideRowCard, onDetach, dismissImmediately, relayoutCard, stackThread]);

  useEffect(() => {
    if (!cardVisible) return;
    if (!cardPr) {
      hideRowCard();
      return;
    }
    latestCardRef.current = renderCard(cardPr);
    updateCard(latestCardRef.current);
  }, [cardVisible, cardPr, renderCard, hideRowCard, updateCard]);

  const clearHoverTimer = (): void => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };
  // The first hover waits; moving between visible cards and focus show at once.
  const showRowCard = (pr: PrSummary, row: HTMLElement, immediate: boolean): void => {
    holdCard();
    setCardUrl(pr.url);
    const content = renderCard(pr);
    latestCardRef.current = content;
    if (immediate || cardVisible) {
      showCard(row, content);
    } else {
      showCardAfterDelay(row, content);
    }
  };
  const close = useCallback((): void => {
    holdCard();
    setOpenMode(null);
    setPosition(undefined);
    setMenuTargetUrl(undefined);
    hideRowCard();
  }, [hideRowCard, holdCard]);

  useEffect(() => () => {
    clearHoverTimer();
  }, []);

  useDismissableLayer({
    open,
    onDismiss: close,
    surfaceRef: popoverRef,
    triggerRef,
    getPortaledSurface: getCardElement,
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
  }, [open, groupCount, ordered.length, incomplete]);

  // An outside press or a scroll of the chip's ancestors closes it: the
  // popover is fixed to where the chip was. Sibling panes (including the
  // auto-scrolling transcript) cannot move that anchor.
  useEffect(() => {
    if (!open) return;
    // A PR menu opened from a row sits outside the list: choosing from it
    // keeps the list, so the next PR is one right-click away.
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node
      && Boolean(
        popoverRef.current?.contains(target)
        || triggerRef.current?.contains(target)
        || getCardElement()?.contains(target)
        || (target instanceof Element && target.closest(".thread-context-menu")),
      );
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
  }, [open, close, getCardElement]);

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
      focusRow(event.key === "Home" ? 0 : ordered.length - 1);
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

  // A right-click on a row opens that PR's menu over the list. The list is a
  // portal, but React bubbles its events to the thread row, whose own menu
  // would replace this one: claim the event. The row button takes focus
  // first, so the menu hands focus back to it when it closes, which clears
  // the outline.
  const openRowContextMenu = (event: MouseEvent<HTMLLIElement>, pr: PrSummary): void => {
    event.preventDefault();
    event.stopPropagation();
    const onOpenContextMenu = props.onOpenContextMenu;
    if (!onOpenContextMenu) return;
    clearHoverTimer();
    cancelHoverDismiss();
    hideRowCard();
    setOpenMode("pinned");
    setMenuTargetUrl(pr.url);
    const row = event.currentTarget;
    openingMenuRef.current = true;
    row.querySelector<HTMLButtonElement>(".pr-rollup-popover__row")?.focus();
    openingMenuRef.current = false;
    const rect = row.getBoundingClientRect();
    onOpenContextMenu(pr, {
      x: event.clientX,
      y: event.clientY,
      anchorTop: rect.top,
    });
  };

  const className = [
    "pr-chip",
    "pr-chip--rollup",
    ...(overflow ? ["pr-chip--overflow"] : []),
    ...(presentation ? prChipModifierClasses(presentation) : []),
  ].join(" ");
  const dotRef = presentation?.hasFailingChecksStillRunning ? statusPulseRef : undefined;

  const renderRow = (pr: PrSummary, index: number, member?: CompactStackMembership) => {
    const label = prNumberLabel(pr, repoPrefixed.has(pr.url)
      || props.needsRepoPrefix?.(pr, listPrs) === true);
    const behind = props.branchDrift?.prKey === buildPullRequestStatusKey(pr)
      ? prBranchBehindLabel(props.branchDrift)
      : undefined;
    const isHeld = held && held.has(pr.url);
    const status = isHeld && !member?.heldBy ? "Held by a lower stack layer" : behind
      ? `${prStatusLabel(pr)} · ${behind}`
      : prStatusLabel(pr);
    // The time each stack sorts by, so the order reads as one.
    // It leads, so a long open status never cuts it off. A
    // finished PR's status says only that it merged or closed,
    // which the time already says; a merge queue's account of
    // the merge stays.
    const stackTime = prStackTimeLabel(pr);
    const lifecycle = resolveLifecycleState(pr);
    const statusLine = !stackTime
      ? status
      : lifecycle === "closed"
        || (lifecycle === "merged" && pr.mergeQueue?.state !== "merged_by_queue")
        ? stackTime
        : `${stackTime} · ${status}`;
    const health = member && stackHealthLabel(member);
    const displayStatus = member ? knownPrStatus(statusLine) : statusLine;
    const rowPresentation = isHeld ? undefined : resolvePrChipPresentation(pr);
    const rowWaitingForCi = !isHeld && Boolean(watchFor(pr)?.ci);
    const openRow = (): void => {
      dismissImmediately();
      props.onOpen(pr.url);
    };
    return (
      // The card and the PR menu cover the row's chip too.
      <li
        key={pr.url}
        className={["pr-rollup-popover__item", member ? "stack-display__layer" : "", menuTargetUrl === pr.url ? "is-menu-target" : ""].filter(Boolean).join(" ")}
        data-position={member?.position}
        data-stale={member && staleStackSpine(member.health) || undefined}
        onMouseEnter={(event) => {
          if (!menuTargetUrl) showRowCard(pr, event.currentTarget, false);
        }}
        onContextMenu={(event) => openRowContextMenu(event, pr)}
      >
        {member ? <StackNode pr={pr} /> : null}
        <button
          type="button"
          className="pr-rollup-popover__row"
          aria-label={`Open ${pr.org}/${pr.repo}#${pr.number}${
            pr.title ? `, ${pr.title}` : ""
          } (${member ? [knownPrStatus(status), health].filter(Boolean).join(" · ") : status}) in browser${rowWaitingForCi ? ", waiting for CI" : ""}`}
          aria-describedby={
            cardUrl === pr.url && cardVisible ? cardId : undefined
          }
          onFocus={(event) => {
            // Focus back from this row's own menu shows no card.
            if (!openingMenuRef.current && menuTargetUrl !== pr.url) {
              showRowCard(pr, event.currentTarget, true);
            }
          }}
          onBlur={(event) => {
            if (!getCardElement()?.contains(event.relatedTarget)) hideRowCard();
          }}
          onClick={openRow}
          aria-keyshortcuts={props.onDetach ? "Delete Backspace" : undefined}
          onKeyDown={(event) => handleRowKeyDown(event, pr, index)}
        >
          <span className="pr-rollup-popover__title">
            {pr.title ?? `${pr.org}/${pr.repo}`}
          </span>
          <span className="pr-rollup-popover__status">
            {member ? `${member.position}/${member.count}` : null}
            {member && displayStatus ? " · " : null}
            {displayStatus}
            {health ? <span className="stack-display__warning"> · {health}</span> : null}
          </span>
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
            ...(rowPresentation ? prChipModifierClasses(rowPresentation) : []),
          ].join(" ")}
          onClick={openRow}
        >
          {member ? null : <span
            className="pr-chip__dot"
            ref={rowPresentation?.hasFailingChecksStillRunning ? statusPulseRef : undefined}
          />}
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
  };

  return (
    <span
      className={overflow ? "thread-row__pr-overflow" : "thread-row__pr-rollup"}
      onMouseEnter={props.onHoverStart}
      onMouseLeave={props.onHoverEnd}
    >
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        // The visible `+N PRs` leads the name (WCAG 2.5.3, label in name).
        aria-label={overflow
          ? `${overflowLabel}: ${moreCount}${countUnknown ? "+" : ""} more ${
            moreCount === 1 ? "pull request" : "pull requests"
          }${props.attachmentThread || !chipRollup ? "" : `, ${chipRollup.summary}`}${waitingForCi ? ", waiting for CI" : ""}`
          : `${countLabel} pull requests${
            leadLabel ? `, ${leadLabel} open` : ""
          }${props.attachmentThread || !chipRollup ? "" : `, ${chipRollup.summary}`}${waitingForCi ? ", waiting for CI" : ""}`}
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
            if (!sidebarPrCardBridge.hasPinnedCard()) setOpenMode((current) => current ?? "hover");
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
              {presentation?.isDraft
                ? <span className="pr-chip__draft-bar" aria-hidden="true" />
                : null}
            </span>
            <span className="pr-chip__more">+{moreCount}{countUnknown ? "+" : ""}</span>
            {waitingForCi ? (
              <span className="pr-chip__watch" aria-hidden="true">
                <EyeIcon size={12} />
              </span>
            ) : null}
          </>
        ) : (
          <>
            {presentation ? <span className="pr-chip__dot" aria-hidden="true" ref={dotRef} /> : null}
            <span className="pr-chip__label">
              {overflow ? overflowLabel : incomplete || held ? `${countLabel} PRs` : prRollupLabel(listPrs)}
            </span>
            {waitingForCi ? (
              <span className="pr-chip__watch" aria-hidden="true">
                <EyeIcon size={12} />
              </span>
            ) : null}
            {presentation?.isDraft
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
              const card = getCardElement()?.getBoundingClientRect();
              const popover = popoverRef.current?.getBoundingClientRect();
              if (card?.width && card.height && popover && (
                card.left >= popover.right || card.right <= popover.left
                || card.top >= popover.bottom || card.bottom <= popover.top
              )) {
                leaveCard();
                return;
              }
              hideRowCard();
              if (openMode === "hover") dismissAfterGrace();
            }}
            // The heading and footer have no menu, and the thread row's
            // must not open from inside the list.
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onFocus={() => {
              if (!openingMenuRef.current) setMenuTargetUrl(undefined);
            }}
            onPointerDown={(event) => {
              if (event.button === 0) setMenuTargetUrl(undefined);
            }}
          >
            <div className="pr-rollup-popover__head">
              <span className="pr-rollup-popover__eyebrow">
                {countLabel} pull requests
              </span>
              <span className="pr-rollup-popover__summary" role={incomplete ? "status" : undefined}>{summaryText}</span>
            </div>
            {/* A scrolled list moves the row out from under its card. */}
            <ul className="pr-rollup-popover__list" onScroll={hideRowCard}>
              {entries.map((entry) => "stack" in entry ? (
                <li key={entry.stack.key} className="pr-rollup-popover__stack">
                  <StackHeading count={entry.stack.count} trunk={entry.trunk} inferred={entry.stack.inferred} grouped />
                  <ol className="stack-display__list" reversed>
                    {entry.rows.map(({ pr, member }) => renderRow(pr, orderIndices.get(pr.url)!, member))}
                    <StackTrunk trunk={entry.stack.trunk!} />
                  </ol>
                </li>
              ) : renderRow(entry, orderIndices.get(entry.url)!))}
            </ul>
            {props.onDetachAll && !incomplete && ordered.length ? (
              <div className="pr-rollup-popover__foot">
                <button
                  type="button"
                  className="pr-rollup-popover__detach-all"
                  onMouseEnter={hideRowCard}
                  onKeyDown={(event) => {
                    if (event.key !== "Tab") return;
                    if (event.shiftKey) {
                      event.preventDefault();
                      focusRow(ordered.length - 1);
                      return;
                    }
                    leavePopover(false, event);
                  }}
                  onClick={() => {
                    const prs = ordered;
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
