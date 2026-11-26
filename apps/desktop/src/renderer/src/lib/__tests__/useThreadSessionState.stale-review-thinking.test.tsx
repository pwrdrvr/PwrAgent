import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

type Outcome = "completed" | "failed" | "cancelled";
type Scenario = {
  target: "branch" | "commit" | "custom" | "snapshot" | "native";
  outcome: Outcome;
  unfocus: boolean;
  ackAfterTerminal: boolean;
  nextTurn: boolean;
};

const labels = {
  branch: ["Review changes against main", "Review changes against main"],
  commit: ["Review commit abcdef0123456789", "Review commit abcdef0"],
  custom: ["Review custom instructions", "Check error handling"],
  snapshot: ["Review https://github.com/example/widget/pull/1", "Review https://github.com/example/widget/pull/1 at abcdef0123"],
  native: ["Review current changes", undefined],
} as const;

function openReviewSession(source: NavigationThreadSummary["source"], readIdle = false) {
  const thread: NavigationThreadSummary = {
    id: "review-parent",
    title: "Review sample changes",
    titleSource: "explicit",
    source,
    linkedDirectories: [],
    inbox: { inInbox: false },
  };
  const key = `${source}:${thread.id}`;
  let emit: (event: AgentEvent) => void = () => { throw new Error("missing subscription"); };
  const desktopApi: DesktopApi = {
    onAgentEvent: (listener) => {
      emit = listener;
      return () => undefined;
    },
    ...(readIdle ? { readThread: async () => ({
      backend: source,
      threadId: thread.id,
      threadStatus: "idle" as const,
      fetchedAt: Date.now(),
      replay: {
        entries: [],
        messages: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      },
    }) } : {}),
  };
  const view = renderHook(({ selected }) => useThreadSessionState({
    desktopApi,
    thread: selected ? thread : undefined,
  }), { initialProps: { selected: true } });
  return {
    view,
    threadId: thread.id,
    send: (notification: AgentEvent["notification"]) => emit({ backend: source, notification }),
    thinking: () => Boolean(view.result.current.thinkingThreadKeys[key]),
  };
}

function checkReviewLifecycle(scenario: Scenario): void {
  const { target, outcome, unfocus, ackAfterTerminal, nextTurn } = scenario;
  const source = target === "native" ? "codex" : "acp:antigravity";
  const turnId = target === "native" ? "native-review" : "pending:review-child:1800000000000";
  const { view, send, thinking, threadId } = openReviewSession(source);
  const params = { threadId, turnId };
  const terminal: AgentEvent["notification"] = outcome === "failed"
    ? { method: "turn/failed", params: { ...params, turn: { id: turnId, status: outcome, error: { message: "Review failed" } } } }
    : outcome === "cancelled"
      ? { method: "turn/cancelled", params: { ...params, turn: { id: turnId, status: outcome } } }
      : { method: "turn/completed", params: { ...params, turn: { id: turnId, status: outcome, output: [] } } };
  const [localLabel, ownerLabel] = labels[target];
  const check = (phase: string, running: boolean) => {
    expect(thinking(), phase).toBe(running);
  };

  try {
    // Save the callback the composer will use if the start response arrives
    // after it has unmounted. No owner read repairs the background row.
    const addReview = view.result.current.addOptimisticReviewEntry;
    const setActiveTurnId = view.result.current.setActiveTurnId;
    act(() => {
      view.result.current.setPendingStatusText("Reviewing");
      addReview(localLabel);
    });
    check("submitting", true);
    act(() => {
      send({ method: "turn/started", params: { ...params, turn: { id: turnId, status: "in_progress" } } });
      if (ownerLabel) {
        send({ method: "item/completed", params: { ...params, item: {
          id: "review-start", type: "enteredReviewMode", review: ownerLabel,
        } } });
      }
      if (!ackAfterTerminal) setActiveTurnId(turnId);
    });
    check("running", true);
    if (unfocus) view.rerender({ selected: false });
    act(() => {
      if (outcome === "completed") {
        send({ method: "item/completed", params: { ...params, item: {
          id: "review-result", type: "exitedReviewMode", review: "No findings.",
        } } });
      }
      send(terminal);
    });
    if (ackAfterTerminal) act(() => setActiveTurnId(turnId));
    check("after review", false);

    if (nextTurn) {
      const next = { threadId, turnId: "follow-up" };
      act(() => {
        send({ method: "turn/started", params: { ...next, turn: { id: next.turnId, status: "in_progress" } } });
      });
      check("during follow-up", true);
      act(() => send({ method: "turn/completed", params: {
        ...next, turn: { id: next.turnId, status: "completed", output: [] },
      } }));
      check("after follow-up", false);
    }
  } finally {
    view.unmount();
  }
}

