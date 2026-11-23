import { useContext, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import type { CompactStackMembership } from "@pwragent/shared/stacks/stack-status";
import { getDesktopApi } from "../../lib/desktop-api";
import { sidebarPrCardBridge, type BridgedHoverCard } from "../../lib/hover-card-bridge";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { StackBody, StackGlyph, StackHeading } from "./StackBody";
import { StackRailContext } from "./stack-presentation";
import { staleStackSpine } from "./stack-pr-data";
import { useSelectedStackDetails } from "./useSelectedStackDetails";

type StackTagProps = {
  thread: NavigationThreadSummary;
  pr: PrSummary;
  member: CompactStackMembership;
  onOpen: (url: string) => void;
};

function StackPopover({ thread, member, onOpen, close, focus, body }: Omit<StackTagProps, "pr"> & {
  close: () => void;
  focus: boolean;
  body: RefObject<HTMLDivElement | null>;
}) {
  const openRail = useContext(StackRailContext);
  const legacy = thread.stacks?.find(({ stack }) => stack.key === member.key)?.stack;
  const details = useSelectedStackDetails({ thread, desktopApi: getDesktopApi(), enabled: !legacy, allowLegacyLookup: false });
  const stack = legacy ?? details.stacks?.find(({ key }) => key === member.key);

  useLayoutEffect(() => {
    if (!focus) return;
    // The portalled surface takes one layout pass before it is visible.
    const frame = requestAnimationFrame(() => {
      const surface = body.current;
      if (surface && (document.activeElement === surface || !surface.contains(document.activeElement))) {
        (surface.querySelector<HTMLButtonElement>(".stack-display__open") ?? surface).focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [body, focus, stack]);

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
      {stack ? <StackBody stack={stack} thread={thread} position={member.position} onThreadOpen={close} onOpen={(url) => {
        close();
        onOpen(url);
      }} /> : <>
        <StackHeading count={member.count} trunk={member.trunk} inferred={member.inferred} />
        <div className="stack-popover__state" role="status">
          {details.error ?? (details.stacks || !getDesktopApi()?.getNavigationSelectedDetail
            ? "Stack details unavailable" : "Loading stack…")}
        </div>
      </>}
      <div className="stack-popover__foot">
        {openRail ? <button type="button" className="stack-popover__rail" onClick={() => {
          close();
          openRail(thread);
        }}>Show in Pull requests</button> : null}
        <span><kbd>↑↓</kbd> move · <kbd>↵</kbd> open PR</span>
      </div>
    </div>
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
  const content = <StackPopover thread={thread} member={member} onOpen={onOpen} body={surface} close={hide} focus={pinned.current} />;
  const latest = useRef(content);
  latest.current = content;

  useEffect(() => {
    if (visible) update(latest.current);
  }, [thread, member, onOpen, visible, update]);
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
    tooltip.show(target, <StackPopover thread={thread} member={member} onOpen={onOpen} body={surface} close={hide} focus />);
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
          if (sidebarPrCardBridge.enterTrigger(bridge.current)) tooltip.show(event.currentTarget, latest.current);
          else tooltip.showAfterDelay(event.currentTarget, () => latest.current);
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
