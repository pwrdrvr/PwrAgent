import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  NavigationThreadSummary,
  SubmitThreadReplyRequest,
  SubmitThreadReplyResponse,
} from "@pwragent/shared";
import { codexAsyncQuestionItemId, formatCodexAsyncQuestionReply } from "@pwragent/shared";
import { buildOperatorWaits } from "../operator-waits";
import { useOffscreenQuestionAnswers } from "../useOffscreenQuestionAnswers";

const [wait] = buildOperatorWaits({ serverRequests: [], questions: [{
  backend: "codex", threadId: "thread-b", messageId: "msg-1",
  questions: [{ title: "Which bucket?", options: null }], createdAt: 1_000,
}], seenKeys: [] });
const itemId = codexAsyncQuestionItemId("msg-1", 0);
const text = formatCodexAsyncQuestionReply([{
  questionItemId: itemId, question: "Which bucket?", answer: "staging",
}])!;
const thread = { id: "thread-b", source: "codex" } as NavigationThreadSummary;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useOffscreenQuestionAnswers", () => {
  it("reports the reply only once the thread's owner took it", async () => {
    const admitted = deferred<SubmitThreadReplyResponse>();
    const submitThreadReply = vi.fn((_request: SubmitThreadReplyRequest) => admitted.promise);
    const onUserRepliedToThread = vi.fn();
    const { result } = renderHook(() => useOffscreenQuestionAnswers({
      submitThreadReply,
      findThread: (threadKey) => (threadKey === "codex:thread-b" ? thread : undefined),
      onUserRepliedToThread,
    }));

    let answered!: Promise<boolean>;
    act(() => {
      answered = result.current.answerQuestion!(wait!, text);
    });
    expect(submitThreadReply).toHaveBeenCalledWith({
      backend: "codex", threadId: "thread-b", input: [{ type: "text", text }],
    });
    // Sending is not replying: Attention keeps the thread until it is taken.
    expect(onUserRepliedToThread).not.toHaveBeenCalled();
    expect(result.current.sentQuestionAnswers.size).toBe(0);

    await act(async () => {
      admitted.resolve({
        backend: "codex", threadId: "thread-b", queueStatus: "queued", queueEntryId: "entry-1",
      });
      await expect(answered).resolves.toBe(true);
    });
    expect(onUserRepliedToThread).toHaveBeenCalledWith(thread);
    expect(result.current.sentQuestionAnswers.get(`codex:thread-b\0${itemId}`)).toBe("staging");
  });

  it("passes a refusal on and leaves the thread unreplied", async () => {
    const onUserRepliedToThread = vi.fn();
    const { result } = renderHook(() => useOffscreenQuestionAnswers({
      submitThreadReply: vi.fn(async () => { throw new Error("This thread is locked: Parked."); }),
      findThread: () => thread,
      onUserRepliedToThread,
    }));
    await act(async () => {
      await expect(result.current.answerQuestion!(wait!, text))
        .rejects.toThrow("This thread is locked: Parked.");
    });
    expect(onUserRepliedToThread).not.toHaveBeenCalled();
    expect(result.current.sentQuestionAnswers.size).toBe(0);
  });

  it("offers no answer path without the bridge, and keeps one value across renders", () => {
    const { result, rerender } = renderHook(() => useOffscreenQuestionAnswers({
      submitThreadReply: undefined,
      findThread: () => undefined,
    }));
    const first = result.current;
    expect(first.answerQuestion).toBeUndefined();
    rerender();
    expect(result.current).toBe(first);
  });
});
