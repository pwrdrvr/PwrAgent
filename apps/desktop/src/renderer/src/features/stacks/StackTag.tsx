import { useCallback, useContext, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import type { CompactStackMembership } from "@pwragent/shared/stacks/stack-status";
import { getDesktopApi } from "../../lib/desktop-api";
import { elementRect, sidebarPrCardBridge, type BridgedHoverCard } from "../../lib/hover-card-bridge";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { TOOLTIP_HOVER_DELAY_MS, useViewportTooltip } from "../../lib/useViewportTooltip";
import { StackBody, StackGlyph, StackHeading, StackNode, StackTrunk } from "./StackBody";
import { prefetchSelectedStacks, readCachedStack, stackOwnerInstanceId } from "./stack-detail-cache";
import { StackRailContext } from "./stack-presentation";
import { staleStackSpine } from "./stack-pr-data";
import { useSelectedStackDetails } from "./useSelectedStackDetails";

type StackTagProps = {
  thread: NavigationThreadSummary;
  pr: PrSummary;
  member: CompactStackMembership;
  onOpen: (url: string) => void;
};

function StackPopover({ thread, pr, member, onOpen, close, focus, body, onResize }: StackTagProps & {
  onResize: () => void;
  close: () => void;
  focus: boolean;
  body: RefObject<HTMLDivElement | null>;
}) {
  const openRail = useContext(StackRailContext);
  const legacy = thread.stacks?.find(({ stack }) => stack.key === member.key)?.stack;
  // Any member of this stack that loaded it at the same revision supplies it.
  // An older copy draws at once while it is read again.
  const cached = legacy ? undefined : readCachedStack(stackOwnerInstanceId(thread), member);
  const details = useSelectedStackDetails({ thread, desktopApi: getDesktopApi(), enabled: !legacy && !cached?.fresh, allowLegacyLookup: false });
  // A settled read is the truth, including one that no longer has this stack.
  const stack = legacy ?? (details.stacks ? details.stacks.find(({ key }) => key === member.key) : cached?.value);
  const loading = !stack && !details.error && !details.stacks && Boolean(getDesktopApi()?.getNavigationSelectedDetail);

  useLayoutEffect(() => {
    if (!focus) return;
    // The portalled surface takes one layout pass before it is visible.
    const frame = requestAnimationFrame(() => {
      const surface = body.current;
      if (surface && !surface.contains(document.activeElement)) {
        (surface.querySelector<HTMLButtonElement>(".stack-display__open") ?? surface).focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [body, focus]);

  // The details may arrive after the operator has moved on.
  useLayoutEffect(() => {
    const surface = body.current;
    if (focus && stack && surface && document.activeElement === surface) {
      surface.querySelector<HTMLButtonElement>(".stack-display__open")?.focus();
    }
  }, [body, focus, stack]);

  // Selected-detail IPC changes the body size independently of the portal.
  useLayoutEffect(() => {
    const surface = body.current;
    if (!surface || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(onResize);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [body, onResize]);

  function moveBetweenRows(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(body.current?.querySelectorAll<HTMLButtonElement>(".stack-display__open") ?? []);
    if (!rows.length) return;
    event.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const index = current < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1)
      : (current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows[index]?.focus();
  }

  return (
    <div ref={body} className="stack-popover__body" tabIndex={-1} onKeyDown={moveBetweenRows}>
      {stack ? <StackBody stack={stack} thread={thread} currentPr={pr} onThreadOpen={close} onOpen={(url) => {
        close();
        onOpen(url);
      }} /> : <>
        <StackHeading count={member.count} trunk={member.trunk} inferred={member.inferred} />
        {loading ? <StackSkeleton member={member} /> : null}
        <div className={loading ? "stack-popover__loading" : "stack-popover__state"} role="status">
          {details.error ?? (loading ? "Loading stack…" : "Stack details unavailable")}
        </div>
      </>}
      <div className="stack-popover__foot">
        {openRail ? <button type="button" className="stack-popover__rail" onClick={() => {
          close();
          openRail(thread);
        }}>Show in PRs</button> : null}
        <span><kbd>↑↓</kbd> move · <kbd>↵</kbd> open PR</span>
      </div>
    </div>
  );
}

/** Hold the loaded list's rows in place so the popover does not grow when they arrive. */
function StackSkeleton({ member }: { member: StackTagProps["member"] }) {
  const rows = Math.min(member.count, 12);
  return (
    <ol className="stack-display__list" reversed aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => {
        const position = member.count - index;
        return (
          <li key={position} className="stack-display__layer" data-placeholder=""
            data-current={position === member.position || undefined}>
            <StackNode />
            <div className="stack-display__text">
              <span className="stack-display__title"><span className="stack-display__skeleton" /></span>
              <span className="stack-display__status"><span className="stack-display__skeleton" /></span>
            </div>
            <div className="stack-display__position">{position}/{member.count}</div>
          </li>
        );
      })}
      {member.trunk ? <StackTrunk trunk={member.trunk} /> : null}
    </ol>
  );
}

export function StackTag({ thread, pr, member, onOpen }: StackTagProps) {
  const trigger = useRef<HTMLSpanElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const tooltip = useViewportTooltip({
    className: "stack-popover",
    interactive: {
      dialogLabel: `Stack for #${pr.number}`,
      bridge: true,
      onPointerEnter: () => sidebarPrCardBridge.enterCard(bridge.current),
      onPointerLeave: () => {
        if (!pinned.current) sidebarPrCardBridge.leaveCard(bridge.current);
      },
    },
  });
  const { hide, update, visible } = tooltip;
  const bridge = useRef<BridgedHoverCard>({ hide, isPinned: () => pinned.current });
  bridge.current.hide = hide;
  bridge.current.getRect = () => elementRect(tooltip.getElement());
  const latest = useRef<ReactNode>(null);
  const relayout = useCallback(() => update(latest.current), [update]);
  latest.current = <StackPopover thread={thread} pr={pr} member={member} onOpen={onOpen}
    body={surface} close={hide} focus={pinned.current} onResize={relayout} />;

  useEffect(() => {
    if (visible) update(latest.current);
  }, [thread, pr, member, onOpen, visible, update]);
  useEffect(() => {
    const card = bridge.current;
    if (visible) sidebarPrCardBridge.shown(card);
    else {
      pinned.current = false;
      sidebarPrCardBridge.hidden(card);
    }
    return () => sidebarPrCardBridge.hidden(card);
  }, [visible]);
  useDismissableLayer({ open: visible, onDismiss: hide, triggerRef: trigger, surfaceRef: surface });

  const warn = Boolean(member.heldBy) || staleStackSpine(member.health) || member.health === "needs_push";

  function activate(target: HTMLSpanElement) {
    if (visible && pinned.current) {
      hide();
      return;
    }
    pinned.current = true;
    sidebarPrCardBridge.enterCard(bridge.current);
    latest.current = <StackPopover thread={thread} pr={pr} member={member} onOpen={onOpen}
      body={surface} close={hide} focus onResize={relayout} />;
    tooltip.show(target, latest.current);
  }

  return (
    <>
      <span ref={trigger} className="pr-chip__stack" data-warning={warn || undefined}
        role="button" tabIndex={0} aria-label={`Stack position ${member.position} of ${member.count} for #${pr.number}`}
        aria-haspopup="dialog" aria-expanded={visible} aria-controls={visible ? tooltip.tooltipId : undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          activate(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          activate(event.currentTarget);
        }}
        onMouseEnter={(event) => {
          if (pinned.current) return;
          // Read during the hover delay so the popover opens with its rows.
          if (!thread.stacks?.length && !readCachedStack(stackOwnerInstanceId(thread), member)?.fresh) {
            prefetchSelectedStacks(getDesktopApi()?.getNavigationSelectedDetail, thread);
          }
          const wait = sidebarPrCardBridge.enterTrigger(bridge.current, event.currentTarget, TOOLTIP_HOVER_DELAY_MS);
          if (wait === 0) tooltip.show(event.currentTarget, latest.current);
          else tooltip.showAfterDelay(event.currentTarget, () => latest.current, wait);
        }}
        onMouseLeave={() => {
          if (pinned.current) return;
          if (visible) sidebarPrCardBridge.leaveTrigger(bridge.current);
          else hide();
        }}>
        <StackGlyph />{member.position}/{member.count}
      </span>
      {tooltip.tooltipNode}
    </>
  );
}
