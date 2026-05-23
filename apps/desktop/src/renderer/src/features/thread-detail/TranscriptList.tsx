import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AppServerPendingRequestNotification,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  AppServerThreadMessageEntry,
  AppServerThreadPlanEntry,
  AppServerSkillSummary,
  AppServerThreadReplayPagination,
  DesktopApplicationsSnapshot,
  ThreadMessagingBindingTransition,
  ThreadPermissionTransition,
} from "@pwragent/shared";
import { injectMessagingBindingTransitions } from "./messaging-binding-transition-entries";
import { injectPermissionTransitions } from "./permission-transition-entries";
import type { DesktopApi } from "../../lib/desktop-api";
import { ThinkingScanner } from "./ThinkingScanner";
import { PendingQuestionnaire } from "./PendingQuestionnaire";
import { PendingMcpInteraction } from "./PendingMcpInteraction";
import { TranscriptActivity } from "./TranscriptActivity";
import { ThreadMarkdown } from "./ThreadMarkdown";
import { TranscriptMessage } from "./TranscriptMessage";
import { TranscriptPlan } from "./TranscriptPlan";
import { TranscriptReview } from "./TranscriptReview";
import { TranscriptWorkPhaseGroup } from "./TranscriptWorkPhaseGroup";
import type { PendingQuestionnaireState } from "./questionnaire";
import type { PendingMcpInteractionState } from "./mcp-elicitation";
import { buildTranscriptRenderItems } from "./transcript-render-items";

type TranscriptViewport = {
  distanceFromBottom: number;
  isGluedToBottom?: boolean;
  scrollTop: number;
};

type TranscriptListProps = {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: Pick<DesktopApi, "copyText" | "openApplication">;
  directoryPaths?: string[];
  entries: AppServerThreadEntry[];
  error?: string;
  loading: boolean;
  loadingMore: boolean;
  pendingActivityEntry?: AppServerThreadActivityEntry;
  pendingProtocolActivityEntry?: AppServerThreadActivityEntry;
  pendingAssistantMessage?: AppServerThreadMessageEntry;
  pendingPlanEntry?: AppServerThreadPlanEntry;
  pendingRequest?: AppServerPendingRequestNotification;
  pendingRequestBusy?: boolean;
  pendingMcpInteraction?: PendingMcpInteractionState;
  pendingUserInput?: PendingQuestionnaireState;
  pendingStatusText?: string;
  pagination?: AppServerThreadReplayPagination;
  permissionTransitions?: ThreadPermissionTransition[];
  messagingBindingTransitions?: ThreadMessagingBindingTransition[];
  restoredViewport?: TranscriptViewport;
  reglueRequestKey?: number;
  threadId?: string;
  skills?: AppServerSkillSummary[];
  onOpenImage?: (image: AppServerThreadImagePart) => void;
  onViewportChange?: (viewport?: TranscriptViewport) => void;
  onRespondToPendingRequest?: (decision: "approve" | "decline" | "cancel") => Promise<void>;
  onPendingMcpInteractionChange?: (state: PendingMcpInteractionState) => void;
  onSubmitPendingMcpInteraction?: (
    state: PendingMcpInteractionState,
    action: "accept" | "decline" | "cancel"
  ) => Promise<void>;
  onPendingUserInputChange?: (state: PendingQuestionnaireState) => void;
  onSubmitPendingUserInput?: (state: PendingQuestionnaireState) => Promise<void>;
  onLoadOlder: () => Promise<void>;
};

type ScrollSnapshot = {
  clientHeight: number;
  distanceFromBottom: number;
  firstMessageId?: string;
  itemCount: number;
  lastMessageId?: string;
  pendingStatusText?: string;
  scrollHeight: number;
  scrollTop: number;
  threadId?: string;
};

type SyncScrollStateOptions = {
  preserveGlueOnResize?: boolean;
};

const BOTTOM_THRESHOLD_PX = 24;

function isAssistantFinalMessage(entry: AppServerThreadEntry): boolean {
  return (
    entry.type === "message" &&
    entry.role === "assistant" &&
    entry.phase === "final"
  );
}

