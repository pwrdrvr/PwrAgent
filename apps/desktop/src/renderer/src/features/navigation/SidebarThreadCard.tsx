import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApplicationDiscoveryCandidate } from "@pwragent/shared/contracts/settings";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FolderIcon,
  MoreVerticalIcon,
  PinIcon,
  PullRequestIcon,
  TerminalIcon,
} from "../../icons";
import { AppIcon } from "../../components/AppIcon";
import { getDesktopApi } from "../../lib/desktop-api";
import {
  POINTER_AIM_SETTLE_MS,
  POINTER_AIM_TRAIL,
  pointerAimsAtRect,
  type AimPoint,
} from "../../lib/pointer-aim";
import { readRendererFederationTarget } from "../../lib/federation-window";
import {
  type BridgedHoverCard,
  cardIsBesideSidebar,
  sidebarAnchorRect,
  sidebarPrCardBridge,
} from "../../lib/hover-card-bridge";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { ThreadInfoCard, type ThreadInfo } from "../thread-detail/ThreadInfoCard";
import {
  readThreadInfoCost,
  threadInfoFacts,
  type ThreadInfoCost,
  type ThreadInfoRowFacts,
} from "../thread-detail/thread-info";
import { PROJECT_CARD_HOVER_DELAY_MS } from "./ProjectHeaderCard";

/** A folder the card can open: the thread's primary one first. */
export type SidebarThreadCardFolder = { label: string; path: string };

/**
 * What the card can do for one thread. Each entry is one of the sidebar's
 * existing handlers, bound to the thread; an absent entry is an action the
 * thread does not offer (a peer's thread has no local editor).
 */
export type SidebarThreadCardActions = {
  /** Apps on this machine that open the thread's folders. */
  open?: {
    editors: readonly DesktopApplicationDiscoveryCandidate[];
    preferredEditor?: DesktopApplicationDiscoveryCandidate;
    terminal?: DesktopApplicationDiscoveryCandidate;
    /** "Show in Finder" and the like. */
    reveal?: { label: string; run: (folder: SidebarThreadCardFolder) => void };
    run: (application: DesktopApplicationDiscoveryCandidate, folder: SidebarThreadCardFolder) => void;
  };
  copyBranch?: () => void;
  /** Shows the PR's own card, or opens it where the row has no PR chip. */
  showPullRequest?: () => void;
  openPullRequest?: () => void;
  pin?: { pinned: boolean; toggle: () => void };
  /** Mark read: the thread leaves Attention. */
  markRead?: () => void;
  archive?: () => void;
  /** The row's own context menu, anchored to the card's ⋯. */
  openMenu: (anchor: HTMLElement) => void;
};

/** Everything the card reads about a row when it opens. */
export type SidebarThreadCardOptions = {
  readThread: (threadKey: string) => NavigationThreadSummary | undefined;
  rowFacts: (thread: NavigationThreadSummary) => ThreadInfoRowFacts;
  actionsFor: (thread: NavigationThreadSummary, row: HTMLElement) => SidebarThreadCardActions;
};

export type SidebarThreadCardHandle = {
  /** The pointer entered a thread row. */
  enter: (target: HTMLElement, threadKey: string) => void;
  /** Keyboard focus reached a thread row: no hover delay. */
  focus: (target: HTMLElement, threadKey: string) => void;
  /** The pointer left a thread row. */
  leave: (target: HTMLElement) => void;
  /**
   * The pointer is crossing `row` on its way to the card: keep the card, and
   * hold that row's own chips too. `null` once it is no longer crossing.
   */
  hold: (row: HTMLElement | null) => void;
  hide: () => void;
  getElement: () => HTMLElement | null;
  /** A press anywhere: a card still waiting out its delay never opens. */
  cancelPending: () => void;
};

type Expanded = "apps" | "folders" | undefined;

/**
 * The app the editor split opens, for this window's session: the operator's
 * last pick from the split's menu, else the preferred editor. `reveal` is
 * the file manager.
 */
