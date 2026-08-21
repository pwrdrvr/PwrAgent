import {
  memo,
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
  isRemoteFederationTarget,
  type CelestialIconId,
  type NavigationLaunchpadFileAttachment,
  type NavigationLaunchpadImageAttachment,
  type NavigationThreadSummary,
  type ThreadExecutionMode,
} from "@pwragent/shared";
import { CelestialIcon } from "../../icons";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { formatBackendLabel } from "../../lib/backend-label";
import { buildDirectoryReferenceMarkdown } from "../../lib/directory-references";
import { useBackendSummaries } from "../../lib/useBackendSummaries";
import { useExecutionModeSelection } from "../../lib/useExecutionModeSelection";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import {
  CompactComposer,
  type CompactComposerAction,
  type CompactComposerSettingsMenu,
} from "../composer/CompactComposer";
import { useComposerMentionSources } from "../composer/useComposerMentionSources";
import type { ComposerMentionSources } from "../composer/useComposerMentions";
import { TranscriptList } from "../thread-detail/TranscriptList";
import { ActiveSubAgentsStrip } from "../thread-detail/ActiveSubAgentsStrip";
import { useTranscriptWindow } from "../thread-detail/useTranscriptWindow";
import { collectEditedFileGroups } from "../thread-detail/edited-file-groups";
import { DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT } from "../../lib/thread-history-limits";
import type { DesktopApi } from "../../lib/desktop-api";
import { parseReviewCommand } from "../../../../shared/review-command";
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
import {
  StarMapReviewSetup,
  type StarMapReviewRequest,
} from "./StarMapReviewSetup";

export type StarMapChatCardProps = {
  cardKey: string;
  desktopApi?: DesktopApi;
  /** Owning instance's celestial mark, watermarked behind the header. */
  instanceIcon?: CelestialIconId;
  instanceLabel?: string;
  onClose: (cardKey: string) => void;
  /** Escape hatch into the full thread surface. */
  onOpenFull: (thread: NavigationThreadSummary) => void;
  /** Refresh the owning navigation feed after a monitor is stopped. */
  onRefreshNavigation?: () => Promise<void>;
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
  pastedImageMaxPatches?: number;
};

type DragState = {
  kind: "move" | "resize";
  pointerId: number;
  originX: number;
  originY: number;
  startRect: ChatCardRect;
};

/**
 * The composer, behind a memo boundary.
 *
 * The card re-renders once per streamed delta — Codex emits fixed 8 KiB
 * chunks at roughly 444 a second — because that is what the transcript is
 * for. The composer's own state almost never moves during a turn, so
 * dragging it through the same renders is pure waste, multiplied by every
 * card the map has open.
 *
 * The boundary lives here rather than inside `CompactComposer` because it
 * only pays off while this host keeps the props it passes referentially
 * stable, and those two facts should be reviewable together. Everything
 * below that feeds it is memoized or ref-read for exactly that reason.
 * `star-map-chat-card-render-cost.test.tsx` pins the result.
 */
