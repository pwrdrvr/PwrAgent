import type { AppServerThreadMessageEntry } from "@pwragent/shared";
import { useLayoutEffect, useRef, useState } from "react";

// Bound preview admission, not Markdown syntax. Every admitted snapshot still
// goes through the full existing parser. Final history is never delayed.
const PREVIEW_INTERVAL_MS = 100;

export function usePendingMarkdownPreview(
  threadId: string | undefined,
  message: AppServerThreadMessageEntry | undefined,
): AppServerThreadMessageEntry | undefined {
  const [preview, setPreview] = useState({ threadId, message });
  const latest = useRef({ threadId, message });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const messageId = message?.id;

  useLayoutEffect(() => () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, [threadId, messageId]);

  useLayoutEffect(() => {
    latest.current = { threadId, message };
    if (preview.threadId !== threadId || preview.message?.id !== messageId) {
      // Drop the previous thread/message immediately. Keep at most the latest
      // input and one visible snapshot; never retain a transcript cache.
      setPreview(latest.current);
      return;
    }
    if (preview.message !== message && timer.current === undefined) {
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setPreview(latest.current);
      }, PREVIEW_INTERVAL_MS);
    }
  });

  // Switching and completion must not render the previous preview even for
  // one commit. The layout effect releases its reference before the paint.
  return preview.threadId === threadId && preview.message?.id === messageId
    ? preview.message
    : message;
}
