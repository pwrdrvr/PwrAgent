import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerReadThreadResponse, AppServerThreadMessageEntry } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

const backgroundThread: NavigationThreadSummary = {
  id: "background",
  title: "Scheduled thread",
  titleSource: "explicit",
  summary: "",
  source: "claude",
  inbox: { inInbox: false },
  linkedDirectories: [],
  updatedAt: 1,
};

async function checkUnopenedTranscript(streamItems: boolean[]) {
  const messages: AppServerThreadMessageEntry[] = [];
  const readResponse = (threadId: string): AppServerReadThreadResponse => ({
    backend: "claude",
    threadId,
    fetchedAt: 2,
    replay: {
      entries: threadId === backgroundThread.id ? messages : [],
      messages: threadId === backgroundThread.id ? messages : [],
      pagination: { supportsPagination: false, hasPreviousPage: false },
    },
  });
  let emit: (event: AgentEvent) => void = () => { throw new Error("missing subscription"); };
  let finishRead: (() => void) | undefined;
  const desktopApi: DesktopApi = {
    onAgentEvent: (listener) => { emit = listener; return () => undefined; },
    readThread: ({ threadId }) => threadId === backgroundThread.id
      ? new Promise((resolve) => { finishRead = () => resolve(readResponse(threadId)); })
      : Promise.resolve(readResponse(threadId)),
  };
  const opened = renderHook(({ thread }) => useThreadSessionState({ desktopApi, thread }), {
    initialProps: { thread: { ...backgroundThread, id: "selected" } },
  });
  try {
    await act(async () => {});
    for (const [index, streamItem] of streamItems.entries()) {
      const threadId = backgroundThread.id;
      const turnId = `scheduled-${index}`;
      const itemId = `answer-${index}`;
      const text = `Scheduled answer ${index}`;
      act(() => emit({ backend: "claude", notification: { method: "turn/started", params: {
        threadId, turn: { id: turnId, status: "in_progress" },
      } } }));
      expect(opened.result.current.thinkingThreadKeys["claude:background"]).toBe(true);
      act(() => {
        if (streamItem) {
          emit({ backend: "claude", notification: { method: "item/completed", params: {
            threadId, turnId, item: { id: itemId, type: "agentMessage", phase: "final_answer", text },
          } } });
        }
        emit({ backend: "claude", notification: { method: "turn/completed", params: {
          threadId, turnId, turn: { id: turnId, status: "completed", output: [{ type: "text", text }] },
        } } });
      });
      expect(opened.result.current.thinkingThreadKeys["claude:background"]).toBeUndefined();
      messages.push({ type: "message", id: itemId, role: "assistant", phase: "final", text });
    }
    opened.rerender({ thread: backgroundThread });
    // Background events supply lifecycle state. The owner's first read supplies history.
    expect(finishRead).toBeDefined();
    expect(opened.result.current.entries).toEqual([]);
    await act(async () => finishRead?.());
    expect(opened.result.current.entries.map(({ id }) => id)).toEqual(messages.map(({ id }) => id));
  } finally {
    opened.unmount();
  }
}

it("waits for the owner read after an unopened thread's completion-only answer", async () => {
  await checkUnopenedTranscript([false]);
});

it("uses owner history for unopened threads across sequences of scheduled turns", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }), checkUnopenedTranscript), {
    numRuns: 25,
  });
});

it("keeps unopened active turns visible beyond the idle cache limit", () => {
  let emit: (event: AgentEvent) => void = () => { throw new Error("missing subscription"); };
  const desktopApi: DesktopApi = {
    onAgentEvent: (listener) => { emit = listener; return () => undefined; },
  };
  const { result } = renderHook(() => useThreadSessionState({ desktopApi }));
  const threadIds = Array.from({ length: 12 }, (_, index) => `background-${index}`);
  act(() => {
    for (const threadId of threadIds) {
      emit({ backend: "claude", notification: { method: "turn/started", params: {
        threadId, turn: { id: `turn-${threadId}`, status: "in_progress" },
      } } });
    }
  });
  expect(Object.keys(result.current.thinkingThreadKeys).sort()).toEqual(
    threadIds.map((id) => `claude:${id}`).sort(),
  );
  act(() => {
    for (const threadId of threadIds) {
      emit({ backend: "claude", notification: { method: "turn/completed", params: {
        threadId, turnId: `turn-${threadId}`, turn: { id: `turn-${threadId}`, status: "completed", output: [] },
      } } });
    }
  });
  expect(result.current.thinkingThreadKeys).toEqual({});
});
