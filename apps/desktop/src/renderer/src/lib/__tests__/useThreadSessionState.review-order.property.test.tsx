import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerThreadMessageEntry } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

const thread: NavigationThreadSummary = {
  id: "review-thread",
  title: "Review sample changes",
  titleSource: "explicit",
  summary: "",
  source: "claude",
  linkedDirectories: [],
  inbox: { inInbox: false },
};
const firstStart = 1_800_000_000_000;

async function checkRepeatedReviewOrder(label: string, timeBetweenTurns: number) {
  const reply: AppServerThreadMessageEntry = {
    id: "later-reply",
    type: "message",
    role: "assistant",
    text: "Checks passed.",
    // Claude replay messages can carry their date only on the turn.
    turn: {
      id: "checks-turn",
      status: "completed",
      startedAt: firstStart + timeBetweenTurns,
      completedAt: firstStart + timeBetweenTurns + 1,
    },
  };
  let emit: (event: AgentEvent) => void = () => { throw new Error("missing subscription"); };
  let latestEntries: AppServerThreadMessageEntry[] = [];
  const desktopApi: DesktopApi = {
    onAgentEvent: (listener) => { emit = listener; return () => undefined; },
    readThread: async () => ({
      backend: "claude",
      threadId: thread.id,
      fetchedAt: Date.now(),
      replay: {
        entries: latestEntries,
        messages: latestEntries,
        pagination: latestEntries.length > 0
          ? { supportsPagination: true, hasPreviousPage: true, previousCursor: reply.id }
          : { supportsPagination: true, hasPreviousPage: false },
      },
    }),
  };
  const { result, unmount } = renderHook(() => useThreadSessionState({
    desktopApi, thread, initialHistoryLimit: 1,
  }));
  const now = vi.spyOn(Date, "now");
  try {
    await act(async () => {});
    expect(result.current.entries).toHaveLength(0);

    // Native Claude Code sends findings without an enteredReviewMode item.
    // The older review can remain in the live fallback outside the newest page.
    let firstHeader: string;
    now.mockReturnValue(firstStart);
    act(() => {
      firstHeader = result.current.addOptimisticReviewEntry(label);
      emit({
        backend: "claude",
        notification: { method: "turn/started", params: {
          threadId: thread.id, turn: { id: "first-review", status: "in_progress", startedAt: firstStart },
        } },
      });
      emit({
        backend: "claude",
        notification: { method: "item/completed", params: {
          threadId: thread.id,
          turnId: "first-review",
          item: {
            id: "older-findings",
            type: "exitedReviewMode",
            review: "Add a test for empty input.",
            createdAt: firstStart + 1,
          },
        } },
      });
      emit({
        backend: "claude",
        notification: { method: "turn/completed", params: {
          threadId: thread.id, turnId: "first-review",
          turn: { id: "first-review", status: "completed", completedAt: firstStart + 1, output: [] },
        } },
      });
    });
    latestEntries = [reply];
    now.mockReturnValue(firstStart + timeBetweenTurns + 1);
    await act(async () => { await result.current.reload(); });
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      firstHeader!, "older-findings", reply.id,
    ]);

    now.mockReturnValue(firstStart + 2 * timeBetweenTurns);
    let secondHeader: string;
    act(() => { secondHeader = result.current.addOptimisticReviewEntry(label); });

    // Each submission owns its own header position, even on the same target.
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      firstHeader!, "older-findings", reply.id, secondHeader!,
    ]);
  } finally {
    now.mockRestore();
    unmount();
  }
}

it.each([2, 18_000_000])("keeps the previous Claude review above the latest reply when repeating the same PR after %i ms between turns", async (timeBetweenTurns) => {
  await checkRepeatedReviewOrder("Review https://github.com/example/widget/pull/1", timeBetweenTurns);
});

it("keeps earlier findings in place when a later Claude review repeats any target label", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 1000 }),
    fc.integer({ min: 2, max: 86_400_000 }),
    async (pullRequest, timeBetweenTurns) => {
      await checkRepeatedReviewOrder(`Review https://github.com/example/widget/pull/${pullRequest}`, timeBetweenTurns);
    },
  ), { numRuns: 30 });
});
