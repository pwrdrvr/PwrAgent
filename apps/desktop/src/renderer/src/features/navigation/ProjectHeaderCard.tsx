import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { CopyIcon, FolderIcon, NewThreadIcon } from "../../icons";
import { copyText } from "../../lib/copy-text";
import {
  type BridgedHoverCard,
  cardIsBesideSidebar,
  elementRect,
  sidebarAnchorRect,
  sidebarPrCardBridge,
} from "../../lib/hover-card-bridge";
import type { NavigationDirectoryView } from "../../lib/navigation-loaded-rows";
import { tildifyPath } from "../../lib/tildify-path";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import type { FederationThreadTarget } from "../chrome/federation-thread-targets";
import { rankProjectCardPeers, splitProjectPath } from "./project-header-card";

/** Everything a project card needs beyond its row. Read when the card shows. */
export type ProjectHeaderCardOptions = {
  /** The machine this window starts threads on: "This Mac", or a remote window's peer. */
  localLabel: string;
  /** Secondary text on the local row, such as the machine's name. */
  localDetail?: string;
  /** "Project on <machine>" in a window that fronts another machine. */
  remoteMachineLabel?: string;
  /** "Show in Finder" and the like; absent where the folder cannot be shown. */
  revealLabel?: string;
  onReveal?: (path: string, label: string) => void;
  onStartLocal: (directory: NavigationDirectoryView) => void;
  peers: readonly FederationThreadTarget[];
  threads: readonly NavigationThreadSummary[];
  onStartOnPeer?: (instanceId: string, directory: NavigationDirectoryView) => void;
  /** Opens the full machine menu, anchored to `anchor`. */
  onOtherMachines?: (directory: NavigationDirectoryView, anchor: HTMLElement) => void;
};

export type ProjectHeaderCardHandle = {
  /** Whether `directory` gets a card; read when the pointer arrives. */
  applies: (directory: NavigationDirectoryView) => boolean;
  /** The pointer entered a project header. */
  enter: (target: HTMLElement, directory: NavigationDirectoryView) => void;
  /** The pointer left a project header. */
  leave: (target: HTMLElement) => void;
  hide: () => void;
};

/**
 * How long the pointer rests on a project before its card opens. Longer than
 * a chip's tooltip: a project header is a wide target crossed on the way to
 * every thread under it, and a card that opened on each pass would be noise.
 * Once any sidebar card is up, the next header swaps at once (the bridge).
 */
export const PROJECT_CARD_HOVER_DELAY_MS = 600;

/**
 * One hover card for every project header in a list. It lives in its own
 * component so showing and hiding it re-renders only this host, never the
 * directory list. It shares the sidebar's hover-card bridge with the PR
 * cards, so at most one of them is up and a sweep swaps between them.
 */
export const ProjectHeaderCardHost = forwardRef<
  ProjectHeaderCardHandle,
  { options: ProjectHeaderCardOptions }
