import { act, renderHook, waitFor } from "@testing-library/react";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AppServerReadThreadResponse, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

const sentAt = Date.parse("2026-11-17T02:51:46Z");
const thread: NavigationThreadSummary = {
  id: "thread", source: "codex", title: "Timestamp fixture", titleSource: "explicit",
  summary: "Timestamp fixture", linkedDirectories: [], inbox: { inInbox: false }, updatedAt: sentAt,
};

async function checkUserMessageTimes(hasTimestamp: boolean[], seconds = false, timestampKey = "createdAt") {
  let emit: ((event: AgentEvent) => void) | undefined;
  const desktopApi: DesktopApi = {
    onAgentEvent: (callback) => { emit = callback; return () => undefined; },
    readThread: async (): Promise<AppServerReadThreadResponse> => ({
      backend: "codex", threadId: "thread", fetchedAt: sentAt, threadStatus: "idle",
      replay: { entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } },
    }),
  };
  const { result, unmount } = renderHook(() => useThreadSessionState({ desktopApi, thread }));
  const clock = vi.spyOn(Date, "now");
  try {
    await waitFor(() => expect(result.current.response?.threadId).toBe("thread"));
    let expectedTime: number | undefined;
    for (const [index, supplied] of hasTimestamp.entries()) {
      const receivedAt = sentAt + 5_000 + index * 60_000;
      clock.mockReturnValue(receivedAt);
      // Oracle: item time wins when supplied; an untimed redelivery must
      // retain the first observation rather than invent a later send time.
      expectedTime = supplied ? sentAt : expectedTime ?? receivedAt;
      act(() => emit?.({
        backend: "codex",
        notification: {
          method: index === 0 ? "item/started" : "item/completed",
          params: { threadId: "thread", turnId: "turn", item: {
            id: "user", type: "userMessage", content: [{ type: "text", text: "Steer the turn" }],
            ...(supplied ? { [timestampKey]: seconds ? sentAt / 1_000 : sentAt } : {}),
          } },
        },
      } as AgentEvent));
      const entries = result.current.entries.filter((entry) => entry.type === "message" && entry.id === "user");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.createdAt).toBe(expectedTime);
      expect(result.current.response?.replay.messages.find((message) => message.id === "user")?.createdAt)
        .toBe(expectedTime);
    }
  } finally {
    unmount();
    clock.mockRestore();
  }
}

describe("Live user message timestamp provenance", () => {
  it("preserves the provider send time through an untimed completion echo", async () => {
    await checkUserMessageTimes([true, false]);
  });

  it("keeps provider times or first observations stable across redeliveries", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }),
      fc.boolean(),
      fc.constantFrom("createdAt", "created_at", "timestamp", "time"),
      checkUserMessageTimes,
    ), { numRuns: 25 });
  });
});
