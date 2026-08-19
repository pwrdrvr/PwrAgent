import { lazy, Suspense, useState, type CSSProperties } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { InstanceChip } from "../federation/InstanceGlyph";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { isRemoteFederationTarget } from "@pwragent/shared";
import { ThreadContextPanel } from "../thread-detail/ThreadContextPanel";
import type { ContextTabId } from "../thread-detail/context-panels/context-tab";
import { useStarMapCardContext } from "./star-map-card-context-store";
import {
  CHAT_CARD_CONTEXT_SPINE_WIDTH,
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
  /** Host chat card's key: the session data the panels need is published
      under it by the card that owns the thread session. */
  cardKey: string;
  desktopApi?: DesktopApi;
  thread: NavigationThreadSummary;
  rect: ChatCardRect;
  zIndex: number;
  onClose: () => void;
  /** The operator's Settings -> Pricing choices. Without them the rail
      falls back to its own defaults, which shows a thread's spend on a
      surface the operator switched off and prices it in the wrong
      currency for a Codex-credits account. */
  pricingDisplayOptions?: { codexCredits: boolean; usd: boolean };
  threadPricingSummaryEnabled?: boolean;
}) {
  const [tab, setTab] = useState<ContextTabId>("info");
  // Pricing rows and edited-file groups come out of the host's thread
  // session. Read from a summary alone, Pricing claimed the thread had no
  // usage at all and Edits claimed it had touched no files, while the full
  // window showed both for the same thread.
  const cardContext = useStarMapCardContext(props.cardKey);
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
          that ancestor, so the rail fills it edge to edge. The panel sizes
          itself from `--context-rail-effective`, which `.thread-view`
          defines in the full app and nothing defines here — left unset it
          fell back to 380px inside a 300px card, overflowing the body and
          reading as a blank strip on the left. Pin it to the width this
          card actually gives the panel: the card minus the tab spine. */}
      <div
        className="star-map-satellite-card__body"
        style={
          {
            "--context-rail-effective": `${
              props.rect.width - CHAT_CARD_CONTEXT_SPINE_WIDTH
            }px`,
          } as CSSProperties
        }
      >
        <ThreadContextPanel
          activeTab={tab}
          activeTurnId={cardContext.activeTurnId}
          backends={[]}
          desktopApi={props.desktopApi}
          editedFileGroups={cardContext.editedFileGroups}
          // The rail is the only edits surface a chat card has: the card
          // composes through CompactComposer and renders no above-composer
          // work rail. Left at the panel's "above" default, the dock toggle
          // came up accent-filled and aria-pressed, claiming a second copy
          // that does not exist on this surface.
          editedFilesDock="sidebar"
          onActiveTabChange={setTab}
          pinned
          pricing={cardContext.pricing}
          pricingDisplayOptions={props.pricingDisplayOptions}
          thread={props.thread}
          threadPricingSummaryEnabled={props.threadPricingSummaryEnabled}
          width={props.rect.width - CHAT_CARD_CONTEXT_SPINE_WIDTH}
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
  /** Map zoom, so a drag on the grip moves the edge under the pointer. */
  scale: number;
  zIndex: number;
  onClose: () => void;
  onHeightChange: (height: number) => void;
}) {
  const thread = props.thread;
  const target = thread.federation?.ref.target ?? readRendererFederationTarget();
  const remote =
    target && isRemoteFederationTarget(target)
      ? {
          target,
          instanceId: target.instanceId,
          instanceLabel: thread.federation?.instanceLabel ?? target.instanceId,
          celestialIcon: thread.federation?.celestialIcon,
        }
      : undefined;
  const primary = thread.linkedDirectories[0];
  const style: CSSProperties = {
    left: `${props.rect.left}px`,
    top: `${props.rect.top}px`,
    width: `${props.rect.width}px`,
    height: `${props.rect.height}px`,
    zIndex: props.zIndex,
  };

  const onHeightChange = props.onHeightChange;
  const resizeBy = (delta: number) => {
    onHeightChange(clampTerminalCardHeight(props.rect.height + delta));
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const startY = event.clientY;
    const startHeight = props.rect.height;
    // The card lives inside the pan/zoom canvas, so a screen pixel is not a
    // card pixel. Same conversion the host card's own resize grip makes.
    const zoom = props.scale > 0 ? props.scale : 1;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientY - startY) / zoom;
      onHeightChange(clampTerminalCardHeight(startHeight + delta));
    };
    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize, { once: true });
    window.addEventListener("pointercancel", stopResize, { once: true });
  };

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      resizeBy(STAR_MAP_TERMINAL_RESIZE_STEP);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      resizeBy(-STAR_MAP_TERMINAL_RESIZE_STEP);
    }
  };

  return (
    <section
      aria-label={`Terminal: ${thread.title}`}
      className="star-map-satellite-card star-map-terminal-card"
      style={style}
    >
      <header className="star-map-satellite-card__bar">
        <span className="star-map-satellite-card__title">Terminal</span>
        {/* The pane's own chip floats over the terminal's top-right corner,
            which inside a card means over the first line of output. The bar
            is where a card says whose shell this is. */}
        {remote ? (
          <InstanceChip
            icon={remote.celestialIcon}
            instanceId={remote.instanceId}
            label={remote.instanceLabel}
          />
        ) : null}
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
            remote={remote}
            chrome="hosted"
            height={
              props.rect.height
              - STAR_MAP_SATELLITE_BAR_HEIGHT
              - STAR_MAP_TERMINAL_GRIP_HEIGHT
            }
            onClose={props.onClose}
            onExit={props.onClose}
          />
        </Suspense>
      </div>
      {/* Bottom edge, not top: the card is pinned under its host, so the
          bottom is the edge that actually moves when the card grows. The
          pane's own handle sat under the title bar and grew the card
          downward when dragged up. */}
      <div
        aria-label={`Resize terminal for ${thread.title}`}
        aria-orientation="horizontal"
        aria-valuemax={terminalCardMaxHeight()}
        aria-valuemin={STAR_MAP_TERMINAL_CARD_MIN_HEIGHT}
        aria-valuenow={Math.round(props.rect.height)}
        className="star-map-terminal-card__grip"
        onKeyDown={handleResizeKeyDown}
        onPointerDown={startResize}
        role="separator"
        tabIndex={0}
      />
    </section>
  );
}