let lastOpenChoice: string | undefined;

/**
 * One hover card for every thread row in the sidebar, like the project
 * header card. It shares the sidebar's bridge, so at most one sidebar card is
 * up and a sweep swaps between them. Rows are found by delegation
 * (`useSidebarThreadCardTriggers`), so no row re-renders for the card.
 */
export const SidebarThreadCardHost = forwardRef<
  SidebarThreadCardHandle,
  { options: SidebarThreadCardOptions }
>(function SidebarThreadCardHost(props, ref) {
  const optionsRef = useRef(props.options);
  optionsRef.current = props.options;
  const bridgeCardRef = useRef<BridgedHoverCard>({ hide: () => undefined });
  const tooltip = useViewportTooltip({
    className: "pr-status-card pr-status-card--actions thread-info-card sidebar-thread-card",
    placement: "beside",
    getAnchorRect: sidebarAnchorRect,
    interactive: {
      onPointerEnter: () => sidebarPrCardBridge.enterCard(bridgeCardRef.current),
      onPointerLeave: () => sidebarPrCardBridge.leaveCard(bridgeCardRef.current),
      // The card opens past the sidebar, level with the row; the strip
      // fills the gap so the way there crosses no other card's trigger.
      bridge: true,
    },
  });
  const { getElement, hide, show, showAfterDelay, tooltipId, update, visible } = tooltip;
  bridgeCardRef.current.hide = hide;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Set while the hover delay runs. The tooltip cancels its own delay on a
  // press too, but only once an effect has attached its listeners: a press
  // in the same frame as the pointer's arrival (a quick click) beats it.
  const pendingRef = useRef(false);
  if (visible) pendingRef.current = false;
  const [shown, setShown] = useState<{ threadKey: string; row: HTMLElement }>();
  // The row whose card is up (or about to be): its own chips are on the way
  // to the card, so crossing one keeps this card (`HoverCardBridge.holds`).
  const heldRowRef = useRef<HTMLElement | null>(null);
  const crossingRowRef = useRef<HTMLElement | null>(null);
  bridgeCardRef.current.holds = (trigger) =>
    Boolean(heldRowRef.current?.contains(trigger) || crossingRowRef.current?.contains(trigger));
  const [expanded, setExpanded] = useState<Expanded>();

  const content = (threadKey: string, row: HTMLElement, open: Expanded): ReactElement | null => {
    const thread = optionsRef.current.readThread(threadKey);
    if (!thread) return null;
    return (
      <SidebarThreadCardContent
        key={threadKey}
        thread={thread}
        facts={optionsRef.current.rowFacts(thread)}
        actions={optionsRef.current.actionsFor(thread, row)}
        expanded={open}
        onExpand={setExpanded}
        onDone={hide}
      />
    );
  };

  // A live row (its PR, its Git state) and an expanded list both redraw the
  // open card in place; `update` re-measures it against the viewport.
  useEffect(() => {
    if (!visible || !shown) return;
    const next = content(shown.threadKey, shown.row, expanded);
    if (next) update(next);
    else hide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.options, expanded, visible]);

  // The row's card is its description while it is up.
  useEffect(() => {
    const row = shown?.row.querySelector<HTMLElement>(".thread-row__open");
    if (!visible || !row) return;
    row.setAttribute("aria-describedby", tooltipId);
    return () => row.removeAttribute("aria-describedby");
  }, [shown, tooltipId, visible]);

  useEffect(() => {
    const card = bridgeCardRef.current;
    if (visible) sidebarPrCardBridge.shown(card);
    else sidebarPrCardBridge.hidden(card);
  }, [visible]);
  useEffect(() => {
    const card = bridgeCardRef.current;
    return () => sidebarPrCardBridge.hidden(card);
  }, []);

  useImperativeHandle(ref, () => {
    const open = (target: HTMLElement, threadKey: string, delayed: boolean): void => {
      const node = content(threadKey, target, undefined);
      if (!node) return;
      setShown({ threadKey, row: target });
      heldRowRef.current = target.closest(ROW_SELECTOR) ?? target;
      crossingRowRef.current = null;
      setExpanded(undefined);
      // Focus opens at once; a pointer swaps at once while any sidebar card is up.
      const swap = sidebarPrCardBridge.enterTrigger(bridgeCardRef.current);
      if (!delayed || swap) {
        show(target, node);
        return;
      }
      // The tooltip's own delay, so a press, scroll or Escape cancels it; a
      // chip's card shown meanwhile cancels it through the bridge.
      sidebarPrCardBridge.delaying(bridgeCardRef.current);
      pendingRef.current = true;
      showAfterDelay(target, () => content(threadKey, target, undefined), PROJECT_CARD_HOVER_DELAY_MS);
    };
    return {
      enter: (target, threadKey) => open(target, threadKey, true),
      focus: (target, threadKey) => open(target, threadKey, false),
      leave: (target) => {
        if (visibleRef.current && cardIsBesideSidebar(getElement(), target)) {
          sidebarPrCardBridge.leaveTrigger(bridgeCardRef.current);
          return;
        }
        hide();
      },
      hold: (row) => {
        crossingRowRef.current = row;
        if (row) sidebarPrCardBridge.enterTrigger(bridgeCardRef.current);
      },
      hide,
      getElement,
      cancelPending: () => {
        if (!pendingRef.current) return;
        pendingRef.current = false;
        if (!visibleRef.current) hide();
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getElement, hide, show, showAfterDelay]);

  return <>{tooltip.tooltipNode}</>;
});

const ROW_SELECTOR = ".thread-row-shell[data-thread-key]";

/** Keys that move focus between rows: Tab, and the list's own keys. */
const NAVIGATION_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

function rowShellOf(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>(ROW_SELECTOR) : null;
}

/** The element a row's card anchors to: the row's card body. */
function rowTarget(shell: HTMLElement): HTMLElement {
  return shell.querySelector<HTMLElement>(":scope > .thread-row") ?? shell;
}

/**
 * Opens the card for whichever thread row the pointer or keyboard reaches
 * under `root`. Pointer movement inside one row is not a new entry; a row's
 * nested controls (PR chips, the pin) open their own cards or tooltips over
 * it. A row crossed while the pointer heads for the open card (the safe
 * triangle, `pointerAimsAtRect`) is on the way, not a destination: it takes
 * the card only once the pointer stops or turns away. Focus opens the card only when the operator moved it there with a
 * navigation key: a click focuses the row on its way to opening the thread,
 * and focus handed back after a rename or a menu is not an arrival.
 */
export function useSidebarThreadCardTriggers(
  root: RefObject<HTMLElement | null>,
  card: RefObject<SidebarThreadCardHandle | null>,
): void {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    // Set by a navigation key, cleared by any other key or a press.
    let navigating = false;
    // Recent pointer samples, and a row crossed on the way to the card.
    const trail: AimPoint[] = [];
    let hovered: HTMLElement | null = null;
    let crossed: HTMLElement | undefined;
    let aimTimer: number | undefined;
    const enterRow = (shell: HTMLElement): void => {
      const key = shell.dataset.threadKey;
      if (key) card.current?.enter(rowTarget(shell), key);
    };
    const forgetCrossed = (): void => {
      window.clearTimeout(aimTimer);
      aimTimer = undefined;
      if (crossed) card.current?.hold(null);
      crossed = undefined;
    };
    const settleCrossed = (): void => {
      const row = crossed;
      forgetCrossed();
      if (row?.isConnected && row === hovered) enterRow(row);
    };
    const waitToSettle = (): void => {
      window.clearTimeout(aimTimer);
      aimTimer = window.setTimeout(settleCrossed, POINTER_AIM_SETTLE_MS);
    };
    // Measured from the oldest recent sample, so one jittery move does not decide it.
    const aimsAtCard = (point: AimPoint): boolean => {
      const from = trail[0];
      const box = card.current?.getElement()?.getBoundingClientRect();
      return Boolean(from && box && box.width > 0 && pointerAimsAtRect(from, point, box));
    };
    const onMouseMove = (event: MouseEvent): void => {
      const point = { x: event.clientX, y: event.clientY };
      if (crossed) {
        if (aimsAtCard(point)) waitToSettle();
        else settleCrossed();
      }
      trail.push(point);
      if (trail.length > POINTER_AIM_TRAIL) trail.shift();
    };
    const onMouseOver = (event: MouseEvent): void => {
      const shell = rowShellOf(event.target);
      if (!shell || shell === rowShellOf(event.relatedTarget)) return;
      hovered = shell;
      if (aimsAtCard({ x: event.clientX, y: event.clientY })) {
        crossed = shell;
        card.current?.hold(shell);
        waitToSettle();
        return;
      }
      forgetCrossed();
      enterRow(shell);
    };
    const onMouseOut = (event: MouseEvent): void => {
      const shell = rowShellOf(event.target);
      if (!shell || shell === rowShellOf(event.relatedTarget)) return;
      if (!rowShellOf(event.relatedTarget)) hovered = null;
      if (crossed === shell) forgetCrossed();
      card.current?.leave(rowTarget(shell));
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      navigating = NAVIGATION_KEYS.has(event.key);
    };
    const onPointerDown = (): void => {
      navigating = false;
      card.current?.cancelPending();
    };
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!navigating || !(target instanceof HTMLElement) || !target.matches(".thread-row__open")) return;
      const shell = rowShellOf(target);
      const key = shell?.dataset.threadKey;
      if (shell && key) card.current?.focus(rowTarget(shell), key);
    };
    const onFocusOut = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches(".thread-row__open")) return;
      const next = event.relatedTarget;
      // Focus moving into the card (a press on one of its buttons) keeps it.
      const shown = card.current?.getElement();
      if (!shown || (next instanceof Node && shown.contains(next))) return;
      card.current?.hide();
    };
    element.addEventListener("mousemove", onMouseMove);
    element.addEventListener("mouseover", onMouseOver);
    element.addEventListener("mouseout", onMouseOut);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    element.addEventListener("focusin", onFocusIn);
    element.addEventListener("focusout", onFocusOut);
    return () => {
      forgetCrossed();
      element.removeEventListener("mousemove", onMouseMove);
      element.removeEventListener("mouseover", onMouseOver);
      element.removeEventListener("mouseout", onMouseOut);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      element.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("focusout", onFocusOut);
    };
  }, [card, root]);
}

