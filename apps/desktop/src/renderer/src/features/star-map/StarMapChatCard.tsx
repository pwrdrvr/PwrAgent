import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ThreadContextPanel } from "../thread-detail/ThreadContextPanel";
import type { ContextTabId } from "../thread-detail/context-panels/context-tab";
import {
  buildThreadIdentityKey,
  type CelestialIconId,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { CelestialIcon } from "../../icons";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import {
  CompactComposer,
  type CompactComposerAction,
} from "../composer/CompactComposer";
import { TranscriptList } from "../thread-detail/TranscriptList";
import { useTranscriptWindow } from "../thread-detail/useTranscriptWindow";
import { DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT } from "../../lib/thread-history-limits";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { useThreadSessionState } from "../../lib/useThreadSessionState";
import {
  clampChatCardRect,
  resizeChatCardRect,
  type ChatCardRect,
} from "./star-map-chat-card-geometry";

export type StarMapChatCardProps = {
  cardKey: string;
  desktopApi?: DesktopApi;
  /** Owning instance's celestial mark, watermarked behind the header. */
  instanceIcon?: CelestialIconId;
  instanceLabel?: string;
  onClose: (cardKey: string) => void;
  /** Escape hatch into the full thread surface. */
  onOpenFull: (thread: NavigationThreadSummary) => void;
  onRaise: (cardKey: string) => void;
  onRectChange: (cardKey: string, rect: ChatCardRect) => void;
  rect: ChatCardRect;
  /**
   * Canvas scale. The card lives IN the map, so a pointer that travels N
   * screen pixels crosses N / scale canvas pixels — without this the card
   * outruns the cursor exactly the way a zoomed thread card used to.
   */
  scale: number;
  /** Canvas extent the card is kept inside, in canvas pixels. */
  bounds: { width: number; height: number };
  thread: NavigationThreadSummary;
  /** Stack position; the host owns the order, we only read our depth. */
  zIndex: number;
};

/**
 * How much wider a card gets while its context rail is open. Matches
 * `RAIL_MIN_WIDTH` in ThreadContextPanel, so the rail renders at its own
 * minimum rather than being squeezed below it.
 */
export const STAR_MAP_CHAT_CARD_RAIL_WIDTH = 300;

type DragState = {
  kind: "move" | "resize";
  pointerId: number;
  originX: number;
  originY: number;
  startRect: ChatCardRect;
};

/**
 * One chat card, anchored in the star map.
 *
 * The card owns its own thread session rather than borrowing App's single
 * mounted ThreadView: that is what lets several cards be open at once, and
 * it is also what makes remote threads work without pinning them. The
 * session hook derives the federation target from the thread summary it is
 * handed, so a card over a peer's thread reads and writes on that peer.
 */
export function StarMapChatCard(props: StarMapChatCardProps) {
  const { bounds, cardKey, desktopApi, onOpenFull, onRaise, onRectChange, rect, scale, thread } =
    props;
  const dragRef = useRef<DragState | undefined>(undefined);
  /**
   * The context rail, opened from the title bar.
   *
   * View-local rather than synced: which tab you are reading is a "what am
   * I looking at" gesture, the same call the map makes for cloud expansion
   * and selection.
   */
  const [railTab, setRailTab] = useState<ContextTabId | undefined>(undefined);
  // Read by callbacks that must not re-bind on every pointermove.
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const railOpen = railTab !== undefined;
  const [sendError, setSendError] = useState<string | undefined>(undefined);
  // The card is draggable and clipped; a native `title` fights both, and
  // UI-THEME.md rules it out regardless.
  const titleTooltip = useViewportTooltip({ className: "viewport-tooltip" });

  // Without a limit `readThread` returns the thread from its first message.
  // On a large thread that is the entire transcript — hundreds of MB over
  // the bridge before the card can paint. The main window has always asked
  // for the last few turns and scrolled back on demand; so does this.
  const session = useThreadSessionState({
    desktopApi,
    initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
    thread,
  });

  // Cap what actually mounts. Same window the full thread view uses, so a
  // card over a long thread holds tens of entries rather than thousands.
  const transcriptWindow = useTranscriptWindow({
    entries: session.entries,
    limit: session.renderedTranscriptEntryLimit,
    onLimitChange: session.setRenderedTranscriptEntryLimit,
    onLoadOlder: session.loadOlder,
    pagination: session.response?.replay.pagination,
    // The canonical key, not a bare id: an ACP backend's kind ("acp:grok")
    // already contains a colon, so `${source}:${id}` is ambiguous and a
    // bare id is worse. Same key ThreadView keys its window by.
    threadKey: buildThreadIdentityKey(thread.source, thread.id),
  });

  const federationTarget =
    thread.federation?.ref.target ?? readRendererFederationTarget();

  const beginDrag = useCallback(
    (event: ReactPointerEvent, kind: DragState["kind"]) => {
      if (event.button !== 0) return;
      event.preventDefault();
      onRaise(cardKey);
      dragRef.current = {
        kind,
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        startRect: rect,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [cardKey, onRaise, rect],
  );

  const continueDrag = useCallback(
    (event: ReactPointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      // Screen pixels in, canvas pixels out.
      const zoom = scale > 0 ? scale : 1;
      const deltaX = (event.clientX - drag.originX) / zoom;
      const deltaY = (event.clientY - drag.originY) / zoom;
      const next =
        drag.kind === "move"
          ? clampChatCardRect(
              {
                ...drag.startRect,
                left: drag.startRect.left + deltaX,
                top: drag.startRect.top + deltaY,
              },
              bounds,
            )
          : resizeChatCardRect({
              rect: drag.startRect,
              deltaX,
              deltaY,
              viewport: bounds,
            });
      onRectChange(cardKey, next);
    },
    [bounds, cardKey, onRectChange, scale],
  );

  /**
   * Open or close the rail, growing the card by the rail's width rather
   * than taking that width out of the transcript.
   *
   * A 420px card minus a 300px rail leaves 120px of transcript, which is
   * not a chat any more. Growing the card is also what the full thread
   * view does, so the two surfaces read the same — and the new width is
   * clamped to the canvas, so a card near the edge cannot grow off it.
   */
  const toggleRail = useCallback(() => {
    // The width change is a side effect, so it stays OUT of the state
    // updater: React may invoke an updater more than once for the same
    // click, which would grow the card twice for one press.
    const opening = railTab === undefined;
    setRailTab(opening ? "info" : undefined);
    onRectChange(
      cardKey,
      clampChatCardRect(
        {
          ...rectRef.current,
          width:
            rectRef.current.width
            + (opening
              ? STAR_MAP_CHAT_CARD_RAIL_WIDTH
              : -STAR_MAP_CHAT_CARD_RAIL_WIDTH),
        },
        bounds,
      ),
    );
  }, [bounds, cardKey, onRectChange, railTab]);

  const endDrag = useCallback((event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  // No window-resize clamp: the card is anchored in the map, not in the
  // window. Resizing the window changes what part of the galaxy is on
  // screen, which is a pan, not a reason to move a card off its spot.
  //
  // The CANVAS shrinking is a different matter. Archiving no longer
  // shrinks it (cloud extents are carried forward), but switching lens or
  // hiding offline instances still can, and the view clamps to the canvas
  // — so a card left outside the new bounds would be unreachable. Read
  // through a ref so this fires on a bounds change and not on every frame
  // of a drag.
  useEffect(() => {
    const clamped = clampChatCardRect(rectRef.current, {
      width: bounds.width,
      height: bounds.height,
    });
    if (
      clamped.left !== rectRef.current.left
      || clamped.top !== rectRef.current.top
      || clamped.width !== rectRef.current.width
      || clamped.height !== rectRef.current.height
    ) {
      onRectChange(cardKey, clamped);
    }
  }, [bounds.width, bounds.height, cardKey, onRectChange]);

  /**
   * Returns whether the turn actually reached the backend. A peer can drop
   * mid-send, and when it does the operator must get their text back and
   * the transcript must not keep an optimistic message for a turn that
   * never started.
   */
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (!desktopApi?.startTurn) return false;
      setSendError(undefined);
      const optimisticId = session.addOptimisticUserMessage(text);
      try {
        await desktopApi.startTurn({
          backend: thread.source,
          federationTarget,
          threadId: thread.id,
          input: [{ type: "text", text }],
        });
        return true;
      } catch (error) {
        session.removeOptimisticMessage(optimisticId);
        setSendError(
          error instanceof Error
            ? error.message
            : "Could not send that message.",
        );
        return false;
      }
    },
    [desktopApi, federationTarget, session, thread],
  );

  const activeTurnId = session.activeTurnId;
  const interrupt = useCallback(async () => {
    if (!desktopApi?.interruptTurn || !activeTurnId) return;
    try {
      await desktopApi.interruptTurn({
        backend: thread.source,
        federationTarget,
        threadId: thread.id,
        turnId: activeTurnId,
      });
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "Could not interrupt the turn.",
      );
    }
  }, [activeTurnId, desktopApi, federationTarget, thread]);

  /**
   * Everything the card can do with only a thread summary and the desktop
   * bridge. Anything needing the backend list, skills, or launchpad state
   * lives behind the header's Open button in the full thread view.
   */
  const secondaryActions = useMemo<CompactComposerAction[]>(() => {
    const entries: CompactComposerAction[] = [];
    const nextMode =
      thread.executionMode === "full-access" ? "default" : "full-access";
    if (desktopApi?.setThreadExecutionMode) {
      entries.push({
        key: "execution-mode",
        label:
          nextMode === "full-access"
            ? "Switch to full access"
            : "Switch to default access",
        onSelect: () => {
          void desktopApi
            .setThreadExecutionMode?.({
              backend: thread.source,
              executionMode: nextMode,
              federationTarget,
              threadId: thread.id,
            })
            .catch((error: unknown) => {
              setSendError(
                error instanceof Error
                  ? error.message
                  : "Could not change access mode.",
              );
            });
        },
      });
    }
    if (desktopApi?.compactThread) {
      entries.push({
        key: "compact",
        // Compaction rewrites history mid-turn, so gate it on an idle
        // thread the same way the full composer's /compact does.
        disabled: session.threadBusy,
        label: "Compact thread",
        onSelect: () => {
          void desktopApi
            .compactThread?.({
              backend: thread.source,
              federationTarget,
              threadId: thread.id,
            })
            .catch((error: unknown) => {
              setSendError(
                error instanceof Error
                  ? error.message
                  : "Could not compact the thread.",
              );
            });
        },
      });
    }
    entries.push({
      key: "open-full",
      label: "Open in full view",
      onSelect: () => onOpenFull(thread),
    });
    return entries;
  }, [desktopApi, federationTarget, onOpenFull, session.threadBusy, thread]);

  const style: CSSProperties = {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    zIndex: props.zIndex,
  };

  return (
    <section
      aria-label={`Chat: ${thread.title}`}
      className="star-map-chat-card"
      onPointerDown={() => onRaise(cardKey)}
      style={style}
    >
      <header
        className="star-map-chat-card__bar"
        onPointerDown={(event) => beginDrag(event, "move")}
        onPointerMove={continueDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {props.instanceIcon ? (
          <span className="star-map-chat-card__watermark" aria-hidden="true">
            <CelestialIcon icon={props.instanceIcon} size={72} />
          </span>
        ) : null}
        <span
          className="star-map-chat-card__title"
          onMouseEnter={(event) =>
            titleTooltip.show(event.currentTarget, thread.title)
          }
          onMouseLeave={titleTooltip.hide}
        >
          {thread.title}
        </span>
        {props.instanceLabel ? (
          <span className="star-map-chat-card__instance">
            {props.instanceLabel}
          </span>
        ) : undefined}
        <button
          aria-expanded={railOpen}
          aria-label={
            railOpen
              ? `Hide thread context for ${thread.title}`
              : `Show thread context for ${thread.title}`
          }
          className={`star-map-chat-card__rail-toggle${
            railOpen ? " is-on" : ""
          }`}
          onClick={() => toggleRail()}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          ⌸
        </button>
        <button
          aria-label={`Open ${thread.title} in the full thread view`}
          className="star-map-chat-card__expand"
          onClick={() => onOpenFull(thread)}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          Open
        </button>
        <button
          aria-label={`Close chat: ${thread.title}`}
          className="star-map-chat-card__close"
          onClick={() => props.onClose(cardKey)}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          ×
        </button>
      </header>

      {railOpen ? (
        // The rail anchors itself to the nearest positioned ancestor, which
        // inside a card is the card — so it lands on the card's right edge,
        // full height, exactly as it does against the thread view's layout.
        // `pinned` because a card has no hover-reveal gutter to peek from.
        <ThreadContextPanel
          activeTab={railTab}
          backends={[]}
          desktopApi={desktopApi}
          onActiveTabChange={setRailTab}
          pinned
          thread={thread}
          width={STAR_MAP_CHAT_CARD_RAIL_WIDTH}
        />
      ) : null}
      <div
        className={`star-map-chat-card__transcript${
          railOpen ? " star-map-chat-card__transcript--railed" : ""
        }`}
      >
        <TranscriptList
          activeTurnId={session.activeTurnId}
          activeTurnStartedAt={session.activeTurnStartedAt}
          desktopApi={desktopApi}
          entries={transcriptWindow.visibleEntries}
          error={session.error}
          loading={session.loading}
          loadingMore={session.loadingMore}
          onLoadOlder={transcriptWindow.loadOlder}
          pagination={transcriptWindow.visiblePagination}
          parentThreadId={thread.id}
          pendingAssistantMessage={session.pendingAssistantMessage}
          pendingMcpInteraction={session.pendingMcpInteraction}
          pendingRequest={session.pendingRequest}
          pendingStatusText={session.pendingStatusText}
          pendingUserInput={session.pendingUserInput}
          runningTurnUsageText={session.runningTurnUsageText}
          threadId={thread.id}
          transientMessages={session.transientMessages}
        />
      </div>

      {sendError ? (
        <p className="star-map-chat-card__error" role="alert">
          {sendError}
        </p>
      ) : undefined}

      <CompactComposer
        busy={session.threadBusy}
        executionMode={thread.executionMode}
        model={thread.model}
        onInterrupt={() => void interrupt()}
        onSend={send}
        reasoningEffort={thread.reasoningEffort}
        secondaryActions={secondaryActions}
        threadTitle={thread.title}
      />

      {titleTooltip.tooltipNode}
      <span
        aria-hidden="true"
        className="star-map-chat-card__resize"
        onPointerDown={(event) => beginDrag(event, "resize")}
        onPointerMove={continueDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </section>
  );
}