/** Title bar height, shared with the terminal's inner height math. */
export const STAR_MAP_SATELLITE_BAR_HEIGHT = 30;

/** Bottom resize rail, same hit height as the pane's own handle. */
export const STAR_MAP_TERMINAL_GRIP_HEIGHT = 10;

/** Keyboard resize step, matching the pane's own handle. */
const STAR_MAP_TERMINAL_RESIZE_STEP = 16;

/** Default rect height for a fresh terminal card, chrome included. */
export const STAR_MAP_TERMINAL_CARD_HEIGHT =
  CHAT_CARD_TERMINAL_HEIGHT
  + STAR_MAP_SATELLITE_BAR_HEIGHT
  + STAR_MAP_TERMINAL_GRIP_HEIGHT;

export const STAR_MAP_TERMINAL_CARD_MIN_HEIGHT =
  140 + STAR_MAP_SATELLITE_BAR_HEIGHT + STAR_MAP_TERMINAL_GRIP_HEIGHT;

const STAR_MAP_TERMINAL_CARD_MAX_HEIGHT =
  560 + STAR_MAP_SATELLITE_BAR_HEIGHT + STAR_MAP_TERMINAL_GRIP_HEIGHT;

/**
 * Tallest the card may grow right now. Mirrors the pane's own clamp rather
 * than importing it: `IntegratedTerminal` is lazily imported here precisely
 * to keep xterm out of the map's bundle, and a static import for one
 * function would pull the whole module back in.
 */
export function terminalCardMaxHeight(): number {
  const viewportMax =
    typeof window === "undefined"
      ? STAR_MAP_TERMINAL_CARD_MAX_HEIGHT
      : Math.max(
          STAR_MAP_TERMINAL_CARD_MIN_HEIGHT,
          Math.floor(window.innerHeight * 0.68),
        );
  return Math.min(STAR_MAP_TERMINAL_CARD_MAX_HEIGHT, viewportMax);
}

export function clampTerminalCardHeight(value: number): number {
  // The fallback goes through the same bounds as everything else: a short
  // window can put the default above the maximum, and a clamp that can
  // return out of range is worse than useless to its next caller.
  const requested = Number.isFinite(value)
    ? Math.round(value)
    : STAR_MAP_TERMINAL_CARD_HEIGHT;
  return Math.min(
    terminalCardMaxHeight(),
    Math.max(STAR_MAP_TERMINAL_CARD_MIN_HEIGHT, requested),
  );
}