function SidebarThreadCardContent(props: {
  thread: NavigationThreadSummary;
  facts: ThreadInfoRowFacts;
  actions: SidebarThreadCardActions;
  expanded: Expanded;
  onExpand: (expanded: Expanded) => void;
  onDone: () => void;
}): ReactElement {
  const { thread, actions, onDone } = props;
  const target = thread.federation?.ref.target;
  const instanceId = target?.scope === "remote" ? target.instanceId : undefined;
  const instanceLabel = thread.federation?.instanceLabel;
  const link = useMemo((): ResolvedThreadLink => ({
    backend: thread.source,
    threadId: thread.id,
    title: thread.title,
    ...(instanceId ? { instanceId, ...(instanceLabel ? { instanceLabel } : {}) } : {}),
  }), [instanceId, instanceLabel, thread.id, thread.source, thread.title]);
  const cost = useThreadCardCost(thread);
  const info: ThreadInfo = { facts: threadInfoFacts(thread), factsState: "ready", cost };
  return (
    <ThreadInfoCard
      link={link}
      label={thread.title}
      info={info}
      row={props.facts}
      onCopyBranch={actions.copyBranch}
      onOpenPullRequest={actions.showPullRequest}
      actions={(
        <ThreadCardActions
          actions={actions}
          folders={props.facts.folders}
          running={info.facts?.running === true}
          expanded={props.expanded}
          onExpand={props.onExpand}
          onDone={onDone}
        />
      )}
    />
  );
}

