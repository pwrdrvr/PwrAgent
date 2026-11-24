import { act, renderHook } from "@testing-library/react";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerThreadMessageEntry } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { expect, it, vi } from "vitest";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

const thread: NavigationThreadSummary = {
  id: "cost", title: "Cost fixture", titleSource: "explicit", summary: "",
  source: "claude", linkedDirectories: [], inbox: { inInbox: false },
};
const start = 1_800_000_000_000;

async function measure(size: number) {
  let fieldReads = 0;
  const page = Array.from({ length: size }, (_, index) => new Proxy<AppServerThreadMessageEntry>({
    id: `message-${index}`, type: "message", role: "assistant", text: `Later reply ${index}`,
    createdAt: start + 100_000 + index, turn: { id: "later-turn", status: "completed" },
  }, {
    get(target, field, receiver) {
      if (field === "type") fieldReads += 1;
      return Reflect.get(target, field, receiver);
    },
  }));
  // The refreshed owner page must overlap an owner-confirmed turn before
  // retaining history. Keep a real anchor so this test measures review work
  // with a valid bridge, independent of gap recovery.
  const anchor: AppServerThreadMessageEntry = {
    id: "owner-anchor", type: "message", role: "assistant", text: "Earlier owner reply",
    createdAt: start - 1, turn: { id: "owner-anchor-turn", status: "completed" },
  };
  let entries = [anchor];
  let emit: (event: AgentEvent) => void = () => { throw new Error("missing subscription"); };
  const readThread = vi.fn<NonNullable<DesktopApi["readThread"]>>(async () => ({
    backend: "claude", threadId: thread.id, fetchedAt: Date.now(),
    replay: { entries, messages: entries, pagination: entries.length
      ? { supportsPagination: true, hasPreviousPage: true, previousCursor: entries[0]!.id }
      : { supportsPagination: true, hasPreviousPage: false } },
  }));
  const desktopApi: DesktopApi = {
    readThread, onAgentEvent: (listener) => { emit = listener; return () => undefined; },
  };
  const { result, unmount } = renderHook(() => useThreadSessionState({ desktopApi, thread, initialHistoryLimit: 2 }));
  const clock = vi.spyOn(Date, "now");
  try {
    await act(async () => {});
    act(() => {
      for (let index = 0; index < size; index++) {
        const turnId = `old-turn-${index}`;
        const createdAt = start + 10 * index;
        clock.mockReturnValue(createdAt);
        emit({ backend: "claude", notification: { method: "turn/started", params: {
          threadId: thread.id, turn: { id: turnId, status: "in_progress", startedAt: createdAt },
        } } });
        emit({ backend: "claude", notification: { method: "item/completed", params: {
          threadId: thread.id, turnId, item: {
            id: `review-${index}`, type: "exitedReviewMode", review: `Older findings ${index}`, createdAt: createdAt + 1,
          },
        } } });
        emit({ backend: "claude", notification: { method: "turn/completed", params: {
          threadId: thread.id, turnId, turn: { id: turnId, status: "completed", completedAt: createdAt + 2, output: [] },
        } } });
      }
    });
    entries = [anchor, ...page];
    clock.mockReturnValue(start + 200_000);
    await act(async () => { await result.current.reload(); });
    expect(result.current.entries.length).toBe(2 * size + 1);
    fieldReads = 0;
    const readsBefore = readThread.mock.calls.length;
    act(() => { result.current.addOptimisticReviewEntry("Review sample"); });
    const observed = fieldReads;
    expect(readThread).toHaveBeenCalledTimes(readsBefore);
    expect(result.current.entries).toHaveLength(2 * size + 2);
    return observed;
  } finally {
    clock.mockRestore();
    unmount();
  }
}

it("keeps a new review start linear in retained optimistic reviews and newest-page rows", async () => {
  const counts = [50, 100, 200];
  const observed: number[] = [];
  for (const count of counts) observed.push(await measure(count));
  expect(observed[2]!, JSON.stringify({ counts, observed })).toBeLessThan(observed[1]! * 2.5);
});
