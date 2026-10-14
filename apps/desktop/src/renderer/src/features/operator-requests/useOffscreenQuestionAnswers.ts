import { useMemo, useState } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { parseCodexAsyncQuestionReply } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { useEventCallback } from "../../lib/useEventCallback";
import type { OperatorWait } from "./operator-waits";

export type OffscreenQuestionAnswers = {
  /** Absent when this bridge cannot send to a thread no composer shows. */
  answerQuestion?: (wait: OperatorWait, text: string) => Promise<boolean>;
  /** Taken answers, by `backend:threadId` NUL question item id. */
  sentQuestionAnswers: ReadonlyMap<string, string>;
};

/**
 * Answers questions in local threads no composer shows, from the To-dos
 * panel. The thread's owner decides start, steer or queue in its turn FIFO.
 *
 * The thread counts as replied to only once the owner took the reply, as the
 * composer reports it: Attention keeps the thread unread until then, so a
 * refused answer leaves it in the queue.
 */
export function useOffscreenQuestionAnswers(params: {
  submitThreadReply: DesktopApi["submitThreadReply"];
  /** The local thread a wait belongs to, for the replied-to report. */
  findThread: (threadKey: string) => NavigationThreadSummary | undefined;
  onUserRepliedToThread?: (thread: NavigationThreadSummary) => void;
}): OffscreenQuestionAnswers {
  // Keyed as ThreadView keys its own, so the card shows Sent when the thread
  // is opened before the reply reaches its transcript.
  const [sentQuestionAnswers, setSentQuestionAnswers] =
    useState<ReadonlyMap<string, string>>(() => new Map());
  const submitThreadReply = params.submitThreadReply;
  const answerQuestion = useEventCallback(async (
    wait: OperatorWait,
    text: string,
  ): Promise<boolean> => {
    if (!submitThreadReply) return false;
    // A refusal (a lock, a handoff) throws, and the form shows its reason.
    await submitThreadReply({
      backend: wait.backend,
      threadId: wait.threadId,
      input: [{ type: "text", text }],
    });
    setSentQuestionAnswers((current) => {
      const next = new Map(current);
      for (const reply of parseCodexAsyncQuestionReply(text) ?? []) {
        next.set(`${wait.threadKey}\0${reply.questionItemId}`, reply.answer);
      }
      return next;
    });
    const thread = params.findThread(wait.threadKey);
    if (thread) params.onUserRepliedToThread?.(thread);
    return true;
  });
  // Stable while nothing is sent, so the To-dos view is not rebuilt per render.
  const canSend = submitThreadReply !== undefined;
  return useMemo(
    () => (canSend ? { answerQuestion, sentQuestionAnswers } : { sentQuestionAnswers }),
    [answerQuestion, canSend, sentQuestionAnswers],
  );
}
