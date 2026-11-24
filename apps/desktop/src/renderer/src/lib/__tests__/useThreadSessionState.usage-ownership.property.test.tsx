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

type ParentCompletion = "before-review-usage" | "before-review-completion" | "after-review-completion" | "missing";

function expectUsageOwnership(options: { parentCompletion: ParentCompletion; reviewReportsUsage: boolean; tokens: number }) {
  let emit!: (event: AgentEvent) => void;
  const persist = vi.fn<NonNullable<DesktopApi["persistThreadUsageActivity"]>>()
    .mockImplementation(async ({ backend, threadId, activity }) => ({ backend, threadId, activityId: activity.id, persisted: true }));
  const desktopApi: DesktopApi = {
    onAgentEvent: (callback) => { emit = callback; return () => undefined; },
    persistThreadUsageActivity: persist,
  };
  const { result, unmount } = renderHook(() => useThreadSessionState({ desktopApi, thread }));
  const reportUsage = (turnId: string, inputTokens: number, previousInputTokens = 0) => {
    const usage = { input_tokens: inputTokens, cached_input_tokens: 0, output_tokens: 10, total_tokens: inputTokens + 10 };
    const total = previousInputTokens === 0 ? usage : {
      ...usage, input_tokens: inputTokens + previousInputTokens, output_tokens: 20,
      total_tokens: inputTokens + previousInputTokens + 20,
    };
    emit({ backend: "codex", notification: { method: "thread/tokenUsage/updated", params: {
      threadId: thread.id, turnId, tokenUsage: { last_token_usage: usage, total_token_usage: total },
    } } });
  };
  const complete = (turnId: string) => emit({ backend: "codex", notification: { method: "turn/completed", params: {
    threadId: thread.id, turnId, turn: { id: turnId, status: "completed", output: [] },
  } } });
  try {
    const parentStartedAt = 1_800_000_000_000;
    act(() => emit({ backend: "codex", notification: { method: "turn/started", params: {
      threadId: thread.id, turn: { id: parentTurn, status: "in_progress", startedAt: parentStartedAt },
    } } }));
    act(() => reportUsage(parentTurn, options.tokens));
    expect(result.current.runningTurnUsageText).toContain("Usage so far:");

    // The inline review is selected before the preceding turn's delayed end.
    act(() => result.current.setActiveTurnId(reviewTurn));
    const reviewUsageBeforeAnyReport = result.current.runningTurnUsageText;
    if (options.parentCompletion === "before-review-usage") act(() => complete(parentTurn));
    if (options.reviewReportsUsage) act(() => reportUsage(reviewTurn, options.tokens + 1, options.tokens));
    if (options.parentCompletion === "before-review-completion") act(() => complete(parentTurn));
    expect(result.current.activeTurnId).toBe(reviewTurn);
    act(() => complete(reviewTurn));
    if (options.parentCompletion === "after-review-completion") act(() => complete(parentTurn));
    // A terminal event can be redelivered, but its pending total has settled.
    if (options.parentCompletion !== "missing") act(() => complete(parentTurn));

    const expected = [
      ...(options.parentCompletion !== "missing" ? [{
        id: `live-turn-usage-${parentTurn}`,
        summary: `Turn usage: ${options.tokens.toLocaleString("en-US")} uncached in · 0 cached · 10 out`,
        turn: { id: parentTurn, status: "completed", startedAt: parentStartedAt },
      }] : []),
      ...(options.reviewReportsUsage ? [{
        id: `live-turn-usage-${reviewTurn}`,
        summary: `Turn usage: ${(options.tokens + 1).toLocaleString("en-US")} uncached in · 0 cached · 10 out`,
        turn: { id: reviewTurn, status: "completed" },
      }] : []),
    ];
    const saved = persist.mock.calls.map(([{ activity }]) => activity).toSorted((a, b) => a.id.localeCompare(b.id));
    expect(saved).toMatchObject(expected.toSorted((a, b) => a.id.localeCompare(b.id)));
    expect(result.current.entries.filter((entry) => entry.type === "activity").map((entry) => entry.id).sort())
      .toEqual(expected.map(({ id }) => id).sort());
    expect(reviewUsageBeforeAnyReport).toBeUndefined();
  } finally {
    unmount();
  }
}

it("finalizes the parent total under the parent while an inline review is active", () => {
  expectUsageOwnership({ parentCompletion: "before-review-usage", reviewReportsUsage: false, tokens: 123 });
});

it("keeps the delayed parent total after the review collects and finalizes its own usage", () => {
  expectUsageOwnership({ parentCompletion: "after-review-completion", reviewReportsUsage: true, tokens: 123 });
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

it("persists exactly the usage of each turn whose completion arrived", () => {
  fc.assert(fc.property(
    fc.record({
      parentCompletion: fc.constantFrom<ParentCompletion>("before-review-usage", "before-review-completion", "after-review-completion", "missing"),
      reviewReportsUsage: fc.boolean(),
      tokens: fc.integer({ min: 1, max: 10_000 }),
    }),
    expectUsageOwnership,
  ), { numRuns: 25 });
});