it.each<Scenario>([
  { target: "commit", outcome: "completed", unfocus: true, ackAfterTerminal: false, nextTurn: false },
  { target: "custom", outcome: "completed", unfocus: false, ackAfterTerminal: false, nextTurn: false },
  { target: "snapshot", outcome: "completed", unfocus: true, ackAfterTerminal: false, nextTurn: false },
  { target: "native", outcome: "completed", unfocus: true, ackAfterTerminal: true, nextTurn: false },
  { target: "branch", outcome: "failed", unfocus: true, ackAfterTerminal: false, nextTurn: true },
  { target: "branch", outcome: "cancelled", unfocus: true, ackAfterTerminal: false, nextTurn: true },
])("settles Thinking for a $outcome $target review and any subsequent turn", (scenario) => {
  checkReviewLifecycle(scenario);
});

it("keeps an idle sender idle when a cross-thread delivery receipt follows a merge-build turn", async () => {
  const { view, send, thinking, threadId } = openReviewSession("acp:antigravity", true);

  try {
    await act(async () => {});
    const review = { threadId, turnId: "pending:review-child:1800000000000" };
    act(() => {
      view.result.current.addOptimisticReviewEntry("Review commit abcdef0123456789");
      send({ method: "turn/started", params: { ...review, turn: { id: review.turnId, status: "in_progress" } } });
      send({ method: "item/completed", params: { ...review, item: {
        id: "review-start", type: "enteredReviewMode", review: "Review commit abcdef0",
      } } });
      send({ method: "item/completed", params: { ...review, item: {
        id: "review-result", type: "exitedReviewMode", review: "No findings.",
      } } });
      send({ method: "turn/completed", params: {
        ...review, turn: { id: review.turnId, status: "completed", output: [] },
      } });
    });
    await act(async () => { await view.result.current.reload(); });
    view.rerender({ selected: false });

    act(() => send({ method: "thread/dependencies/updated", params: { threadId, dependencyId: "build-watch" } }));
    expect(thinking(), "arming the watch").toBe(false);
    const followUp = { threadId, turnId: "pending:review-parent:1800000001000" };
    act(() => send({ method: "turn/started", params: {
      ...followUp, turn: { id: followUp.turnId, status: "in_progress" },
    } }));
    expect(thinking(), "investigating the failed merge build").toBe(true);
    act(() => send({ method: "turn/completed", params: {
      ...followUp, turn: { id: followUp.turnId, status: "completed", output: [{ type: "text", text: "The merge build failed." }] },
    } }));

    // An idle read clears the indicator while the unmatched review header
    // remains in the transcript. The recipient's receipt belongs to no
    // active sender turn and must leave the sender idle.
    view.rerender({ selected: true });
    await act(async () => { await view.result.current.reload(); });
    view.rerender({ selected: false });
    expect(thinking(), "after the idle read").toBe(false);
    act(() => send({ method: "item/completed", params: {
      threadId,
      item: {
        id: "correspondence:example",
        type: "agentMessage",
        text: "Sent the build findings.",
        origin: { kind: "pwragent", systemReason: "thread-correspondence" },
      },
    } }));
    expect(thinking(), "after recording the receipt").toBe(false);
  } finally {
    view.unmount();
  }
});
