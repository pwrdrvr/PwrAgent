import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  AppServerPendingRequestNotification,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
  AppServerSkillSummary,
  AppServerThreadReplayPagination
} from "@pwragnt/shared";
import { ThinkingScanner } from "./ThinkingScanner";
import { TranscriptActivity } from "./TranscriptActivity";
import { TranscriptMessage } from "./TranscriptMessage";

type TranscriptListProps = {
  entries: AppServerThreadEntry[];
  error?: string;
  loading: boolean;
  loadingMore: boolean;
  pendingAssistantMessage?: AppServerThreadMessageEntry;
  pendingRequest?: AppServerPendingRequestNotification;
  pendingRequestBusy?: boolean;
  pendingStatusText?: string;
  pagination?: AppServerThreadReplayPagination;
  threadId?: string;
  skills?: AppServerSkillSummary[];
  onRespondToPendingRequest?: (decision: "approve" | "decline" | "cancel") => Promise<void>;
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

export function TranscriptList(props: TranscriptListProps) {
  const skills = props.skills ?? [];
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef<ScrollSnapshot | undefined>(undefined);
  const shouldScrollToBottomRef = useRef(true);
  const [hasContentBelow, setHasContentBelow] = useState(false);
  const canLoadOlder = Boolean(
    props.pagination?.supportsPagination && props.pagination.hasPreviousPage
  );

  const captureSnapshot = useCallback((): ScrollSnapshot | undefined => {
    const container = scrollContainerRef.current;
    if (!container) {
      return undefined;
    }

    const firstMessageId = props.entries[0]?.id;
    const lastMessageId = props.entries[props.entries.length - 1]?.id;
    const itemCount =
      props.entries.length +
      (props.pendingAssistantMessage ? 1 : 0) +
      (props.pendingStatusText ? 1 : 0) +
      (props.pendingRequest ? 1 : 0);
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
    props.pendingAssistantMessage,
    props.pendingRequest,
    props.pendingStatusText,
    props.threadId
  ]);

  const syncScrollState = useCallback(() => {
    const snapshot = captureSnapshot();
    snapshotRef.current = snapshot;
    setHasContentBelow(Boolean(snapshot && snapshot.distanceFromBottom > BOTTOM_THRESHOLD_PX));
  }, [captureSnapshot]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    if (typeof container.scrollTo === "function") {
      container.scrollTo({
        top: container.scrollHeight,
        behavior
      });
    } else {
      container.scrollTop = container.scrollHeight;
    }

    syncScrollState();
  }, [syncScrollState]);

  useEffect(() => {
    shouldScrollToBottomRef.current = true;
  }, [props.threadId]);

  useEffect(() => {
    if (props.loading) {
      shouldScrollToBottomRef.current = true;
    }
  }, [props.loading]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || props.entries.length === 0) {
      snapshotRef.current = undefined;
      setHasContentBelow(false);
      return;
    }

    const previousSnapshot = snapshotRef.current;
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
              (props.pendingAssistantMessage ? 1 : 0) +
              (props.pendingStatusText ? 1 : 0) +
              (props.pendingRequest ? 1 : 0))
    );

    if (hasPrependedMessages && previousSnapshot) {
      const heightDelta = container.scrollHeight - previousSnapshot.scrollHeight;
      container.scrollTop = previousSnapshot.scrollTop + heightDelta;
    } else if (
      shouldScrollToBottomRef.current ||
      !previousSnapshot ||
      previousSnapshot.threadId !== props.threadId
    ) {
      scrollToBottom("auto");
      shouldScrollToBottomRef.current = false;
      return;
    } else if (
      hasAppendedMessages &&
      previousSnapshot.distanceFromBottom <= BOTTOM_THRESHOLD_PX
    ) {
      scrollToBottom("auto");
      return;
    }

    syncScrollState();
  }, [
    props.entries,
    props.pendingAssistantMessage,
    props.pendingRequest,
    props.pendingStatusText,
    props.threadId,
    scrollToBottom,
    syncScrollState,
  ]);

  if (props.loading && props.entries.length === 0) {
    return <p className="transcript-empty">Loading transcript…</p>;
  }

  if (props.error && props.entries.length === 0) {
    return <p className="transcript-error">{props.error}</p>;
  }

  if (props.entries.length === 0) {
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
        {props.entries.map((entry) =>
          entry.type === "activity" ? (
            <TranscriptActivity key={entry.id} entry={entry} />
          ) : (
            <TranscriptMessage key={entry.id} message={entry} skills={skills} />
          )
        )}
        {props.pendingAssistantMessage ? (
          <TranscriptMessage
            key={props.pendingAssistantMessage.id}
            message={props.pendingAssistantMessage}
            skills={skills}
          />
        ) : null}
        {props.pendingStatusText ? (
          <div className="transcript-list__pending" role="status">
            <ThinkingScanner />
            <span>{props.pendingStatusText}</span>
          </div>
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
            <p className="transcript-request__prompt">
              {typeof props.pendingRequest.params.prompt === "string"
                ? props.pendingRequest.params.prompt
                : "This turn is waiting for approval before it can continue."}
            </p>
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
