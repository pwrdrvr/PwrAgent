import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerReadThreadResponse } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

const thread: NavigationThreadSummary = {
  id: "thread-1",
  source: "codex",
  title: "Review a patch",
  titleSource: "explicit",
  linkedDirectories: [],
  inbox: { inInbox: false },
};
const parentTurn = "turn-1";
const reviewTurn = "review-1";

function expectUsageOwnership(options: { parentCompletes: boolean; reviewReportsUsage: boolean; tokens: number }) {
  let emit!: (event: AgentEvent) => void;
  const persist = vi.fn<NonNullable<DesktopApi["persistThreadUsageActivity"]>>()
    .mockImplementation(async ({ backend, threadId, activity }) => ({ backend, threadId, activityId: activity.id, persisted: true }));
  const desktopApi: DesktopApi = {
    onAgentEvent: (callback) => { emit = callback; return () => undefined; },
    persistThreadUsageActivity: persist,
  };
  const { result, unmount } = renderHook(() => useThreadSessionState({ desktopApi, thread }));
  const reportUsage = (turnId: string, inputTokens: number) => {
    const usage = { input_tokens: inputTokens, cached_input_tokens: 0, output_tokens: 10, total_tokens: inputTokens + 10 };
    emit({ backend: "codex", notification: { method: "thread/tokenUsage/updated", params: {
      threadId: thread.id, turnId, tokenUsage: { last_token_usage: usage, total_token_usage: usage },
    } } });
  };
  const complete = (turnId: string) => emit({ backend: "codex", notification: { method: "turn/completed", params: {
    threadId: thread.id, turnId, turn: { id: turnId, status: "completed", output: [] },
  } } });
  try {
    act(() => result.current.setActiveTurnId(parentTurn));
    act(() => reportUsage(parentTurn, options.tokens));
    expect(result.current.runningTurnUsageText).toContain("Usage so far:");

    // The inline review is selected before the preceding turn's delayed end.
    act(() => result.current.setActiveTurnId(reviewTurn));
    const reviewUsageBeforeAnyReport = result.current.runningTurnUsageText;
    if (options.parentCompletes) act(() => complete(parentTurn));
    if (options.reviewReportsUsage) act(() => reportUsage(reviewTurn, options.tokens + 1));
    act(() => complete(reviewTurn));

    expect(persist.mock.calls.map(([{ activity }]) => [activity.id, activity.turn?.id])).toEqual(
      options.reviewReportsUsage ? [[`live-turn-usage-${reviewTurn}`, reviewTurn]] : [],
    );
    if (!options.reviewReportsUsage) {
      expect(result.current.entries.filter((entry) => entry.type === "activity")).toEqual([]);
    }
    expect(reviewUsageBeforeAnyReport).toBeUndefined();
  } finally {
    unmount();
  }
}

it("never finalizes the previous turn's pending usage under an inline review without usage", () => {
  expectUsageOwnership({ parentCompletes: true, reviewReportsUsage: false, tokens: 123 });
});

it("keeps a late transcript or pagination response scoped to the thread that requested it", async () => {
  await fc.assert(fc.asyncProperty(
    fc.scheduler(),
    fc.constantFrom("reload", "loadOlder"),
    async (scheduler, operation) => {
      const destination = { ...thread, id: "thread-2", title: "Write an estimate" };
      let initialRead = true;
      const readThread: NonNullable<DesktopApi["readThread"]> = ({ threadId, before }) => {
        const id = before ? `${threadId}/older` : `${threadId}/latest`;
        const response: AppServerReadThreadResponse = {
          backend: "codex", threadId, threadStatus: "idle", fetchedAt: 1,
          replay: {
            entries: [{ type: "message", id, role: "user", text: id }],
            messages: [],
            pagination: { supportsPagination: true, hasPreviousPage: !before, previousCursor: "older-cursor" },
          },
        };
        if (initialRead) {
          initialRead = false;
          return Promise.resolve(response);
        }
        return scheduler.schedule(Promise.resolve(response), id);
      };
      const desktopApi = { readThread };
      const hook = renderHook(({ selected }) => useThreadSessionState({ desktopApi, thread: selected }), {
        initialProps: { selected: thread },
      });
      try {
        await act(async () => {});
        expect(hook.result.current.entries.map((entry) => entry.id)).toEqual(["thread-1/latest"]);
        act(() => { void hook.result.current[operation](); });
        hook.rerender({ selected: destination });
        expect(scheduler.count()).toBe(2);
        while (scheduler.count() > 0) {
          await act(async () => { await scheduler.waitNext(1); });
          expect(hook.result.current.entries.every((entry) => entry.id === "thread-2/latest")).toBe(true);
        }
        expect(hook.result.current.entries.map((entry) => entry.id)).toEqual(["thread-2/latest"]);
      } finally {
        hook.unmount();
      }
    },
  ), { numRuns: 25 });
});

it("persists a review total only from usage received for that review", () => {
  fc.assert(fc.property(
    fc.record({ parentCompletes: fc.boolean(), reviewReportsUsage: fc.boolean(), tokens: fc.integer({ min: 1, max: 1_000_000 }) }),
    expectUsageOwnership,
  ), { numRuns: 25 });
});
