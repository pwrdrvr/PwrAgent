import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
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
import { useComposerMentionSources } from "../composer/useComposerMentionSources";
import type { ComposerMentionSources } from "../composer/useComposerMentions";
import { TranscriptList } from "../thread-detail/TranscriptList";
import { useTranscriptWindow } from "../thread-detail/useTranscriptWindow";
import { collectEditedFileGroups } from "../thread-detail/edited-file-groups";
import { DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT } from "../../lib/thread-history-limits";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { useThreadSessionState } from "../../lib/useThreadSessionState";
import { useThreadSkills } from "../../lib/useThreadSkills";
import {
  clearStarMapCardContext,
  publishStarMapCardContext,
  useStarMapCardContextDemand,
} from "./star-map-card-context-store";
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
  /** Satellite cards, docked to this card and owned by the controller. */
  contextOpen?: boolean;
  terminalOpen?: boolean;
  onToggleContext: (cardKey: string) => void;
  onToggleTerminal: (cardKey: string) => void;
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
  // Read by callbacks that must not re-bind on every pointermove.
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const [sendError, setSendError] = useState<string | undefined>(undefined);
  // Where a mid-turn send actually landed. The operator cannot tell a steer
  // from a queue by looking at the transcript, and the answer differs by
  // backend, so the card says which one happened.
  const [sendNotice, setSendNotice] = useState<string | undefined>(undefined);
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

  // The context satellite is a sibling rendered by the screen, so the session
  // data its panels need has to be published rather than passed down.
  //
  // Gated on a live subscriber rather than on `contextOpen`: collecting
  // edited-file groups walks the whole transcript, so a card would otherwise
  // redo it on every streamed entry for a rail nobody can see. The two differ
  // — the map unmounts every satellite at overview zoom without clearing the
  // flag — and the subscriber is the one that answers "is anything reading
  // this?".
  const contextDemand = useStarMapCardContextDemand(cardKey);
  const editedFileGroups = useMemo(
    () =>
      contextDemand
        ? collectEditedFileGroups({
            entries: session.entries,
            activeTurnId: session.activeTurnId,
            forkCreatedAt: thread.forkSourceThreadId
              ? thread.createdAt
              : undefined,
          })
        : undefined,
    [
      contextDemand,
      session.activeTurnId,
      session.entries,
      thread.createdAt,
      thread.forkSourceThreadId,
    ],
  );
  const pricing = session.response?.pricing;
  useEffect(() => {
    if (!contextDemand) return;
    publishStarMapCardContext(cardKey, {
      activeTurnId: session.activeTurnId,
      editedFileGroups,
      pricing,
    });
  }, [cardKey, contextDemand, editedFileGroups, pricing, session.activeTurnId]);
  useEffect(() => () => clearStarMapCardContext(cardKey), [cardKey]);

  /**
   * What the card can honestly offer the composer's mention pickers.
   *
   * Skills are thread-scoped — they come from this thread's linked
   * directories — so they use the same per-thread hook the full thread view
   * does, lazily: nothing is fetched until the operator types `$`.
   * Directories and threads are one local snapshot shared by every open
   * card. Both loads are triggered by the popover opening, so a card the
   * operator only reads costs neither.
   *
   * `#` also reaches peers, through the same federated search the sidebar's
   * jump uses. That matters more here than anywhere: a card on a star map
   * is usually open *because* of another instance.
   */
  const threadSkills = useThreadSkills({ desktopApi, thread });
  const navigationSources = useComposerMentionSources({ desktopApi });
  const ensureSkillsLoaded = threadSkills.ensureLoaded;
  const mentionSources = useMemo<ComposerMentionSources>(
    () => ({
      currentThreadKey: buildThreadIdentityKey(thread.source, thread.id),
      directories: navigationSources.directories,
      ensureNavigationLoaded: navigationSources.ensureLoaded,
      ensureSkillsLoaded: () => {
        void ensureSkillsLoaded();
      },
      searchRemoteThreads: desktopApi?.jumpSearchRemoteThreads,
      skills: threadSkills.skills,
      threads: navigationSources.threads,
    }),
    [
      desktopApi,
      ensureSkillsLoaded,
      navigationSources.directories,
      navigationSources.ensureLoaded,
      navigationSources.threads,
      threadSkills.skills,
      thread.id,
      thread.source,
    ],
  );

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

  // The notice describes a turn ("steered into", "queued for the next"), so
  // it is only true while that turn runs. Left alone it would sit on an idle
  // card for hours claiming something is still in flight.
  const threadBusy = session.threadBusy;
  useEffect(() => {
    if (!threadBusy) setSendNotice(undefined);
  }, [threadBusy]);

  const activeTurnId = session.activeTurnId;
  /**
   * Structural only: whether this bridge can steer at all. Deliberately NOT
   * "and we know which turn to aim at" — that is a moment-to-moment fact,
   * and gating the button on it disables the card's only send control in a
   * state the operator cannot see or get out of. A send that cannot be
   * aimed yet is reported, not silently unavailable.
   *
   * Backends that cannot steer reject the request, so even this is an
   * optimistic gate rather than a capability check; the rejection is
   * reported rather than swallowed.
   */
  const canSteer = Boolean(desktopApi?.steerTurn);

  /**
   * Returns whether the turn actually reached the backend. A peer can drop
   * mid-send, and when it does the operator must get their text back and
   * the transcript must not keep an optimistic message for a turn that
   * never started.
   *
   * While a turn is running this steers instead of starting a new turn.
   * `steerTurn` reports back whether the backend injected the message into
   * the running turn or held it for the next one; either way the operator
   * gets to type during a turn, which starting a second turn would not
   * allow.
   */
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      setSendError(undefined);
      setSendNotice(undefined);

      if (session.threadBusy) {
        if (!desktopApi?.steerTurn) {
          setSendError("This thread is busy and steering is unavailable.");
          return false;
        }
        if (!activeTurnId) {
          // Do NOT fall through to `startTurn` here. A thread can report
          // busy before its turn id is hydrated — a peer's or a messaging
          // adapter's turn does exactly that — and starting a turn in that
          // window is the second-turn-on-a-running-thread this whole branch
          // exists to prevent. The id arrives with the next thread read, so
          // this is worth retrying rather than routing around.
          setSendError(
            "Still identifying the running turn — try again in a moment.",
          );
          return false;
        }
        const optimisticId = session.addOptimisticUserMessage(text);
        try {
          const response = await desktopApi.steerTurn({
            backend: thread.source,
            expectedTurnId: activeTurnId,
            federationTarget,
            input: [{ type: "text", text }],
            // Main dedupes retries by request id, so it has to be fresh per
            // attempt or a corrected resend would return the first result.
            requestId: `star-map-chat-card:${cardKey}:${activeTurnId}:${Date.now()}`,
            threadId: thread.id,
          });
          setSendNotice(
            response.disposition === "queued"
              ? "Queued for the next turn."
              : "Steered into the running turn.",
          );
          return true;
        } catch (error) {
          session.removeOptimisticMessage(optimisticId);
          setSendError(
            error instanceof Error
              ? error.message
              : "Could not steer that turn.",
          );
          return false;
        }
      }

      if (!desktopApi?.startTurn) return false;
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
    [activeTurnId, cardKey, desktopApi, federationTarget, session, thread],
  );

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
          aria-expanded={props.contextOpen ?? false}
          aria-label={
            props.contextOpen
              ? `Hide thread context for ${thread.title}`
              : `Show thread context for ${thread.title}`
          }
          className={`star-map-chat-card__rail-toggle${
            props.contextOpen ? " is-on" : ""
          }`}
          onClick={() => props.onToggleContext(cardKey)}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          ⌸
        </button>
        <button
          aria-expanded={props.terminalOpen ?? false}
          aria-label={
            props.terminalOpen
              ? `Close terminal for ${thread.title}`
              : `Open terminal for ${thread.title}`
          }
          className={`star-map-chat-card__rail-toggle${
            props.terminalOpen ? " is-on" : ""
          }`}
          onClick={() => props.onToggleTerminal(cardKey)}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          &gt;_
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
      ) : sendNotice ? (
        <p className="star-map-chat-card__notice" role="status">
          {sendNotice}
        </p>
      ) : undefined}

      <CompactComposer
        busy={session.threadBusy}
        canSteer={canSteer}
        executionMode={thread.executionMode}
        mentionSources={mentionSources}
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
