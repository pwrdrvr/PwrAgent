import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

const thread: NavigationThreadSummary = {
  id: "review-thread",
  title: "Review sample changes",
  titleSource: "explicit",
  summary: "",
  source: "codex",
  linkedDirectories: [],
  inbox: { inInbox: false },
  updatedAt: 1,
};
const key = `codex:${thread.id}`;

async function checkReviewBoundary(
  observedSide: "review" | "interrupt",
  terminalMethod: "turn/completed" | "turn/failed" | "turn/cancelled",
  duplicateStarts: number,
  selectDuringReview: boolean,
  streamActivity = false,
) {
  let emit: (event: AgentEvent) => void = () => { throw new Error("missing subscription"); };
  const desktopApi: DesktopApi = {
    onAgentEvent: (listener) => { emit = listener; return () => undefined; },
  };
  const opened = renderHook(({ selected }) => useThreadSessionState({
    desktopApi,
    thread: selected ? thread : undefined,
  }), { initialProps: { selected: false } });
  const turnId = observedSide;
  const terminalId = observedSide === "review" ? "interrupt" : "review";
  const start: AgentEvent = { backend: "codex", notification: { method: "turn/started", params: {
    threadId: thread.id, turn: { id: turnId, status: "in_progress" },
  } } };
  const params = { threadId: thread.id, turnId: terminalId };
  const notification: AgentEvent["notification"] = terminalMethod === "turn/failed"
    ? { method: terminalMethod, params: { ...params, turn: {
      id: terminalId, status: "failed", error: { message: "Review failed" },
    } } }
    : terminalMethod === "turn/cancelled"
      ? { method: terminalMethod, params: { ...params, turn: { id: terminalId, status: "cancelled" } } }
      : { method: terminalMethod, params: { ...params, turn: { id: terminalId, status: "completed", output: [] } } };
  const terminal: AgentEvent = { backend: "codex", relatedReviewTurnId: turnId, notification };

  try {
    act(() => emit(start));
    if (selectDuringReview) opened.rerender({ selected: true });
    expect(opened.result.current.thinkingThreadKeys[key]).toBe(true);
    if (selectDuringReview) expect(opened.result.current.pendingStatusText).toBe("Thinking");
    if (selectDuringReview && streamActivity) {
      act(() => emit({ backend: "codex", notification: { method: "item/started", params: {
        threadId: thread.id, turnId,
        item: { id: "command", type: "commandExecution", command: "pwd", status: "inProgress" },
      } } }));
    }

    // The owner's review boundary ends both IDs, including the ID a background
    // renderer learned from turn/started. Late duplicates cannot revive it.
    act(() => emit(terminal));
    for (let index = 0; index < duplicateStarts; index += 1) act(() => emit(start));
    if (!selectDuringReview) opened.rerender({ selected: true });
    expect(opened.result.current.thinkingThreadKeys[key]).toBeUndefined();
    expect(opened.result.current.pendingStatusText).toBeUndefined();
    expect(opened.result.current.threadBusy).toBe(false);

    // A duplicate completion cannot settle the next unrelated turn.
    const nextTurnId = "next-turn";
    act(() => emit({ ...start, notification: { method: "turn/started", params: {
      threadId: thread.id, turn: { id: nextTurnId, status: "in_progress" },
    } } }));
    act(() => emit(terminal));
    expect(opened.result.current.activeTurnId).toBe(nextTurnId);
    expect(opened.result.current.thinkingThreadKeys[key]).toBe(true);
  } finally {
    opened.unmount();
  }
}

it("clears the row and transcript after an unfocused inline review completes under its outer ID", async () => {
  await checkReviewBoundary("interrupt", "turn/completed", 0, false);
});

it("clears Thinking when a completed review still has optimistic activity under its interrupt ID", async () => {
  await checkReviewBoundary("interrupt", "turn/completed", 0, true, true);
});

it("settles both IDs of a native review across terminal outcomes and repeated starts", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("review" as const, "interrupt" as const),
    fc.constantFrom("turn/completed" as const, "turn/failed" as const, "turn/cancelled" as const),
    fc.integer({ min: 0, max: 2 }),
    fc.boolean(),
    fc.boolean(),
    checkReviewBoundary,
  ), { numRuns: 30 });
});