function entryCreatedAt(entry: AppServerThreadEntry): number | undefined {
  return typeof entry.createdAt === "number" ? entry.createdAt : undefined;
}

function pendingEntriesInEventOrder(
  entries: Array<AppServerThreadEntry | undefined>
): AppServerThreadEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .filter((item): item is { entry: AppServerThreadEntry; index: number } =>
      Boolean(item.entry)
    )
    .sort((left, right) => {
      const leftCreatedAt = entryCreatedAt(left.entry);
      const rightCreatedAt = entryCreatedAt(right.entry);
      if (
        typeof leftCreatedAt === "number" &&
        typeof rightCreatedAt === "number" &&
        leftCreatedAt !== rightCreatedAt
      ) {
        return leftCreatedAt - rightCreatedAt;
      }

      if (typeof leftCreatedAt === "number" && typeof rightCreatedAt !== "number") {
        return -1;
      }
      if (typeof leftCreatedAt !== "number" && typeof rightCreatedAt === "number") {
        return 1;
      }

      return left.index - right.index;
    })
    .map((item) => item.entry);
}

function insertPendingEntry(
  entries: AppServerThreadEntry[],
  pendingEntry: AppServerThreadEntry | undefined
): void {
  if (!pendingEntry) {
    return;
  }

  const existingIndex = entries.findIndex((entry) => entry.id === pendingEntry.id);
  if (existingIndex >= 0) {
    entries[existingIndex] = pendingEntry;
    return;
  }

  const pendingTurnId = pendingEntry.turn?.id;
  if (!pendingTurnId || isAssistantFinalMessage(pendingEntry)) {
    entries.push(pendingEntry);
    return;
  }

  const pendingCreatedAt = entryCreatedAt(pendingEntry);
  const timedIndex =
    typeof pendingCreatedAt === "number"
      ? entries.findIndex((entry) => {
          const entryCreated = entryCreatedAt(entry);
          return (
            entry.turn?.id === pendingTurnId &&
            typeof entryCreated === "number" &&
            entryCreated > pendingCreatedAt
          );
        })
      : -1;
  if (timedIndex !== -1) {
    entries.splice(timedIndex, 0, pendingEntry);
    return;
  }

  const finalMessageIndex = entries.findLastIndex((entry) => {
    if (entry.turn?.id !== pendingTurnId || !isAssistantFinalMessage(entry)) {
      return false;
    }

    const finalCreatedAt = entryCreatedAt(entry);
    return (
      typeof pendingCreatedAt !== "number" ||
      typeof finalCreatedAt !== "number"
    );
  });
  if (finalMessageIndex === -1) {
    entries.push(pendingEntry);
    return;
  }

  entries.splice(finalMessageIndex, 0, pendingEntry);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function firstStringByKeys(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function stripShellLauncher(command: string): string {
  const match = command.match(
    /^(?:\/[/\w]*\/)?(?:bash|zsh|sh|dash|ksh|tcsh|fish)\s+-lc\s+(['"])([\s\S]*)\1\s*$/
  );

  return match ? match[2] : command;
}

function markdownCodeBlock(text: string, language: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const longestFence = [...normalized.matchAll(/`{3,}/g)].reduce(
    (max, match) => Math.max(max, match[0].length),
    2
  );
  const fence = "`".repeat(longestFence + 1);
  const languageTag = language.trim();

  return `${fence}${languageTag}\n${normalized}\n${fence}`;
}

function commandFromActions(params: Record<string, unknown>): string {
  const actions = params.commandActions;
  if (!Array.isArray(actions) || actions.length === 0) {
    return "";
  }

  return actions
    .map((action) => {
      const record = asRecord(action);
      const command = record?.command;
      return typeof command === "string" && command.trim() ? command.trim() : undefined;
    })
    .filter((command): command is string => Boolean(command))
    .join(" && ");
}

function approvalDisplayCommand(params: Record<string, unknown>): string {
  const parsedCommand = commandFromActions(params);
  if (parsedCommand) {
    return parsedCommand;
  }

  const rawCommand = firstStringByKeys(params, [
    "command",
    "cmd",
    "displayCommand",
    "rawCommand",
    "shellCommand",
  ]);

  return rawCommand ? stripShellLauncher(rawCommand) : "";
}

function pendingRequestPrompt(request: AppServerPendingRequestNotification): string {
  if (typeof request.params.prompt === "string" && request.params.prompt.trim()) {
    return request.params.prompt.trim();
  }

  const reason = typeof request.params.reason === "string" ? request.params.reason.trim() : "";
  const command = approvalDisplayCommand(request.params);
  const commandBlock = command ? `Command:\n\n${markdownCodeBlock(command, "sh")}` : "";

  if (reason && commandBlock) {
    return `${reason}\n\n${commandBlock}`;
  }
  if (commandBlock) {
    return commandBlock;
  }
  if (reason) {
    return reason;
  }

  return "This turn is waiting for approval before it can continue.";
}

export function TranscriptList(props: TranscriptListProps) {
  const skills = props.skills ?? [];
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef<ScrollSnapshot | undefined>(undefined);
  const savedViewportsRef = useRef(new Map<string, TranscriptViewport>());
  const appliedReglueRequestKeyRef = useRef(0);
  const shouldScrollToBottomRef = useRef(true);
  const isGluedToBottomRef = useRef(true);
  const [hasContentBelow, setHasContentBelow] = useState(false);
  // Top-edge fade visibility (issue #240). The bottom-fade visibility
  // is the inverse of `hasContentBelow` — we already track that to
  // drive the scroll-to-bottom button — so it doesn't get a separate
  // state. `isAtTop` defaults to `true` so the top fade is hidden on
  // first paint (the typical state before any scroll has happened);
  // the post-mount `syncScrollState` corrects it for threads that
  // hydrate at a saved-scroll position other than the top.
  const [isAtTop, setIsAtTop] = useState(true);
  const [expandedCommentaryGroupIds, setExpandedCommentaryGroupIds] = useState(
    () => new Set<string>()
  );
  const [renderNow, setRenderNow] = useState(() => Date.now());
  const canLoadOlder = Boolean(
    props.pagination?.supportsPagination && props.pagination.hasPreviousPage
  );
  const hasPendingContent = Boolean(
    props.pendingActivityEntry ||
      props.pendingProtocolActivityEntry ||
      props.pendingAssistantMessage ||
      props.pendingPlanEntry ||
      props.pendingRequest ||
      props.pendingMcpInteraction ||
      props.pendingUserInput ||
      props.pendingStatusText
  );
  const transcriptEntries = useMemo(() => {
    const entries = [...props.entries];
    for (const pendingEntry of pendingEntriesInEventOrder([
      props.pendingPlanEntry,
      props.pendingActivityEntry,
      props.pendingProtocolActivityEntry,
      props.pendingAssistantMessage,
    ])) {
      insertPendingEntry(entries, pendingEntry);
    }
    return injectMessagingBindingTransitions(
      injectPermissionTransitions(entries, props.permissionTransitions),
      props.messagingBindingTransitions,
    );
  }, [
    props.entries,
    props.pendingActivityEntry,
    props.pendingProtocolActivityEntry,
    props.pendingAssistantMessage,
    props.pendingPlanEntry,
    props.messagingBindingTransitions,
    props.permissionTransitions,
  ]);
  const transcriptRenderItems = useMemo(
    () =>
      buildTranscriptRenderItems({
        entries: transcriptEntries,
        activeTurnId: props.activeTurnId,
        activeTurnStartedAt: props.activeTurnStartedAt,
        activeMessageId: props.pendingAssistantMessage?.id,
        now: renderNow,
      }),
    [
      props.activeTurnId,
      props.activeTurnStartedAt,
      props.pendingAssistantMessage?.id,
      renderNow,
      transcriptEntries,
    ]
  );
  const visibleItemCount =
    transcriptEntries.length +
    (props.pendingStatusText ? 1 : 0) +
    (props.pendingRequest ? 1 : 0) +
    (props.pendingMcpInteraction ? 1 : 0) +
    (props.pendingUserInput ? 1 : 0);
  const hasTranscriptContent = transcriptEntries.length > 0;
  useEffect(() => {
    setExpandedCommentaryGroupIds(new Set());
  }, [props.threadId]);

  useEffect(() => {
    if (!props.activeTurnId) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      setRenderNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, [props.activeTurnId]);

  const toggleCommentaryGroup = useCallback((groupId: string) => {
    setExpandedCommentaryGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const captureSnapshot = useCallback((): ScrollSnapshot | undefined => {
    const container = scrollContainerRef.current;
    if (!container) {
      return undefined;
    }

    const firstMessageId = transcriptEntries[0]?.id;
    const lastMessageId = transcriptEntries[transcriptEntries.length - 1]?.id;
    const distanceFromBottom = Math.max(
      container.scrollHeight - container.clientHeight - container.scrollTop,
      0
    );

    return {
      clientHeight: container.clientHeight,
      distanceFromBottom,
      firstMessageId,
      itemCount: visibleItemCount,
      lastMessageId,
      pendingStatusText: props.pendingStatusText,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      threadId: props.threadId
    };
  }, [
    props.pendingRequest,
    props.pendingMcpInteraction,
    props.pendingUserInput,
    props.pendingStatusText,
    props.threadId,
    transcriptEntries,
    visibleItemCount
  ]);

  const syncScrollState = useCallback((options?: SyncScrollStateOptions) => {
    let snapshot = captureSnapshot();
    const previousSnapshot = snapshotRef.current;
    const wasGluedToBottom =
      isGluedToBottomRef.current ||
      Boolean(previousSnapshot && previousSnapshot.distanceFromBottom <= BOTTOM_THRESHOLD_PX);
    const resizedWhileBottomPinned = Boolean(
      options?.preserveGlueOnResize &&
        snapshot &&
        previousSnapshot &&
        wasGluedToBottom &&
        snapshot.distanceFromBottom > BOTTOM_THRESHOLD_PX &&
        snapshot.scrollTop === previousSnapshot.scrollTop &&
        (snapshot.clientHeight !== previousSnapshot.clientHeight ||
          snapshot.scrollHeight !== previousSnapshot.scrollHeight)
    );

    if (resizedWhileBottomPinned) {
      const container = scrollContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
        snapshot = captureSnapshot();
      }
    }

    snapshotRef.current = snapshot;
    const isAtBottom = Boolean(snapshot && snapshot.distanceFromBottom <= BOTTOM_THRESHOLD_PX);
    if (isAtBottom) {
      isGluedToBottomRef.current = true;
    } else {
      isGluedToBottomRef.current = false;
    }
    setHasContentBelow(Boolean(snapshot && !isAtBottom));
    setIsAtTop(Boolean(snapshot && snapshot.scrollTop <= 0));
    if (snapshot?.threadId) {
      savedViewportsRef.current.set(snapshot.threadId, {
        distanceFromBottom: snapshot.distanceFromBottom,
        isGluedToBottom: isGluedToBottomRef.current,
        scrollTop: snapshot.scrollTop,
      });
    }
  }, [captureSnapshot]);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    // Mark glued BEFORE issuing the scroll command so the
    // ResizeObserver and onScroll callbacks that fire during /
    // immediately after the scroll treat any concurrent layout shift
    // as "stay pinned" rather than "user navigated away from the
    // bottom."
    isGluedToBottomRef.current = true;
    container.scrollTop = container.scrollHeight;
    syncScrollState();

    // If the transcript's scrollHeight grows between this layout commit
    // and the next paint (e.g. ThreadMarkdown finishing layout, a lazy
    // image committing its intrinsic height), re-anchor on the next
    // animation frame so the user lands at the actual latest message
    // rather than the latest message at the moment scrollToBottom was
    // first called.
    requestAnimationFrame(() => {
      if (!isGluedToBottomRef.current) {
        return;
      }
      const liveContainer = scrollContainerRef.current;
      if (!liveContainer) {
        return;
      }
      const maxScrollTop = Math.max(
        liveContainer.scrollHeight - liveContainer.clientHeight,
        0
      );
      if (liveContainer.scrollTop < maxScrollTop - BOTTOM_THRESHOLD_PX) {
        liveContainer.scrollTop = liveContainer.scrollHeight;
        syncScrollState();
      }
    });
  }, [syncScrollState]);

  const disableBottomGlue = useCallback(() => {
    isGluedToBottomRef.current = false;
  }, []);

  useEffect(() => {
    if (props.loading && !hasTranscriptContent) {
      shouldScrollToBottomRef.current = true;
    }
  }, [hasTranscriptContent, props.loading]);

  useEffect(() => {
    if (typeof props.reglueRequestKey !== "number" || props.reglueRequestKey <= 0) {
      return;
    }
    if (appliedReglueRequestKeyRef.current === props.reglueRequestKey) {
      return;
    }

    appliedReglueRequestKeyRef.current = props.reglueRequestKey;
    scrollToBottom();
  }, [props.reglueRequestKey, scrollToBottom]);

  useEffect(() => {
    return () => {
      if (!props.threadId) {
        props.onViewportChange?.(undefined);
        return;
      }

      const viewport = savedViewportsRef.current.get(props.threadId);
      props.onViewportChange?.(viewport);
    };
  }, [props.onViewportChange, props.threadId]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !hasTranscriptContent) {
      snapshotRef.current = undefined;
      isGluedToBottomRef.current = true;
      setHasContentBelow(false);
      setIsAtTop(true);
      return;
    }

    const previousSnapshot = snapshotRef.current;
    const restoredViewport =
      props.restoredViewport ??
      (props.threadId ? savedViewportsRef.current.get(props.threadId) : undefined);
    const firstMessageId = transcriptEntries[0]?.id;
    const lastMessageId = transcriptEntries[transcriptEntries.length - 1]?.id;
    const hasPrependedMessages = Boolean(
      previousSnapshot &&
        previousSnapshot.threadId === props.threadId &&
        previousSnapshot.lastMessageId === lastMessageId &&
        previousSnapshot.firstMessageId !== firstMessageId
    );
    // hasAppendedMessages and hasGrownWhileFollowingBottom both intentionally
    // skip the firstMessageId equality check that earlier versions of this
    // file enforced. That check broke the common navigation-preview →
    // full-transcript transition: the preview entries (lastUserMessage /
    // lastAssistantMessage from the navigation snapshot) have synthetic ids
    // that don't match any entries in the eventual readThread response, so
    // when the real transcript replaced them BOTH firstMessageId and
    // lastMessageId changed and neither branch fired — leaving the user
    // staring at the top of a thread they expected to open at the bottom.
    // hasPrependedMessages already covers the only case the equality check
    // was protecting against (older messages paginated in at the top).
    const hasAppendedMessages = Boolean(
      previousSnapshot &&
        previousSnapshot.threadId === props.threadId &&
        !hasPrependedMessages &&
        (previousSnapshot.lastMessageId !== lastMessageId ||
          previousSnapshot.pendingStatusText !== props.pendingStatusText ||
          previousSnapshot.itemCount < visibleItemCount)
    );
    const hasGrownWhileFollowingBottom = Boolean(
      previousSnapshot &&
        previousSnapshot.threadId === props.threadId &&
        !hasPrependedMessages &&
        isGluedToBottomRef.current &&
        container.scrollHeight > previousSnapshot.scrollHeight
    );

    if (hasPrependedMessages && previousSnapshot) {
      const heightDelta = container.scrollHeight - previousSnapshot.scrollHeight;
      container.scrollTop = previousSnapshot.scrollTop + heightDelta;
    } else if (previousSnapshot?.threadId !== props.threadId) {
      if (restoredViewport) {
        const shouldRestoreBottom =
          restoredViewport.isGluedToBottom ??
          restoredViewport.distanceFromBottom <= BOTTOM_THRESHOLD_PX;
        if (shouldRestoreBottom) {
          isGluedToBottomRef.current = true;
          scrollToBottom();
        } else {
          isGluedToBottomRef.current = false;
          container.scrollTop = Math.min(
            Math.max(0, restoredViewport.scrollTop),
            Math.max(container.scrollHeight - container.clientHeight, 0)
          );
          syncScrollState();
        }
        shouldScrollToBottomRef.current = false;
        return;
      }

      scrollToBottom();
      shouldScrollToBottomRef.current = false;
      return;
    } else if (
      shouldScrollToBottomRef.current ||
      !previousSnapshot
    ) {
      scrollToBottom();
      shouldScrollToBottomRef.current = false;
      return;
    } else if (
      isGluedToBottomRef.current &&
      (hasAppendedMessages || hasGrownWhileFollowingBottom)
    ) {
      scrollToBottom();
      return;
    }

    syncScrollState();
  }, [
    hasTranscriptContent,
    props.pendingRequest,
    props.pendingMcpInteraction,
    props.pendingUserInput,
    props.pendingStatusText,
    props.restoredViewport,
    props.threadId,
    scrollToBottom,
    syncScrollState,
    transcriptEntries,
    visibleItemCount,
  ]);

  useEffect(() => {
    const content = scrollContentRef.current;
    const container = scrollContainerRef.current;
    if (!content || !container || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      if (isGluedToBottomRef.current) {
        scrollToBottom();
      } else {
        syncScrollState({ preserveGlueOnResize: true });
      }
    });
    observer.observe(content);
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [scrollToBottom, syncScrollState]);

  if (props.loading && !hasTranscriptContent && !hasPendingContent) {
    return <p className="transcript-empty">Loading transcript…</p>;
  }

  if (props.error && !hasTranscriptContent && !hasPendingContent) {
    return <p className="transcript-error">{props.error}</p>;
  }

  if (!hasTranscriptContent && !hasPendingContent) {
    return <p className="transcript-empty">No thread history yet.</p>;
  }

  return (
    <div
      className="transcript-list"
      // Issue #240: scroll-edge fades. The fade gradients are always
      // mounted (so they can transition on opacity) but read these
      // attributes to decide whether to render visibly.
      //   - `data-fade-top="hidden"` when the scroll is at the very
      //     top (no content above, nothing to fade in from)
      //   - `data-fade-bottom="hidden"` when pinned to the bottom (no
      //     content below)
      data-fade-top={isAtTop ? "hidden" : "visible"}
      data-fade-bottom={hasContentBelow ? "visible" : "hidden"}
    >
      {canLoadOlder ? (
        <button
          className="button button--ghost transcript-list__load-older"
          type="button"
          onClick={() => {
            void props.onLoadOlder();
          }}
        >
          {props.loadingMore ? "Loading older messages" : "Load older messages"}
        </button>
      ) : null}

      {props.error ? <p className="transcript-error">{props.error}</p> : null}

      <div
        ref={scrollContainerRef}
        className="transcript-list__items"
        role="list"
        onWheel={(event) => {
          if (event.deltaY < 0) {
            disableBottomGlue();
          }
        }}
        onScroll={() => {
          syncScrollState({ preserveGlueOnResize: true });
        }}
      >
        {/*
          role="presentation" on the inner scroll wrapper removes it
          from the accessibility tree, letting the role="listitem"
          entries below appear as direct owned children of the
          role="list" scroll container above — which is what axe's
          aria-required-children rule looks for. Without this, the
          inner wrapper sits between the list role and its items in
          the a11y tree and the rule fails.
        */}
        <div ref={scrollContentRef} className="transcript-list__content" role="presentation">
          {transcriptRenderItems.map((item) => {
            const entryKey =
              item.type === "workPhaseGroup" ? item.id : item.entry.id;
            const body =
              item.type === "workPhaseGroup" ? (
                <TranscriptWorkPhaseGroup
                  applications={props.applications}
                  collapsible={item.collapsible}
                  directoryPaths={props.directoryPaths}
                  desktopApi={props.desktopApi}
                  entries={item.entries}
                  expanded={expandedCommentaryGroupIds.has(item.id)}
                  label={item.label}
                  skills={skills}
                  onOpenImage={props.onOpenImage}
                  onToggle={() => {
                    toggleCommentaryGroup(item.id);
                  }}
                />
              ) : item.entry.type === "activity" ? (
                <TranscriptActivity entry={item.entry} />
              ) : item.entry.type === "plan" ? (
                <TranscriptPlan
                  applications={props.applications}
                  desktopApi={props.desktopApi}
                  entry={item.entry}
                />
              ) : item.entry.type === "review" ? (
                <TranscriptReview
                  applications={props.applications}
                  directoryPaths={props.directoryPaths}
                  desktopApi={props.desktopApi}
                  entry={item.entry}
                />
              ) : (
                <TranscriptMessage
                  applications={props.applications}
                  desktopApi={props.desktopApi}
                  message={item.entry}
                  skills={skills}
                  onOpenImage={props.onOpenImage}
                />
              );
            return (
              <div key={entryKey} className="transcript-list__item" role="listitem">
                {body}
              </div>
            );
          })}
          {props.pendingStatusText ? (
            <div className="transcript-list__pending" role="status">
              <ThinkingScanner />
              <span>{props.pendingStatusText}</span>
            </div>
          ) : null}
          {props.pendingUserInput ? (
            <PendingQuestionnaire
              busy={props.pendingRequestBusy}
              state={props.pendingUserInput}
              onChange={(state) => {
                props.onPendingUserInputChange?.(state);
              }}
              onSubmit={async (state) => {
                await props.onSubmitPendingUserInput?.(state);
              }}
            />
          ) : null}
          {props.pendingMcpInteraction ? (
            <PendingMcpInteraction
              busy={props.pendingRequestBusy}
              state={props.pendingMcpInteraction}
              onChange={(state) => {
                props.onPendingMcpInteractionChange?.(state);
              }}
              onSubmit={async (state, action) => {
                await props.onSubmitPendingMcpInteraction?.(state, action);
              }}
            />
          ) : null}
          {props.pendingRequest ? (
            <div className="transcript-request" role="group" aria-label="Pending approval">
              <div className="transcript-request__header">
                <span className="chip chip--mode">
                  Approval needed
                </span>
                <span className="transcript-message__time">
                  {props.pendingRequest.method}
                </span>
              </div>
              <ThreadMarkdown
                applications={props.applications}
                className="transcript-request__prompt"
                desktopApi={props.desktopApi}
                text={pendingRequestPrompt(props.pendingRequest)}
              />
              <div className="transcript-request__actions">
                <button
                  className="button button--primary"
                  disabled={props.pendingRequestBusy}
                  type="button"
                  onClick={() => {
                    void props.onRespondToPendingRequest?.("approve");
                  }}
                >
                  Approve
                </button>
                <button
                  className="button button--ghost"
                  disabled={props.pendingRequestBusy}
                  type="button"
                  onClick={() => {
                    void props.onRespondToPendingRequest?.("decline");
                  }}
                >
                  Decline
                </button>
                <button
                  className="button button--ghost"
                  disabled={props.pendingRequestBusy}
                  type="button"
                  onClick={() => {
                    void props.onRespondToPendingRequest?.("cancel");
                  }}
                >
                  Cancel turn
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Scroll-edge fade overlays (issue #240). Always rendered so
          they can opacity-transition; visibility driven by
          `data-fade-*` on the wrapper. */}
      <div
        aria-hidden="true"
        className="transcript-list__fade transcript-list__fade--top"
      />
      <div
        aria-hidden="true"
        className="transcript-list__fade transcript-list__fade--bottom"
      />

      {hasContentBelow ? (
        <button
          className="button button--ghost transcript-list__scroll-bottom"
          type="button"
          aria-label="Jump to latest message"
          onClick={() => {
            scrollToBottom();
          }}
        >
          <span className="transcript-list__scroll-bottom-icon" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