const MemoizedCompactComposer = memo(CompactComposer);
const MemoizedActiveSubAgentsStrip = memo(ActiveSubAgentsStrip);

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
  const [attachmentError, setAttachmentError] = useState<string | undefined>(
    undefined,
  );
  const [reviewSetupOpen, setReviewSetupOpen] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | undefined>(undefined);
  const [reviewComposerKey, setReviewComposerKey] = useState(0);
  // Where a mid-turn send actually landed. The operator cannot tell a steer
  // from a queue by looking at the transcript, and the answer differs by
  // backend, so the card says which one happened.
  const [sendNotice, setSendNotice] = useState<string | undefined>(undefined);
  const onAttachmentError = useCallback((message?: string): void => {
    setAttachmentError(message);
    if (message) {
      // One card-local feedback slot: the newest actionable problem wins.
      setSendError(undefined);
      setSendNotice(undefined);
    }
  }, []);
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
  // The session is a fresh object literal on every render of a hook that
  // re-renders per streamed delta, so any callback that closes over it
  // rebinds at streaming rate. `send` reads three of its members and needs
  // them current at call time, not at bind time — which is what a ref gives
  // — so it reads through here and depends on scalars instead.
  const sessionRef = useRef(session);
  sessionRef.current = session;

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

  // Backend capability belongs to the instance the thread lives on. Reduce
  // the target to its stable identity before rebuilding the object: every
  // navigation poll replaces `thread.federation.ref.target`, and handing that
  // fresh object to `useBackendSummaries` would eagerly describe the remote
  // backend again for every open card on every poll.
  const threadFederationTarget = thread.federation?.ref.target;
  const remoteInstanceId = useMemo(() => {
    const target = threadFederationTarget ?? readRendererFederationTarget();
    return target && isRemoteFederationTarget(target)
      ? target.instanceId
      : undefined;
  }, [threadFederationTarget]);
  const federationTarget = useMemo(
    () =>
      remoteInstanceId
        ? ({ scope: "remote", instanceId: remoteInstanceId } as const)
        : undefined,
    [remoteInstanceId],
  );
  const isAcpThread = thread.source.startsWith("acp:");
  const backendSummaries = useBackendSummaries(desktopApi, {
    // The composer needs model/runtime image capability before its first
    // paste or drop. Keep this target-scoped so a remote card reads the
    // owning peer's provider summary rather than the viewer's.
    federationTarget,
  });
  const backendSummariesRef = useRef(backendSummaries);
  backendSummariesRef.current = backendSummaries;
  const onSettingsMenuOpen = useCallback(() => {
    // A failed describe retries on the next open through the hook's
    // exported refresh path (a plain re-list for remote targets).
    if (backendSummariesRef.current.error) {
      void backendSummariesRef.current.refreshAcpAgents();
    }
  }, []);
  const backendSummary = backendSummaries.backends.find(
    (entry) => entry.kind === thread.source,
  );
  const supportsReview =
    !isAcpThread || backendSummary?.capabilities.startReview === true;

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
  const ensureNavigationLoaded = navigationSources.ensureLoaded;
  const mentionSources = useMemo<ComposerMentionSources>(
    () => ({
      commands: [
        ...(supportsReview
          ? [
              {
                name: "review",
                description:
                  "Review current staged, unstaged, and untracked changes",
                requiresNoAttachments: true,
                sourceLabel: "PwrAgent",
              },
            ]
          : []),
        ...threadSkills.providerCommands.map((command) => {
          const commandBackend = command.backend ?? thread.source;
          const commandName = command.name.startsWith("/")
            ? command.name.slice(1)
            : command.name;
          return {
            aliases: command.aliases,
            description: command.description,
            name: command.name,
            // Codex compaction is a client action. ACP commands remain
            // ordinary prompt content and may accompany attachments.
            requiresNoAttachments:
              commandBackend === "codex" && commandName === "compact",
            sourceLabel: formatBackendLabel(commandBackend),
          };
        }),
      ],
      currentThreadKey: buildThreadIdentityKey(thread.source, thread.id),
      directories: navigationSources.directories,
      ensureNavigationLoaded,
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
      ensureNavigationLoaded,
      navigationSources.threads,
      supportsReview,
      threadSkills.providerCommands,
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

  const closeReviewSetup = useCallback(() => {
    if (reviewSubmitting) return;
    setReviewError(undefined);
    setReviewSetupOpen(false);
    // The editability transaction can echo Tiptap's pre-disable document
    // after the send path cleared it. Remounting only at this explicit review
    // boundary gives Cancel/Escape the main composer's clean-slate contract
    // without discarding ordinary card drafts on unrelated renders.
    setReviewComposerKey((current) => current + 1);
  }, [reviewSubmitting]);

  const submitReviewSetup = useCallback(
    async (request: StarMapReviewRequest): Promise<void> => {
      if (!supportsReview) {
        setReviewError("Selected backend does not support reviews.");
        return;
      }
      if (sessionRef.current.threadBusy) {
        setReviewError("Cannot start a review while a turn is in progress.");
        return;
      }
      if (!desktopApi?.startReview) {
        setReviewError("Review is not available for this thread.");
        return;
      }
      setReviewError(undefined);
      setReviewSubmitting(true);
      // Match the main review composer: accepting the configured request
      // closes the setup immediately. review/start can spend noticeable time
      // resolving its model, workspace, and managed-child path; keeping the
      // form onscreen until that promise settles makes a real click look dead.
      setReviewSetupOpen(false);
      setReviewComposerKey((current) => current + 1);
      try {
        await desktopApi.startReview({
          backend: thread.source,
          federationTarget,
          threadId: thread.id,
          ...request,
          delivery: "inline",
        });
        setReviewSetupOpen(false);
      } catch (error) {
        setSendError(
          error instanceof Error
            ? error.message
            : "Could not start that review.",
        );
      } finally {
        setReviewSubmitting(false);
      }
    },
    [desktopApi, federationTarget, supportsReview, thread.id, thread.source],
  );

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
    async (
      text: string,
      imageAttachments: NavigationLaunchpadImageAttachment[] = [],
      fileAttachments: NavigationLaunchpadFileAttachment[] = [],
    ): Promise<boolean> => {
      setSendError(undefined);
      setAttachmentError(undefined);
      setSendNotice(undefined);
      const fileReferences = fileAttachments
        .map((attachment) =>
          buildDirectoryReferenceMarkdown({
            label: attachment.label,
            path: attachment.path,
          }),
        )
        .join("\n");
      const displayText = fileReferences
        ? text
          ? `${text}\n\n${fileReferences}`
          : fileReferences
        : text;
      const imageParts = imageAttachments.map((attachment, index) => ({
        alt: attachment.name || `Pasted image ${index + 1}`,
        type: "image" as const,
        url: attachment.url,
      }));
      const input = [
        ...(displayText
          ? [{ type: "text" as const, text: displayText }]
          : []),
        ...imageAttachments.map((attachment) => ({
          name: attachment.name,
          type: "image" as const,
          url: attachment.url,
        })),
        ...fileAttachments.map((attachment) => ({
          name: attachment.label,
          path: attachment.path,
          type: "localFile" as const,
        })),
      ];

      const reviewCommand = supportsReview ? parseReviewCommand(text) : undefined;
      if (reviewCommand) {
        if (imageAttachments.length > 0 || fileAttachments.length > 0) {
          setSendError("/review does not accept attachments.");
          return false;
        }
        if (sessionRef.current.threadBusy) {
          setSendError("Cannot start a review while a turn is in progress.");
          return false;
        }
        if (!desktopApi?.startReview) {
          setSendError("Review is not available for this thread.");
          return false;
        }
        if (text.trim().toLowerCase() === "/review") {
          setReviewError(undefined);
          setReviewSetupOpen(true);
          ensureNavigationLoaded();
          return true;
        }
        try {
          await desktopApi.startReview({
            backend: thread.source,
            federationTarget,
            threadId: thread.id,
            target: reviewCommand.target,
            delivery: "inline",
          });
          return true;
        } catch (error) {
          setSendError(
            error instanceof Error
              ? error.message
              : "Could not start that review.",
          );
          return false;
        }
      }

      if (
        thread.source === "codex"
        && text.trim().toLowerCase() === "/compact"
      ) {
        if (imageAttachments.length > 0 || fileAttachments.length > 0) {
          setSendError("/compact does not accept attachments.");
          return false;
        }
        if (sessionRef.current.threadBusy) {
          setSendError("Cannot compact while a turn is in progress.");
          return false;
        }
        if (!desktopApi?.compactThread) {
          setSendError("Compaction is not available for this thread.");
          return false;
        }
        try {
          await desktopApi.compactThread({
            backend: thread.source,
            federationTarget,
            threadId: thread.id,
          });
          return true;
        } catch (error) {
          setSendError(
            error instanceof Error
              ? error.message
              : "Could not compact the thread.",
          );
          return false;
        }
      }

      if (sessionRef.current.threadBusy) {
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
        const optimisticId = sessionRef.current.addOptimisticUserMessage(
          displayText,
          imageParts,
        );
        try {
          const response = await desktopApi.steerTurn({
            backend: thread.source,
            expectedTurnId: activeTurnId,
            federationTarget,
            input,
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
          sessionRef.current.removeOptimisticMessage(optimisticId);
          setSendError(
            error instanceof Error
              ? error.message
              : "Could not steer that turn.",
          );
          return false;
        }
      }

      if (!desktopApi?.startTurn) return false;
      const optimisticId = sessionRef.current.addOptimisticUserMessage(
        displayText,
        imageParts,
      );
      try {
        await desktopApi.startTurn({
          backend: thread.source,
          federationTarget,
          threadId: thread.id,
          input,
        });
        return true;
      } catch (error) {
        sessionRef.current.removeOptimisticMessage(optimisticId);
        setSendError(
          error instanceof Error
            ? error.message
            : "Could not send that message.",
        );
        return false;
      }
    },
    [
      activeTurnId,
      cardKey,
      desktopApi,
      federationTarget,
      ensureNavigationLoaded,
      supportsReview,
      thread.id,
      thread.source,
    ],
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
  }, [activeTurnId, desktopApi, federationTarget, thread.id, thread.source]);

  // The composer takes a plain `() => void`; an inline arrow here would be
  // a fresh prop on every render and would defeat the memo boundary on its
  // own.
  const onInterrupt = useCallback(() => {
    void interrupt();
  }, [interrupt]);

  /**
   * Backend describe for the settings chip's menu, shared through
   * `useBackendSummaries` so the card follows the app's refresh events and
   * provider-status agent events instead of caching one describe forever.
   * Disabled until the menu first opens — a card the operator only reads
   * never pays for the describe. The hook takes the card's federation
   * target, so a card over a peer's thread lists the peer's models.
   */
  // For callbacks and effects that need the latest summary without taking
  // the whole object as a dependency — the composer's memo boundary rests
  // on its props staying stable across snapshot refreshes.
  const threadRef = useRef(thread);
  threadRef.current = thread;

  /**
   * Optimistic view of the chip's settings between a menu selection and
   * the thread-state bus round-trip. Mirrors the optimistic snapshot patch
   * `useThreadNavigation.setThreadModelSettings` applies, which this
   * surface cannot reach; without it the chip lags a click behind and a
   * second Fast-mode click re-sends the same value instead of toggling.
   * Entries drop as soon as the live summary reflects them, and the whole
   * overlay clears when a mutation fails.
   */
  const [optimisticSettings, setOptimisticSettings] = useState<
    Partial<
      Pick<
        NavigationThreadSummary,
        "executionMode" | "fastMode" | "model" | "reasoningEffort"
      >
    >
  >({});
  const threadId = thread.id;
  const threadSource = thread.source;
  const threadModel = optimisticSettings.model ?? thread.model;
  const threadReasoningEffort =
    optimisticSettings.reasoningEffort ?? thread.reasoningEffort;
  const threadFastMode = optimisticSettings.fastMode ?? thread.fastMode;
  const threadExecutionMode =
    optimisticSettings.executionMode ?? thread.executionMode;
  const modelOptions = backendSummary?.launchpadOptions?.models ?? [];
  const selectedModelOption =
    modelOptions.find((option) => option.id === threadModel)
    ?? modelOptions.find((option) => option.current)
    ?? modelOptions.find((option) => option.supportsReasoning)
    ?? modelOptions[0];
  // Match the full composer: only explicit negative capability signals gate
  // images. An absent summary or undefined field remains backward-compatible
  // and assumes support, including for remote owners on older versions.
  const imagesSupported =
    selectedModelOption?.supportsImage !== false
    && backendSummary?.acp?.runtime?.agentCapabilities?.prompt?.image !== false;
  const imagesUnsupportedLabel =
    selectedModelOption?.label
    ?? threadModel
    ?? backendSummary?.label
    ?? "This mode";
  useEffect(() => {
    if (imagesSupported) {
      setAttachmentError(undefined);
    }
  }, [imagesSupported]);
  useEffect(() => {
    // Via the ref so the effect can key on the four scalar fields alone.
    const summary = threadRef.current;
    setOptimisticSettings((current) => {
      const kept = Object.entries(current).filter(
        ([key, value]) =>
          summary[key as keyof NavigationThreadSummary] !== value,
      );
      return kept.length === Object.keys(current).length
        ? current
        : Object.fromEntries(kept);
    });
  }, [
    thread.executionMode,
    thread.fastMode,
    thread.model,
    thread.reasoningEffort,
  ]);

  /**
   * Escalating a thread to Full Access goes through the shared gate
   * rather than straight to `setThreadExecutionMode`. The confirmation
   * used to be composer-local state, which made this chip a one-click,
   * un-gated escalation. This window carries no settings state of its
   * own, so the gate reads the dismissed-forever preference itself.
   */
  const applyExecutionMode = useCallback(
    (executionMode: ThreadExecutionMode): void => {
      const setExecutionMode = desktopApi?.setThreadExecutionMode;
      if (!setExecutionMode) return;
      setOptimisticSettings((current) => ({
        ...current,
        executionMode,
      }));
      void setExecutionMode({
        backend: threadSource,
        executionMode,
        federationTarget,
        threadId,
      }).catch((error: unknown) => {
        setOptimisticSettings({});
        setSendError(
          error instanceof Error
            ? error.message
            : "Could not change access mode.",
        );
      });
    },
    [desktopApi, federationTarget, threadId, threadSource],
  );
  const { fullAccessRiskDialog, requestExecutionModeSelection } =
    useExecutionModeSelection({
      applyExecutionMode,
      // The optimistic value, so a second click while the first
      // escalation round-trips does not re-prompt.
      currentExecutionMode: threadExecutionMode,
      desktopApi,
    });

  /**
   * The settings chip's menu: the same mutations the full composer's chip
   * row drives, minus what a floating card cannot honestly host (workspace
   * handoff and environments need the handoff dialog and launchpad state —
   * those stay behind Open in full view).
   *
   * Deliberately delta-stable: nothing here reads the streaming session,
   * and the deps are scalars, so the memo boundary on the composer holds
   * through a running turn and across snapshot refreshes.
   */
  const settingsMenu = useMemo<CompactComposerSettingsMenu | undefined>(() => {
    if (!desktopApi) return undefined;
    const setModelSettings = desktopApi.setThreadModelSettings;
    const setExecutionMode = desktopApi.setThreadExecutionMode;
    const patchModelSettings = (
      patch: Partial<
        Pick<NavigationThreadSummary, "model" | "reasoningEffort" | "fastMode">
      >,
    ) => {
      if (!setModelSettings) return;
      setOptimisticSettings((current) => ({
        ...current,
        ...("model" in patch && patch.model !== undefined
          ? { model: patch.model }
          : {}),
        ...("reasoningEffort" in patch && patch.reasoningEffort !== undefined
          ? { reasoningEffort: patch.reasoningEffort }
          : {}),
        ...("fastMode" in patch && patch.fastMode !== undefined
          ? { fastMode: patch.fastMode }
          : {}),
      }));
      // Same request construction as useThreadNavigation's
      // setThreadModelSettings: carry the current model when the patch does
      // not name one, and only send fastMode for Codex threads. The carried
      // model is the optimistic one, so a reasoning or fast change made
      // before a model change round-trips cannot revert the model.
      void setModelSettings({
        backend: threadSource,
        federationTarget,
        threadId,
        ...("model" in patch
          ? { model: patch.model }
          : threadModel
            ? { model: threadModel }
            : {}),
        ...("reasoningEffort" in patch
          ? { reasoningEffort: patch.reasoningEffort }
          : {}),
        ...(threadSource === "codex" && "fastMode" in patch
          ? { fastMode: patch.fastMode }
          : {}),
      }).catch((error: unknown) => {
        setOptimisticSettings({});
        setSendError(
          error instanceof Error
            ? error.message
            : "Could not change model settings.",
        );
      });
    };
    const launchpadOptions = backendSummary?.launchpadOptions;
    const models = launchpadOptions?.models;
    const currentModelOption = models?.find(
      (option) => option.id === threadModel,
    );
    const reasoningEfforts =
      currentModelOption?.reasoningEfforts
      ?? launchpadOptions?.reasoningEfforts
      ?? [];
    const supportsReasoning =
      currentModelOption?.supportsReasoning
      ?? Boolean(launchpadOptions?.reasoningEfforts?.length);
    const supportsFast =
      threadSource === "codex"
        ? currentModelOption?.supportsFast
          ?? launchpadOptions?.supportsFastMode
          ?? false
        : false;
    // Only the modes the backend actually describes as available — the
    // same filter the full composer applies, so an ACP thread with no
    // approval-mode support is never offered a Full access row.
    const availableExecutionModes = backendSummary?.executionModes
      .filter((mode) => mode.available)
      .map((mode) => ({
        label: formatExecutionModeLabel(mode.mode),
        mode: mode.mode,
      }));
    return {
      loading: Boolean(desktopApi.listBackends) && !backendSummaries.loaded,
      loadFailed: Boolean(backendSummaries.error),
      onOpen: onSettingsMenuOpen,
      executionModes: setExecutionMode ? availableExecutionModes : undefined,
      models: models?.map((option) => ({
        id: option.id,
        label: option.label,
      })),
      reasoningEfforts: supportsReasoning ? reasoningEfforts : [],
      supportsFastMode: supportsFast,
      // The gate decides between prompting and applying; the apply half
      // is `applyExecutionMode` above.
      onSelectExecutionMode: setExecutionMode
        ? requestExecutionModeSelection
        : undefined,
      onSelectModel: setModelSettings
        ? (model) => {
            // Mirror the full composer's model change: a model that cannot
            // reason clears the effort, one that cannot go fast clears fast.
            const nextOption = models?.find((option) => option.id === model);
            const nextSupportsReasoning =
              nextOption?.supportsReasoning
              ?? Boolean(launchpadOptions?.reasoningEfforts?.length);
            const nextSupportsFast =
              threadSource === "codex"
                ? nextOption?.supportsFast
                  ?? launchpadOptions?.supportsFastMode
                  ?? false
                : false;
            patchModelSettings({
              model,
              ...(nextSupportsReasoning ? {} : { reasoningEffort: undefined }),
              ...(nextSupportsFast ? {} : { fastMode: undefined }),
            });
          }
        : undefined,
      onSelectReasoningEffort: setModelSettings
        ? (reasoningEffort) => patchModelSettings({ reasoningEffort })
        : undefined,
      onToggleFastMode:
        setModelSettings && threadSource === "codex"
          ? (enabled) => patchModelSettings({ fastMode: enabled })
          : undefined,
    };
  }, [
    backendSummaries.error,
    backendSummaries.loaded,
    backendSummary,
    desktopApi,
    federationTarget,
    onSettingsMenuOpen,
    requestExecutionModeSelection,
    threadId,
    threadModel,
    threadSource,
  ]);

  /**
   * Plain actions at the bottom of the settings chip's menu. Anything
   * needing skills or launchpad state lives behind the header's Open button
   * in the full thread view.
   */
  const secondaryActions = useMemo<CompactComposerAction[]>(() => {
    const entries: CompactComposerAction[] = [];
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
              backend: threadSource,
              federationTarget,
              threadId,
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
      // Via the ref so a snapshot refresh does not re-mint the actions and
      // re-render the memoized composer.
      onSelect: () => onOpenFull(threadRef.current),
    });
    return entries;
  }, [
    desktopApi,
    federationTarget,
    onOpenFull,
    session.threadBusy,
    threadId,
    threadSource,
  ]);

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

      <div className="star-map-chat-card__body">
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

        <MemoizedActiveSubAgentsStrip
          desktopApi={desktopApi}
          onRefreshNavigation={props.onRefreshNavigation}
          thread={thread}
        />

        {sendError || attachmentError ? (
          <p className="star-map-chat-card__error" role="alert">
            {sendError ?? attachmentError}
          </p>
        ) : sendNotice ? (
          <p className="star-map-chat-card__notice" role="status">
            {sendNotice}
          </p>
        ) : undefined}

        <MemoizedCompactComposer
          busy={session.threadBusy}
          canAttachLocalFiles={
            !federationTarget || !isRemoteFederationTarget(federationTarget)
          }
          canSteer={canSteer}
          disabled={reviewSetupOpen || reviewSubmitting}
          executionMode={threadExecutionMode}
          fastMode={threadFastMode}
          getPathForFile={desktopApi?.getPathForFile}
          imagesSupported={imagesSupported}
          imagesUnsupportedLabel={imagesUnsupportedLabel}
          key={reviewComposerKey}
          mentionSources={mentionSources}
          model={threadModel}
          normalizeImageForUpload={desktopApi?.normalizeImageForUpload}
          onAttachmentError={onAttachmentError}
          onInterrupt={onInterrupt}
          onSend={send}
          pastedImageMaxPatches={props.pastedImageMaxPatches}
          reasoningEffort={threadReasoningEffort}
          secondaryActions={secondaryActions}
          settingsMenu={settingsMenu}
          threadTitle={thread.title}
        />

        {reviewSetupOpen ? (
          <StarMapReviewSetup
            busy={session.threadBusy}
            directories={navigationSources.directories}
            error={reviewError}
            onCancel={closeReviewSetup}
            onSubmit={submitReviewSetup}
            submitting={reviewSubmitting}
            thread={thread}
          />
        ) : null}
      </div>
      {titleTooltip.tooltipNode}
      {/* Portals to the body, so the card's clip and transform miss it. */}
      {fullAccessRiskDialog}
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
