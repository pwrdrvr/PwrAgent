import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  AgentEvent,
  AppServerReadThreadResponse,
  AppServerThreadEntry,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

// A long Claude thread kept running turns while another thread was open.
// Its live events reached this window before any read of the thread, so the
// window held only the running turn. Opening the thread mid-turn then read
// nothing, because live events own an active turn, and the operator could
// not scroll above that turn until it ended.

function buildThread(id: string, updatedAt: number): NavigationThreadSummary {
  return {
    id,
    title: id,
    titleSource: "explicit",
    summary: "",
    source: "claude",
    linkedDirectories: [],
    inbox: { inInbox: false },
    updatedAt,
  };
}

const history: AppServerThreadEntry[] = [
  {
    type: "message", id: "user:turn-old", role: "user", text: "Earlier prompt",
    createdAt: 1, turn: { id: "turn-old", status: "completed" },
  },
  {
    type: "message", id: "msg-old", role: "assistant", text: "Earlier answer",
    createdAt: 2, turn: { id: "turn-old", status: "completed" },
  },
];

function read(threadId: string, entries: AppServerThreadEntry[]): AppServerReadThreadResponse {
  return {
    backend: "claude",
    fetchedAt: 10,
    threadId,
    threadStatus: threadId === "thread-busy" ? "active" : "idle",
    replay: {
      entries,
      messages: [],
      pagination: { supportsPagination: false, hasPreviousPage: false },
    },
  };
}

describe("useThreadSessionState live events before the first read", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the thread's history when it is opened during a turn", async () => {
    let emit: (event: AgentEvent) => void = () => undefined;
    const liveTurnEntries: AppServerThreadEntry[] = [
      {
        type: "message", id: "user:turn-live", role: "user", text: "Current prompt",
        createdAt: 3, turn: { id: "turn-live", status: "in_progress" },
      },
    ];
    const readThread = vi.fn(async (params: { threadId: string }) =>
      params.threadId === "thread-busy"
        ? read(params.threadId, [...history, ...liveTurnEntries])
        : read(params.threadId, []));
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        emit = listener;
        return () => undefined;
      },
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ thread }) => useThreadSessionState({ desktopApi, thread }),
      { initialProps: { thread: buildThread("thread-other", 1_000) } },
    );
    await waitFor(() => {
      expect(result.current.response?.threadId).toBe("thread-other");
    });

    const send = async (method: string, params: Record<string, unknown>) => {
      await act(async () => {
        emit({ backend: "claude", notification: { method, params } } as AgentEvent);
      });
    };
    await send("turn/started", {
      threadId: "thread-busy",
      turn: { id: "turn-live", status: "in_progress", startedAt: 3 },
    });
    await send("item/completed", {
      threadId: "thread-busy",
      turnId: "turn-live",
      item: { id: "msg-live", type: "agentMessage", text: "Working on it" },
    });
    liveTurnEntries.push({
      type: "message", id: "msg-live", role: "assistant", text: "Working on it",
      createdAt: 4, turn: { id: "turn-live", status: "in_progress" },
    });
    expect(readThread.mock.calls.some(([params]) => params.threadId === "thread-busy")).toBe(false);

    rerender({ thread: buildThread("thread-busy", 2_000) });

    await waitFor(() => {
      expect(result.current.response?.replay.entries.map((entry) => entry.id)).toEqual(
        expect.arrayContaining(["user:turn-old", "msg-old", "msg-live"]),
      );
    });
    expect(readThread.mock.calls.filter(([params]) => params.threadId === "thread-busy")).toHaveLength(1);
  });
});