/** One stored-totals read when the card opens, shared with the chip cards' cache. */
function useThreadCardCost(thread: NavigationThreadSummary): ThreadInfoCost | { state: "idle" } {
  const api = getDesktopApi();
  const [cost, setCost] = useState<ThreadInfoCost | { state: "idle" }>(
    api?.readThreadFamilyPricing ? { state: "loading" } : { state: "unavailable" },
  );
  const target = thread.federation?.ref.target;
  const ownerId = target?.scope === "remote" ? target.instanceId : undefined;
  useEffect(() => {
    if (!api?.readThreadFamilyPricing) return;
    let current = true;
    const windowTarget = readRendererFederationTarget();
    const owner = ownerId ? { scope: "remote" as const, instanceId: ownerId } : windowTarget;
    void readThreadInfoCost(api, { backend: thread.source, threadId: thread.id }, owner)
      .then((next) => { if (current) setCost(next); });
    return () => { current = false; };
  }, [api, ownerId, thread.id, thread.source]);
  return cost;
}

function ThreadCardActions(props: {
  actions: SidebarThreadCardActions;
  folders: readonly SidebarThreadCardFolder[];
  running: boolean;
  expanded: Expanded;
  onExpand: (expanded: Expanded) => void;
  onDone: () => void;
}): ReactElement {
  const { actions, folders, onDone } = props;
  const open = folders.length ? actions.open : undefined;
  const choices = open ? openChoices(open) : [];
  const choice = choices.find((entry) => entry.id === lastOpenChoice)
    ?? choices.find((entry) => entry.id === open?.preferredEditor?.id)
    ?? choices[0];
  const primary = folders[0];
  const runChoice = (entry: OpenChoice, folder: SidebarThreadCardFolder): void => {
    lastOpenChoice = entry.id;
    onDone();
    entry.run(folder);
  };
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  return (
    // Pointer shortcuts, out of the Tab order like the project card's: the
    // keyboard reaches each one from the row's own menu.
    <div className="sidebar-thread-card__actions" aria-hidden="true">
      {open && choice && primary ? (
        <>
          <div className="sidebar-thread-card__split">
            <button
              className="sidebar-thread-card__row"
              tabIndex={-1}
              type="button"
              onClick={() => {
                if (folders.length > 1) {
                  props.onExpand(props.expanded === "folders" ? undefined : "folders");
                  return;
                }
                runChoice(choice, primary);
              }}
            >
              {choice.icon}
              <span className="sidebar-thread-card__row-label">{choice.label}</span>
            </button>
            {choices.length > 1 ? (
              <button
                aria-label="Choose an app"
                className="sidebar-thread-card__row sidebar-thread-card__chevron"
                tabIndex={-1}
                type="button"
                onClick={() => props.onExpand(props.expanded === "apps" ? undefined : "apps")}
              >
                <ChevronDownIcon size={12} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {props.expanded === "folders" ? (
            <div className="sidebar-thread-card__sublist">
              {folders.map((folder) => (
                <button
                  key={folder.path}
                  className="sidebar-thread-card__row"
                  tabIndex={-1}
                  type="button"
                  onClick={() => runChoice(choice, folder)}
                >
                  <FolderIcon size={13} aria-hidden="true" />
                  <span className="sidebar-thread-card__row-label">{folder.label}</span>
                </button>
              ))}
            </div>
          ) : null}
          {props.expanded === "apps" ? (
            <div className="sidebar-thread-card__sublist">
              {choices.map((entry) => (
                <button
                  key={entry.id}
                  className={`sidebar-thread-card__row${entry.id === choice.id ? " is-current" : ""}`}
                  tabIndex={-1}
                  type="button"
                  onClick={() => {
                    lastOpenChoice = entry.id;
                    props.onExpand(folders.length > 1 ? "folders" : undefined);
                    if (folders.length === 1) runChoice(entry, primary);
                  }}
                >
                  {entry.icon}
                  <span className="sidebar-thread-card__row-label">{entry.name}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {open?.terminal && primary ? (
        <button
          className="sidebar-thread-card__row"
          tabIndex={-1}
          type="button"
          onClick={() => {
            onDone();
            open.run(open.terminal!, primary);
          }}
        >
          <TerminalIcon size={13} aria-hidden="true" />
          <span className="sidebar-thread-card__row-label">Open terminal here</span>
        </button>
      ) : null}
      {actions.copyBranch ? (
        <button
          className="sidebar-thread-card__row"
          tabIndex={-1}
          type="button"
          onClick={() => {
            actions.copyBranch?.();
            setCopied(true);
            window.clearTimeout(copiedTimer.current);
            copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          <CopyIcon size={13} aria-hidden="true" />
          <span className="sidebar-thread-card__row-label">{copied ? "Copied" : "Copy branch name"}</span>
        </button>
      ) : null}
      {actions.openPullRequest ? (
        <button
          className="sidebar-thread-card__row"
          tabIndex={-1}
          type="button"
          onClick={() => {
            onDone();
            actions.openPullRequest?.();
          }}
        >
          <PullRequestIcon size={13} aria-hidden="true" />
          <span className="sidebar-thread-card__row-label">Open pull request</span>
        </button>
      ) : null}
      <div className="sidebar-thread-card__buttons">
        {actions.pin ? (
          <button
            aria-label={actions.pin.pinned ? "Unpin thread" : "Pin thread"}
            aria-pressed={actions.pin.pinned}
            className={`sidebar-thread-card__button sidebar-thread-card__button--icon${
              actions.pin.pinned ? " is-on" : ""
            }`}
            tabIndex={-1}
            type="button"
            onClick={actions.pin.toggle}
          >
            <PinIcon size={13} aria-hidden="true" />
          </button>
        ) : null}
        {/* A running thread has no Stop here yet; Mark read and Archive wait
            until it is idle, as the design swaps them out while it runs. */}
        {!props.running && actions.markRead ? (
          <button
            className="sidebar-thread-card__button"
            tabIndex={-1}
            type="button"
            onClick={() => {
              onDone();
              actions.markRead?.();
            }}
          >
            <CheckIcon size={12} aria-hidden="true" />
            Mark read
          </button>
        ) : null}
        {!props.running && actions.archive ? (
          <button
            className="sidebar-thread-card__button"
            tabIndex={-1}
            type="button"
            onClick={() => {
              onDone();
              actions.archive?.();
            }}
          >
            <ArchiveIcon size={12} aria-hidden="true" />
            Archive
          </button>
        ) : null}
        <span className="sidebar-thread-card__buttons-spacer" />
        <button
          aria-label="More thread actions"
          className="sidebar-thread-card__button sidebar-thread-card__button--icon"
          tabIndex={-1}
          type="button"
          onClick={(event) => {
            const anchor = event.currentTarget;
            actions.openMenu(anchor);
            onDone();
          }}
        >
          <MoreVerticalIcon size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

type OpenChoice = {
  id: string;
  name: string;
  /** "Open in VS Code", "Show in Finder". */
  label: string;
  icon: ReactElement;
  run: (folder: SidebarThreadCardFolder) => void;
};

function openChoices(open: NonNullable<SidebarThreadCardActions["open"]>): OpenChoice[] {
  const choices: OpenChoice[] = open.editors.map((application) => ({
    id: application.id,
    name: application.name,
    label: `Open in ${application.name}`,
    icon: <AppIcon application={application} className="sidebar-thread-card__app-icon" size={14} />,
    run: (folder) => open.run(application, folder),
  }));
  if (open.reveal) {
    const reveal = open.reveal;
    choices.push({
      id: "reveal",
      name: reveal.label.replace(/^Show in /, ""),
      label: reveal.label,
      icon: <FolderIcon size={13} aria-hidden="true" />,
      run: reveal.run,
    });
  }
  return choices;
}
