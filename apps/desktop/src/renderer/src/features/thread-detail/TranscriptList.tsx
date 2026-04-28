import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerPendingRequestNotification,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  AppServerThreadMessageEntry,
  AppServerThreadPlanEntry,
  AppServerSkillSummary,
  AppServerThreadReplayPagination
} from "@pwragnt/shared";
import { ThinkingScanner } from "./ThinkingScanner";
import { PendingQuestionnaire } from "./PendingQuestionnaire";
import { TranscriptActivity } from "./TranscriptActivity";
import { ThreadMarkdown } from "./ThreadMarkdown";
import { TranscriptMessage } from "./TranscriptMessage";
import { TranscriptPlan } from "./TranscriptPlan";
import { TranscriptWorkPhaseGroup } from "./TranscriptWorkPhaseGroup";
import type { PendingQuestionnaireState } from "./questionnaire";
import { buildTranscriptRenderItems } from "./transcript-render-items";

type TranscriptListProps = {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
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
  pendingUserInput?: PendingQuestionnaireState;
  pendingStatusText?: string;
  pagination?: AppServerThreadReplayPagination;
  restoredViewport?: {
    distanceFromBottom: number;
    scrollTop: number;
  };
  threadId?: string;
  skills?: AppServerSkillSummary[];
  onOpenImage?: (image: AppServerThreadImagePart) => void;
  onViewportChange?: (viewport?: {
    distanceFromBottom: number;
    scrollTop: number;
  }) => void;
  onRespondToPendingRequest?: (decision: "approve" | "decline" | "cancel") => Promise<void>;
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

const BOTTOM_THRESHOLD_PX = 24;
type ScrollBottomMode = "instant" | "smooth";

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
  const snapshotRef = useRef<ScrollSnapshot | undefined>(undefined);
  const savedViewportsRef = useRef(
    new Map<string, { distanceFromBottom: number; scrollTop: number }>()
  );
  const shouldScrollToBottomRef = useRef(true);
  const isFollowingBottomRef = useRef(true);
  const [hasContentBelow, setHasContentBelow] = useState(false);
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
      props.pendingUserInput ||
      props.pendingStatusText
  );
  const transcriptEntries = useMemo(() => {
    const entries = [...props.entries];
    if (props.pendingPlanEntry) {
      entries.push(props.pendingPlanEntry);
    }
    if (props.pendingActivityEntry) {
      entries.push(props.pendingActivityEntry);
    }
    if (props.pendingProtocolActivityEntry) {
      entries.push(props.pendingProtocolActivityEntry);
    }
    if (props.pendingAssistantMessage) {
      entries.push(props.pendingAssistantMessage);
    }
    return entries;
  }, [
    props.entries,
    props.pendingActivityEntry,
    props.pendingProtocolActivityEntry,
    props.pendingAssistantMessage,
    props.pendingPlanEntry,
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

    const firstMessageId = props.entries[0]?.id;
    const lastMessageId = props.entries[props.entries.length - 1]?.id;
    const itemCount =
      props.entries.length +
      (props.pendingActivityEntry ? 1 : 0) +
      (props.pendingProtocolActivityEntry ? 1 : 0) +
      (props.pendingAssistantMessage ? 1 : 0) +
      (props.pendingPlanEntry ? 1 : 0) +
      (props.pendingStatusText ? 1 : 0) +
      (props.pendingRequest ? 1 : 0) +
      (props.pendingUserInput ? 1 : 0);
    const distanceFromBottom = Math.max(
      container.scrollHeight - container.clientHeight - container.scrollTop,
      0
    );

    return {
      clientHeight: container.clientHeight,
      distanceFromBottom,
      firstMessageId,
      itemCount,
      lastMessageId,
      pendingStatusText: props.pendingStatusText,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      threadId: props.threadId
    };
  }, [
    props.entries,
    props.pendingActivityEntry,
    props.pendingProtocolActivityEntry,
    props.pendingAssistantMessage,
    props.pendingPlanEntry,
    props.pendingRequest,
    props.pendingUserInput,
    props.pendingStatusText,
    props.threadId
  ]);

  const syncScrollState = useCallback(() => {
    const snapshot = captureSnapshot();
    snapshotRef.current = snapshot;
    isFollowingBottomRef.current = Boolean(
      snapshot && snapshot.distanceFromBottom <= BOTTOM_THRESHOLD_PX
    );
    setHasContentBelow(Boolean(snapshot && snapshot.distanceFromBottom > BOTTOM_THRESHOLD_PX));
    if (snapshot?.threadId) {
      savedViewportsRef.current.set(snapshot.threadId, {
        distanceFromBottom: snapshot.distanceFromBottom,
        scrollTop: snapshot.scrollTop,
      });
    }
  }, [captureSnapshot]);

  const scrollToBottom = useCallback((mode: ScrollBottomMode = "smooth") => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    if (mode === "smooth" && typeof container.scrollTo === "function") {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: "smooth"
      });
    } else {
      container.scrollTop = container.scrollHeight;
    }

    isFollowingBottomRef.current = true;
    syncScrollState();
  }, [syncScrollState]);

  useEffect(() => {
    if (props.loading && props.entries.length === 0) {
      shouldScrollToBottomRef.current = true;
    }
  }, [props.entries.length, props.loading]);

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
    if (!container || props.entries.length === 0) {
      snapshotRef.current = undefined;
      isFollowingBottomRef.current = true;
      setHasContentBelow(false);
      return;
    }

    const previousSnapshot = snapshotRef.current;
    const restoredViewport =
      props.restoredViewport ??
      (props.threadId ? savedViewportsRef.current.get(props.threadId) : undefined);
    const firstMessageId = props.entries[0]?.id;
    const lastMessageId = props.entries[props.entries.length - 1]?.id;
    const hasPrependedMessages = Boolean(
      previousSnapshot &&
        previousSnapshot.threadId === props.threadId &&
        previousSnapshot.lastMessageId === lastMessageId &&
        previousSnapshot.firstMessageId !== firstMessageId
    );
    const hasAppendedMessages = Boolean(
      previousSnapshot &&
        previousSnapshot.threadId === props.threadId &&
        previousSnapshot.firstMessageId === firstMessageId &&
        (previousSnapshot.lastMessageId !== lastMessageId ||
          previousSnapshot.pendingStatusText !== props.pendingStatusText ||
      previousSnapshot.itemCount <
            props.entries.length +
              (props.pendingActivityEntry ? 1 : 0) +
              (props.pendingProtocolActivityEntry ? 1 : 0) +
              (props.pendingAssistantMessage ? 1 : 0) +
              (props.pendingPlanEntry ? 1 : 0) +
              (props.pendingStatusText ? 1 : 0) +
              (props.pendingRequest ? 1 : 0) +
              (props.pendingUserInput ? 1 : 0))
    );
    const hasGrownWhileFollowingBottom = Boolean(
      previousSnapshot &&
        previousSnapshot.threadId === props.threadId &&
        previousSnapshot.firstMessageId === firstMessageId &&
        !hasPrependedMessages &&
        isFollowingBottomRef.current &&
        container.scrollHeight > previousSnapshot.scrollHeight
    );

    if (hasPrependedMessages && previousSnapshot) {
      const heightDelta = container.scrollHeight - previousSnapshot.scrollHeight;
      container.scrollTop = previousSnapshot.scrollTop + heightDelta;
    } else if (previousSnapshot?.threadId !== props.threadId) {
      if (restoredViewport) {
        if (restoredViewport.distanceFromBottom <= BOTTOM_THRESHOLD_PX) {
          scrollToBottom("instant");
        } else {
          container.scrollTop = Math.min(
            Math.max(0, restoredViewport.scrollTop),
            Math.max(container.scrollHeight - container.clientHeight, 0)
          );
          syncScrollState();
        }
        shouldScrollToBottomRef.current = false;
        return;
      }

      scrollToBottom("instant");
      shouldScrollToBottomRef.current = false;
      return;
    } else if (
      shouldScrollToBottomRef.current ||
      !previousSnapshot
    ) {
      scrollToBottom("instant");
      shouldScrollToBottomRef.current = false;
      return;
    } else if (
      (hasAppendedMessages && previousSnapshot.distanceFromBottom <= BOTTOM_THRESHOLD_PX) ||
      hasGrownWhileFollowingBottom
    ) {
      scrollToBottom("instant");
      return;
    }

    syncScrollState();
  }, [
    props.entries,
    props.pendingActivityEntry,
    props.pendingProtocolActivityEntry,
    props.pendingAssistantMessage,
    props.pendingPlanEntry,
    props.pendingRequest,
    props.pendingUserInput,
    props.pendingStatusText,
    props.restoredViewport,
    props.threadId,
    scrollToBottom,
    syncScrollState,
  ]);

  if (props.loading && props.entries.length === 0 && !hasPendingContent) {
    return <p className="transcript-empty">Loading transcript…</p>;
  }

  if (props.error && props.entries.length === 0 && !hasPendingContent) {
    return <p className="transcript-error">{props.error}</p>;
  }

  if (props.entries.length === 0 && !hasPendingContent) {
    return <p className="transcript-empty">No thread history yet.</p>;
  }

  return (
    <div className="transcript-list">
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
        onScroll={syncScrollState}
      >
        {transcriptRenderItems.map((item) => {
          if (item.type === "workPhaseGroup") {
            return (
              <TranscriptWorkPhaseGroup
                key={item.id}
                collapsible={item.collapsible}
                entries={item.entries}
                expanded={expandedCommentaryGroupIds.has(item.id)}
                label={item.label}
                skills={skills}
                onOpenImage={props.onOpenImage}
                onToggle={() => {
                  toggleCommentaryGroup(item.id);
                }}
              />
            );
          }

          const entry = item.entry;
          return entry.type === "activity" ? (
            <TranscriptActivity key={entry.id} entry={entry} />
          ) : entry.type === "plan" ? (
            <TranscriptPlan key={entry.id} entry={entry} />
          ) : (
            <TranscriptMessage
              key={entry.id}
              message={entry}
              skills={skills}
              onOpenImage={props.onOpenImage}
            />
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
        {props.pendingRequest ? (
          <div className="transcript-request" role="group" aria-label="Pending approval">
            <div className="transcript-request__header">
              <span className="thread-row__chip thread-row__chip--mode">
                Approval needed
              </span>
              <span className="transcript-message__time">
                {props.pendingRequest.method}
              </span>
            </div>
            <ThreadMarkdown
              className="transcript-request__prompt"
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
