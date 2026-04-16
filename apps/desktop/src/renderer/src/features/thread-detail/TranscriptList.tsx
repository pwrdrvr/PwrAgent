import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  AppServerThreadMessage,
  AppServerThreadReplayPagination
} from "@pwragnt/shared";
import { TranscriptMessage } from "./TranscriptMessage";

type TranscriptListProps = {
  error?: string;
  loading: boolean;
  loadingMore: boolean;
  messages: AppServerThreadMessage[];
  pagination?: AppServerThreadReplayPagination;
  threadId?: string;
  onLoadOlder: () => Promise<void>;
};

type ScrollSnapshot = {
  clientHeight: number;
  distanceFromBottom: number;
  firstMessageId?: string;
  lastMessageId?: string;
  scrollHeight: number;
  scrollTop: number;
  threadId?: string;
};

const BOTTOM_THRESHOLD_PX = 24;

export function TranscriptList(props: TranscriptListProps) {
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

    const firstMessageId = props.messages[0]?.id;
    const lastMessageId = props.messages[props.messages.length - 1]?.id;
    const distanceFromBottom = Math.max(
      container.scrollHeight - container.clientHeight - container.scrollTop,
      0
    );

    return {
      clientHeight: container.clientHeight,
      distanceFromBottom,
      firstMessageId,
      lastMessageId,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      threadId: props.threadId
    };
  }, [props.messages, props.threadId]);

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
    if (!container || props.messages.length === 0) {
      snapshotRef.current = undefined;
      setHasContentBelow(false);
      return;
    }

    const previousSnapshot = snapshotRef.current;
    const firstMessageId = props.messages[0]?.id;
    const lastMessageId = props.messages[props.messages.length - 1]?.id;
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
        previousSnapshot.lastMessageId !== lastMessageId
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
  }, [props.messages, props.threadId, scrollToBottom, syncScrollState]);

  if (props.loading && props.messages.length === 0) {
    return <p className="transcript-empty">Loading transcript…</p>;
  }

  if (props.error && props.messages.length === 0) {
    return <p className="transcript-error">{props.error}</p>;
  }

  if (props.messages.length === 0) {
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
        {props.messages.map((message) => (
          <TranscriptMessage key={message.id} message={message} />
        ))}
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
