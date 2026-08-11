import { lazy, Suspense, useState, type CSSProperties } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { isRemoteFederationTarget } from "@pwragent/shared";
import { ThreadContextPanel } from "../thread-detail/ThreadContextPanel";
import type { ContextTabId } from "../thread-detail/context-panels/context-tab";
import {
  CHAT_CARD_TERMINAL_HEIGHT,
  type ChatCardRect,
} from "./star-map-chat-card-geometry";

// Same lazy split the thread view uses: xterm is heavy and most map
// sessions never open a shell.
const LazyIntegratedTerminal = lazy(async () => {
  const module = await import("../thread-detail/IntegratedTerminal");
  return { default: module.IntegratedTerminal };
});

/**
 * Satellite cards docked to a chat card: the thread context rail as a card
 * on the host's right, and the thread's terminal as a card underneath.
 *
 * Deliberately cards rather than panes inside the host. A pane forced the
 * host to grow, fight over who owned the transcript's width, and reserve a
 * gutter; a satellite just sits next to it. Their rects derive from the
 * host's on every render, which is what makes the group move as one when
 * the host drags — there is no second position to keep in sync.
 */
export function StarMapContextCard(props: {
  desktopApi?: DesktopApi;
  thread: NavigationThreadSummary;
  rect: ChatCardRect;
  zIndex: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ContextTabId>("info");
  const style: CSSProperties = {
    left: `${props.rect.left}px`,
    top: `${props.rect.top}px`,
    width: `${props.rect.width}px`,
    height: `${props.rect.height}px`,
    zIndex: props.zIndex,
  };
  return (
    <section
      aria-label={`Thread context: ${props.thread.title}`}
      className="star-map-satellite-card star-map-context-card"
      style={style}
    >
      <header className="star-map-satellite-card__bar">
        <span className="star-map-satellite-card__title">Context</span>
        <button
          aria-label={`Close thread context for ${props.thread.title}`}
          className="star-map-satellite-card__close"
          onClick={props.onClose}
          type="button"
        >
          ×
        </button>
      </header>
      {/* The rail anchors to its nearest positioned ancestor; this body is
          that ancestor, so the rail fills it edge to edge. */}
      <div className="star-map-satellite-card__body">
        <ThreadContextPanel
          activeTab={tab}
          backends={[]}
          desktopApi={props.desktopApi}
          onActiveTabChange={setTab}
          pinned
          thread={props.thread}
          width={props.rect.width}
        />
      </div>
    </section>
  );
}

export function StarMapTerminalCard(props: {
  desktopApi?: DesktopApi;
  thread: NavigationThreadSummary;
  threadKey: string;
  rect: ChatCardRect;
  zIndex: number;
  onClose: () => void;
  onHeightChange: (height: number) => void;
}) {
  const thread = props.thread;
  const target = thread.federation?.ref.target ?? readRendererFederationTarget();
  const primary = thread.linkedDirectories[0];
  const style: CSSProperties = {
    left: `${props.rect.left}px`,
    top: `${props.rect.top}px`,
    width: `${props.rect.width}px`,
    height: `${props.rect.height}px`,
    zIndex: props.zIndex,
  };
  return (
    <section
      aria-label={`Terminal: ${thread.title}`}
      className="star-map-satellite-card star-map-terminal-card"
      style={style}
    >
      <header className="star-map-satellite-card__bar">
        <span className="star-map-satellite-card__title">Terminal</span>
        <button
          aria-label={`Close terminal for ${thread.title}`}
          className="star-map-satellite-card__close"
          onClick={props.onClose}
          type="button"
        >
          ×
        </button>
      </header>
      <div className="star-map-satellite-card__body">
        <Suspense fallback={null}>
          <LazyIntegratedTerminal
            desktopApi={props.desktopApi}
            threadKey={props.threadKey}
            cwd={primary?.worktreePath ?? primary?.path}
            remote={
              target && isRemoteFederationTarget(target)
                ? {
                    target,
                    instanceId: target.instanceId,
                    instanceLabel:
                      thread.federation?.instanceLabel ?? target.instanceId,
                    celestialIcon: thread.federation?.celestialIcon,
                  }
                : undefined
            }
            height={props.rect.height - STAR_MAP_SATELLITE_BAR_HEIGHT}
            onHeightChange={(height) =>
              props.onHeightChange(height + STAR_MAP_SATELLITE_BAR_HEIGHT)
            }
            onClose={props.onClose}
            onExit={props.onClose}
          />
        </Suspense>
      </div>
    </section>
  );
}

/** Title bar height, shared with the terminal's inner height math. */
export const STAR_MAP_SATELLITE_BAR_HEIGHT = 30;

/** Default rect height for a fresh terminal card, bar included. */
export const STAR_MAP_TERMINAL_CARD_HEIGHT =
  CHAT_CARD_TERMINAL_HEIGHT + STAR_MAP_SATELLITE_BAR_HEIGHT;
