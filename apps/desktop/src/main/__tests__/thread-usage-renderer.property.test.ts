// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { formatTokenUsageMicrosAsUsd, type AgentEvent, type AppServerThreadEntry } from "@pwragent/shared";
import type { DesktopApi } from "../../renderer/src/lib/desktop-api";
import { useThreadSessionState } from "../../renderer/src/lib/useThreadSessionState";
import { buildLiveThreadUsageLine } from "../app-server/thread-usage-math";

const cutover = Date.parse("2027-03-01T00:00:00-08:00");

async function compareUsagePrices(itemAt: number, observedAt: number, outputTokens: number) {
  const now = vi.spyOn(Date, "now").mockReturnValue(observedAt + 50);
  const message: AppServerThreadEntry = {
    type: "message", id: "assistant", role: "assistant", text: "Working", createdAt: itemAt,
    turn: { id: "turn", status: "completed" },
  };
  let deliver: ((event: AgentEvent) => void) | undefined;
  const desktopApi: DesktopApi = {
    onAgentEvent: (callback) => { deliver = callback; return () => {}; },
    readThread: async () => ({
      backend: "codex", fetchedAt: observedAt, threadId: "thread",
      replay: { entries: [message], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } },
    }),
  };
  const mounted = renderHook(() => useThreadSessionState({
    desktopApi,
    thread: {
      id: "thread", title: "Thread", titleSource: "explicit", summary: "Thread", source: "codex", linkedDirectories: [],
      inbox: { inInbox: false }, updatedAt: itemAt,
    },
  }));
  try {
    await waitFor(() => expect(mounted.result.current.response?.threadId).toBe("thread"));
    const tokens = { inputTokens: 0, outputTokens };
    const event: AgentEvent & { usagePricingAt: number } = {
      backend: "codex", usagePricingAt: observedAt,
      notification: {
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread", turnId: "turn", model: "gpt-6.2-sol", tokenUsage: {
          serviceTier: "ultrafast", last: tokens, total: tokens,
        } },
      },
    };
    act(() => deliver?.(event));
    const activity = mounted.result.current.entries.find((entry) => entry.type === "activity");
    const ledger = buildLiveThreadUsageLine({
      backend: "codex", createdAt: observedAt, model: "gpt-6.2-sol", serviceTier: "ultrafast",
      threadId: "thread", turnId: "turn", tokenUsage: tokens,
    });
    expect(activity).toMatchObject({
      createdAt: itemAt,
      summary: expect.stringContaining(`${formatTokenUsageMicrosAsUsd(ledger!.totalCostMicros)} list price`),
    });
  } finally {
    mounted.unmount();
    now.mockRestore();
  }
}

it("keeps transcript placement while matching the owner's price at the observed usage time", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 1000 }), fc.nat(1000), fc.integer({ min: 1_000, max: 100_000 }),
    async (before, after, outputTokens) => {
      await compareUsagePrices(cutover - before, cutover + after, outputTokens);
    },
  ), { numRuns: 25 });
});

it("keeps the pre-cutover transcript timestamp and displays the post-cutover $6 price", async () => {
  await compareUsagePrices(cutover - 1, cutover, 100_000);
});
