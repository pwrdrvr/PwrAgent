import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  CelestialIconId,
  NavigationThreadSummary,
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
  thread: NavigationThreadSummary;
  /** Stack position; the host owns the order, we only read our depth. */
  zIndex: number;
};

type DragState = {
  kind: "move" | "resize";
  pointerId: number;
  originX: number;
  originY: number;
  startRect: ChatCardRect;
};

function viewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1440, height: 900 };
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * One floating chat card over the star map.
 *
 * The card owns its own thread session rather than borrowing App's single
 * mounted ThreadView: that is what lets several cards be open at once, and
 * it is also what makes remote threads work without pinning them. The
 * session hook derives the federation target from the thread summary it is
 * handed, so a card over a peer's thread reads and writes on that peer.
 */
export function StarMapChatCard(props: StarMapChatCardProps) {
  const { cardKey, desktopApi, onOpenFull, onRaise, onRectChange, rect, thread } =
    props;
  const dragRef = useRef<DragState | undefined>(undefined);
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
    threadKey: thread.id,
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
      const deltaX = event.clientX - drag.originX;
      const deltaY = event.clientY - drag.originY;
      const viewport = viewportSize();
      const next =
        drag.kind === "move"
          ? clampChatCardRect(
              {
                ...drag.startRect,
                left: drag.startRect.left + deltaX,
                top: drag.startRect.top + deltaY,
              },
              viewport,
            )
          : resizeChatCardRect({
              rect: drag.startRect,
              deltaX,
              deltaY,
              viewport,
            });
      onRectChange(cardKey, next);
    },
    [cardKey, onRectChange],
  );

  const endDrag = useCallback((event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  // A card parked against an edge must stay reachable when the window
  // shrinks under it. The listener reads the current rect through a ref
  // rather than closing over it: `rect` changes on every pointermove, and
  // depending on it here tore the listener down and re-added it on every
  // frame of a drag.
  const rectRef = useRef(rect);
  rectRef.current = rect;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      onRectChange(cardKey, clampChatCardRect(rectRef.current, viewportSize()));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [cardKey, onRectChange]);

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

      <div className="star-map-chat-card__transcript">
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
