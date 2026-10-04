import { describe, expect, it, vi } from "vitest";
import type {
  NavigationThreadSummary,
  ThreadPricingSummary,
} from "@pwragent/shared";
import { readThreadFamilyPricing } from "../app-server/thread-family-pricing";

function thread(
  id: string,
  patch: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id,
    source: "codex",
    title: `Thread ${id}`,
    titleSource: "derived",
    createdAt: 1,
    updatedAt: 1,
    linkedDirectories: [{ id: "repo", kind: "local", label: "repo", path: "/repo" }],
    inbox: { inInbox: false },
    ...patch,
  };
}

function summary(threadId: string, totalCostMicros: number, patch: Partial<ThreadPricingSummary> = {}): ThreadPricingSummary {
  return {
    backend: "codex",
    cachedInputTokens: 0,
    currency: "USD",
    inputTokens: 0,
    outputTokens: 0,
    pricedUsageLineCount: 1,
    provider: "openai",
    reasoningOutputTokens: 0,
    threadId,
    totalCostMicros,
    totalTokens: 0,
    uncachedInputTokens: 0,
    unpricedUsageLineCount: 0,
    updatedAt: 1,
    usageLineCount: 1,
    ...patch,
  };
}

describe("readThreadFamilyPricing", () => {
  const threads = [
    thread("parent", { title: "Billing export v2" }),
    thread("fork-a", { title: "Fork: CSV encoder", parentThreadId: "parent", threadStatus: "active" }),
    thread("fork-a-1", { title: "Schema check", parentThreadId: "fork-a" }),
    thread("fork-b", { title: "Retry policy", parentThreadId: "parent" }),
    // A native worker's usage already rolls up into its parent's own total.
    thread("worker", { parentThreadId: "parent", codexNativeSubAgent: { parentThreadId: "parent" } }),
    thread("unrelated"),
  ];
  const loadIndex = async () => ({ directories: [], threads });

  it("totals the thread and every sub-thread beneath it, largest first", async () => {
    const readSummaries = vi.fn(async (_threads: Array<{ backend: string; threadId: string }>) => [
      summary("parent", 1_840_000),
      summary("fork-a", 920_000),
      summary("fork-a-1", 120_000),
      summary("fork-b", 610_000, { unpricedUsageLineCount: 2 }),
      // Another provider on the same thread adds up; another currency does not.
      summary("fork-b", 10_000, { provider: "anthropic" }),
      summary("fork-b", 999_000, { currency: "EUR" }),
    ]);

    const family = await readThreadFamilyPricing({
      request: { backend: "codex", threadId: "parent" },
      loadIndex,
      readSummaries,
      now: () => 42,
    });

    expect(readSummaries.mock.calls[0]?.[0]?.map((member) => member.threadId).sort())
      .toEqual(["fork-a", "fork-a-1", "fork-b", "parent"]);
    expect(family).toEqual({
      readAt: 42,
      members: [
        { backend: "codex", threadId: "parent", title: "Billing export v2", self: true, active: false, totalCostMicros: 1_840_000, usageLineCount: 1, unpricedUsageLineCount: 0 },
        { backend: "codex", threadId: "fork-a", title: "Fork: CSV encoder", self: false, active: true, totalCostMicros: 920_000, usageLineCount: 1, unpricedUsageLineCount: 0 },
        { backend: "codex", threadId: "fork-b", title: "Retry policy", self: false, active: false, totalCostMicros: 620_000, usageLineCount: 2, unpricedUsageLineCount: 2 },
        { backend: "codex", threadId: "fork-a-1", title: "Schema check", self: false, active: false, totalCostMicros: 120_000, usageLineCount: 1, unpricedUsageLineCount: 0 },
      ],
    });
  });

  it("reads from a sub-thread down, not up to its parent", async () => {
    const family = await readThreadFamilyPricing({
      request: { backend: "codex", threadId: "fork-a" },
      loadIndex,
      readSummaries: async () => [summary("fork-a", 920_000)],
    });

    expect(family.members.map((member) => [member.threadId, member.self, member.totalCostMicros])).toEqual([
      ["fork-a", true, 920_000],
      ["fork-a-1", false, 0],
    ]);
  });
});