>(function ProjectHeaderCardHost(props, ref) {
  const optionsRef = useRef(props.options);
  optionsRef.current = props.options;
  const bridgeCardRef = useRef<BridgedHoverCard>({ hide: () => undefined });
  const tooltip = useViewportTooltip({
    className: "pr-status-card pr-status-card--actions project-card",
    placement: "beside",
    getAnchorRect: sidebarAnchorRect,
    interactive: {
      onPointerEnter: () => sidebarPrCardBridge.enterCard(bridgeCardRef.current),
      onPointerLeave: () => sidebarPrCardBridge.leaveCard(bridgeCardRef.current),
    },
  });
  const hide = tooltip.hide;
  bridgeCardRef.current.hide = hide;
  bridgeCardRef.current.getRect = () => elementRect(tooltip.getElement());
  const visible = tooltip.visible;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const getElement = tooltip.getElement;
  const show = tooltip.show;
  const showAfterDelay = tooltip.showAfterDelay;
  const tooltipId = tooltip.tooltipId;
  // The trigger the card is (or will be) about. Its path and machines are
  // worth hearing, so the trigger names the card as its description while
  // it is up. Set here, not by each list, because only this host knows when
  // the card is visible and the lists must not re-render for it.
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  // The same trigger, read by the bridge: another header is a swap (`showsFor`).
  const triggerRef = useRef<HTMLElement | null>(null);
  bridgeCardRef.current.showsFor = (candidate) => triggerRef.current === candidate;
  const aboutTrigger = (target: HTMLElement): void => {
    triggerRef.current = target;
    setTrigger(target);
  };
  useEffect(() => {
    if (!visible || !trigger) return;
    trigger.setAttribute("aria-describedby", tooltipId);
    return () => trigger.removeAttribute("aria-describedby");
  }, [tooltipId, trigger, visible]);
  // A move to another header while the card is up waits here, not in the
  // tooltip's delay, which would re-anchor the visible card at once.
  const swapTimerRef = useRef<number | undefined>(undefined);
  const cancelSwap = (): void => {
    window.clearTimeout(swapTimerRef.current);
    swapTimerRef.current = undefined;
  };
  useEffect(() => {
    if (visible) return;
    window.clearTimeout(swapTimerRef.current);
    swapTimerRef.current = undefined;
  }, [visible]);
  useEffect(() => () => window.clearTimeout(swapTimerRef.current), []);

  useEffect(() => {
    const card = bridgeCardRef.current;
    if (visible) sidebarPrCardBridge.shown(card);
    else sidebarPrCardBridge.hidden(card);
  }, [visible]);
  useEffect(() => {
    const card = bridgeCardRef.current;
    return () => sidebarPrCardBridge.hidden(card);
  }, []);

  useImperativeHandle(ref, () => ({
    applies: (directory) => projectHeaderCardApplies(directory, optionsRef.current),
    enter: (target, directory) => {
      cancelSwap();
      const content = () => (
        <ProjectHeaderCard
          directory={directory}
          options={optionsRef.current}
          onDone={hide}
        />
      );
      const card = bridgeCardRef.current;
      const wait = sidebarPrCardBridge.enterTrigger(card, target, PROJECT_CARD_HOVER_DELAY_MS);
      if (wait === 0) {
        aboutTrigger(target);
        show(target, content());
        return;
      }
      if (visibleRef.current) {
        // Up for another header: it stays there until the pointer rests here.
        swapTimerRef.current = window.setTimeout(() => {
          swapTimerRef.current = undefined;
          // Render state lags a card that took over this frame; the bridge does not.
          if (!target.isConnected || !visibleRef.current || !sidebarPrCardBridge.isShowing(card)) return;
          aboutTrigger(target);
          show(target, content());
          sidebarPrCardBridge.keep(card);
        }, wait);
        return;
      }
      showAfterDelay(target, () => {
        sidebarPrCardBridge.takeOver(card);
        aboutTrigger(target);
        return content();
      }, wait);
    },
    leave: (target) => {
      cancelSwap();
      if (visibleRef.current && cardIsBesideSidebar(getElement(), target)) {
        sidebarPrCardBridge.leaveTrigger(bridgeCardRef.current);
        return;
      }
      hide();
    },
    hide: () => {
      cancelSwap();
      hide();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [getElement, hide, show, showAfterDelay]);

  return <>{tooltip.tooltipNode}</>;
});

/** Whether a row gets a card at all. */
export function projectHeaderCardApplies(
  directory: Pick<NavigationDirectoryView, "kind" | "path" | "localAvailability">,
  options: Pick<ProjectHeaderCardOptions, "peers" | "onStartOnPeer">,
): boolean {
  if (directory.kind === "unlinked") return false;
  if (directory.localAvailability === "unconfigured") {
    // Its only rows are other machines; with none to start on, the card
    // would be a heading over nothing.
    return options.onStartOnPeer !== undefined
      && options.peers.some((peer) => peer.availability === "available");
  }
  return Boolean(directory.path);
}

export function ProjectHeaderCard(props: {
  directory: NavigationDirectoryView;
  options: ProjectHeaderCardOptions;
  onDone: () => void;
}): ReactElement {
  const { directory, options, onDone } = props;
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  // A peer's project with no checkout here: no path, no local row.
  const unconfigured = directory.localAvailability === "unconfigured";
  const path = unconfigured ? undefined : directory.path;
  // A remote window's path is on the peer: the local home must not shorten it.
  const displayPath = path
    ? options.remoteMachineLabel ? path : tildifyPath(path)
    : undefined;
  const parts = displayPath ? splitProjectPath(displayPath) : undefined;
  const branch = directory.gitStatus?.currentBranch;
  const ahead = directory.gitStatus?.ahead ?? 0;
  const { peers, more } = options.onStartOnPeer
    ? rankProjectCardPeers(options.peers, options.threads)
    : { peers: [], more: false };
  const showMore = more && Boolean(options.onOtherMachines);
  const canReveal = Boolean(path && options.revealLabel && options.onReveal);

  return (
    <>
      <div className="pr-status-card__header">
        <span className="pr-status-card__eyebrow">
          {options.remoteMachineLabel ? `Project on ${options.remoteMachineLabel}` : "Project"}
        </span>
        {branch && !unconfigured ? (
          <span className="pr-status-card__phase">
            {ahead > 0 ? `${branch} · ${ahead} ahead` : branch}
          </span>
        ) : null}
      </div>
      <div className="pr-status-card__title">{directory.label}</div>
      {parts && displayPath ? (
        <div className="project-card__path">
          <span className="project-card__path-head" aria-hidden="true">{parts.head}</span>
          <span className="project-card__path-tail" aria-hidden="true">{parts.tail}</span>
          <span className="pr-status-card__branch-full">{displayPath}</span>
        </div>
      ) : null}
      {unconfigured ? (
        <div className="project-card__caption">
          Not set up on this machine. Start a thread on a machine that has it, or use Add Directory to connect it here.
        </div>
      ) : null}
      {/* Pointer shortcuts, out of the Tab order like the PR card's: the
          keyboard reaches Copy Path and Show in Finder from the project's
          menu, and new threads from the header's + and its machine menu. */}
      {path ? (
        <div className="project-card__actions" aria-hidden="true">
          {canReveal ? (
            <button
              type="button"
              tabIndex={-1}
              className="pr-status-card__action project-card__action"
              onClick={() => {
                onDone();
                options.onReveal?.(path, directory.label);
              }}
            >
              <FolderIcon size={13} />
              {options.revealLabel}
            </button>
          ) : null}
          <button
            type="button"
            tabIndex={-1}
            className="pr-status-card__action project-card__action"
            onClick={() => {
              void copyText(path).then(() => {
                setCopied(true);
                window.clearTimeout(copiedTimer.current);
                copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            <CopyIcon size={13} />
            {copied ? "Copied" : "Copy Path"}
          </button>
        </div>
      ) : null}
      <div className="project-card__section" aria-hidden="true">
        <span className="pr-status-card__section-title project-card__section-title">
          New thread on
        </span>
        {unconfigured ? null : (
          <button
            type="button"
            tabIndex={-1}
            className="project-card__target"
            onClick={() => {
              onDone();
              options.onStartLocal(directory);
            }}
          >
            <NewThreadIcon size={14} />
            <span className="project-card__target-name">{options.localLabel}</span>
            {options.localDetail ? (
              <span className="project-card__target-state">{options.localDetail}</span>
            ) : null}
          </button>
        )}
        {peers.map((peer) => (
          <button
            key={peer.instanceId}
            type="button"
            tabIndex={-1}
            className="project-card__target"
            title={peer.shortLabel ? peer.label : undefined}
            onClick={() => {
              onDone();
              options.onStartOnPeer?.(peer.instanceId, directory);
            }}
          >
            <span className="project-card__target-dot" aria-hidden="true" />
            <span className="project-card__target-name">{peer.shortLabel ?? peer.label}</span>
          </button>
        ))}
        {showMore ? (
          <button
            type="button"
            tabIndex={-1}
            className="project-card__target project-card__target--more"
            onClick={(event) => {
              const anchor = event.currentTarget;
              options.onOtherMachines?.(directory, anchor);
              onDone();
            }}
          >
            <span className="project-card__target-dot project-card__target-dot--spacer" aria-hidden="true" />
            <span className="project-card__target-name">Other machines…</span>
          </button>
        ) : null}
      </div>
    </>
  );
}
