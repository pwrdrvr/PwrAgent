import { describe, expect, it, vi } from "vitest";
import type {
  NavigationThreadSummary,
  ThreadPricingSummary,
} from "@pwragent/shared";
import type { NavigationIdentity, ReadThreadFamilyPricingResponse, ThreadFamilyPricingMember } from "@pwragent/shared";
import {
  readFederatedThreadFamilyPricing,
  readThreadFamilyPricing,
  threadFamilyPricingForPeer,
} from "../app-server/thread-family-pricing";

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
      root: { backend: "codex", threadId: "parent" },
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
      root: { backend: "codex", threadId: "fork-a" },
      loadIndex,
      readSummaries: async () => [summary("fork-a", 920_000)],
    });

    expect(family.members.map((member) => [member.threadId, member.self, member.totalCostMicros])).toEqual([
      ["fork-a", true, 920_000],
      ["fork-a-1", false, 0],
    ]);
  });

  it("refers pinned sub-threads on other machines to their owners instead of pricing them", async () => {
    const pinned = (id: string, instanceId: string, patch: Partial<NavigationThreadSummary> = {}) => thread(id, {
      federation: {
        instanceLabel: `Mac ${instanceId}`,
        ref: { target: { scope: "remote", instanceId }, backend: "codex", threadId: id } as never,
      },
      // The owner records its parent's instance, which is this machine.
      parentThreadInstanceId: "viewer",
      ...patch,
    });
    const readSummaries = vi.fn(async () => [summary("parent", 1_000_000)]);
    const family = await readThreadFamilyPricing({
      root: { backend: "codex", threadId: "parent" },
      loadIndex: async () => ({
        directories: [],
        localInstanceId: "viewer",
        threads: [
          thread("parent", { title: "Parent" }),
          pinned("on-m5", "m5", { title: "Actool readiness", source: "claude", parentThreadId: "parent" }),
          pinned("on-m2", "m2", { title: "M2 readiness", parentThreadId: "parent" }),
          pinned("elsewhere", "m2", { parentThreadId: "unrelated" }),
        ],
      }),
      readSummaries,
    });

    expect(readSummaries.mock.calls[0]).toEqual([[{ backend: "codex", threadId: "parent", title: "Parent", threadStatus: undefined }]]);
    expect(family.members.map((member) => member.threadId)).toEqual(["parent"]);
    expect(family.referrals).toHaveLength(2);
    expect(family.referrals).toEqual(expect.arrayContaining([
      { backend: "claude", threadId: "on-m5", ownerInstanceId: "m5", title: "Actool readiness", instanceLabel: "Mac m5" },
      { backend: "codex", threadId: "on-m2", ownerInstanceId: "m2", title: "M2 readiness", instanceLabel: "Mac m2" },
    ]));
    // A peer learns which threads to ask about, never another instance's titles.
    expect(threadFamilyPricingForPeer(family).referrals).toEqual(expect.arrayContaining([
      { backend: "claude", threadId: "on-m5", ownerInstanceId: "m5" },
      { backend: "codex", threadId: "on-m2", ownerInstanceId: "m2" },
    ]));
  });

  it("finds this machine's sub-threads under a thread another instance owns", async () => {
    const family = await readThreadFamilyPricing({
      root: { backend: "codex", threadId: "remote-parent", ownerInstanceId: "m5" },
      loadIndex: async () => ({
        directories: [],
        localInstanceId: "viewer",
        threads: [thread("local-child", { parentThreadId: "remote-parent", parentThreadInstanceId: "m5" })],
      }),
      readSummaries: async () => [summary("local-child", 250_000)],
    });

    expect(family.members.map(({ threadId, self, totalCostMicros }) => ({ threadId, self, totalCostMicros })))
      .toEqual([{ threadId: "local-child", self: false, totalCostMicros: 250_000 }]);
  });
});

describe("readFederatedThreadFamilyPricing", () => {
  function priced(threadId: string, totalCostMicros: number, patch: Partial<ThreadFamilyPricingMember> = {}): ThreadFamilyPricingMember {
    return {
      backend: "codex", threadId, title: `Thread ${threadId}`, self: false, active: false,
      totalCostMicros, usageLineCount: 1, unpricedUsageLineCount: 0, ...patch,
    };
  }

  it("asks each owner for its own sub-threads and adds them into one family", async () => {
    const readLocal = vi.fn(async (root: NavigationIdentity): Promise<ReadThreadFamilyPricingResponse> => root.ownerInstanceId
      ? { readAt: 1, members: [] }
      : {
          readAt: 1,
          members: [priced("parent", 14_160_000, { self: true }), priced("local-child", 1_480_000)],
          referrals: [
            { backend: "claude", threadId: "on-m5", ownerInstanceId: "m5", title: "Actool readiness", instanceLabel: "M5 Max" },
            { backend: "codex", threadId: "on-m2", ownerInstanceId: "m2", title: "M2 readiness", instanceLabel: "M2 Max" },
          ],
        });
    const readRemote = vi.fn(async (instanceId: string, root: { backend: string; threadId: string }): Promise<ReadThreadFamilyPricingResponse> => {
      if (instanceId === "m5") {
        // The owner reports its own thread as "self" and the reader re-roots it.
        return { readAt: 2, members: [priced(root.threadId, 3_200_000, { backend: "claude", self: true, active: true, title: "Actool readiness" })] };
      }
      return {
        readAt: 2,
        members: [priced(root.threadId, 900_000, { self: true, title: "M2 readiness" }), priced("m2-grandchild", 100_000)],
        // A referral back to this machine is already counted.
        referrals: [{ backend: "codex", threadId: "local-child", ownerInstanceId: "viewer" }],
      };
    });

    const family = await readFederatedThreadFamilyPricing({
      root: { backend: "codex", threadId: "parent" },
      readLocal,
      readRemote,
      localInstanceId: "viewer",
      peerLabel: (instanceId) => instanceId === "m5" ? "Harold-MBP-M5-Max / default" : undefined,
      now: () => 99,
    });

    expect(readRemote.mock.calls.map(([instanceId, root]) => [instanceId, root.backend, root.threadId]).sort())
      .toEqual([["m2", "codex", "on-m2"], ["m5", "claude", "on-m5"]]);
    expect(family.readAt).toBe(99);
    expect(family.members.map(({ threadId, self, active, totalCostMicros, ownerInstanceId, instanceLabel }) =>
      ({ threadId, self, active, totalCostMicros, ownerInstanceId, instanceLabel }))).toEqual([
      { threadId: "parent", self: true, active: false, totalCostMicros: 14_160_000, ownerInstanceId: undefined, instanceLabel: undefined },
      { threadId: "on-m5", self: false, active: true, totalCostMicros: 3_200_000, ownerInstanceId: "m5", instanceLabel: "Harold-MBP-M5-Max / default" },
      { threadId: "local-child", self: false, active: false, totalCostMicros: 1_480_000, ownerInstanceId: undefined, instanceLabel: undefined },
      { threadId: "on-m2", self: false, active: false, totalCostMicros: 900_000, ownerInstanceId: "m2", instanceLabel: "M2 Max" },
      { threadId: "m2-grandchild", self: false, active: false, totalCostMicros: 100_000, ownerInstanceId: "m2", instanceLabel: "M2 Max" },
    ]);
    expect(family.members.reduce((sum, member) => sum + member.totalCostMicros, 0)).toBe(19_840_000);
  });

  it("keeps an unreachable sub-thread listed but out of the total", async () => {
    const family = await readFederatedThreadFamilyPricing({
      root: { backend: "codex", threadId: "parent" },
      readLocal: async (root) => root.ownerInstanceId ? { readAt: 1, members: [] } : {
        readAt: 1,
        members: [priced("parent", 1_000_000, { self: true })],
        referrals: [{ backend: "codex", threadId: "on-m2", ownerInstanceId: "m2", title: "M2 readiness", instanceLabel: "M2 Max" }],
      },
      readRemote: async () => { throw new Error("Peer m2 is not connected."); },
      localInstanceId: "viewer",
    });

    expect(family.members).toEqual([
      priced("parent", 1_000_000, { self: true }),
      {
        backend: "codex", threadId: "on-m2", title: "M2 readiness", self: false, active: false,
        totalCostMicros: 0, usageLineCount: 0, unpricedUsageLineCount: 0,
        ownerInstanceId: "m2", instanceLabel: "M2 Max", unavailable: true,
      },
    ]);
  });

  it("reads a remote root from its owner and adds this machine's sub-threads under it", async () => {
    const readLocal = vi.fn(async (root: NavigationIdentity): Promise<ReadThreadFamilyPricingResponse> =>
      root.threadId === "remote-parent" ? { readAt: 1, members: [priced("local-child", 500_000)] } : { readAt: 1, members: [] });
    const family = await readFederatedThreadFamilyPricing({
      root: { backend: "codex", threadId: "remote-parent", ownerInstanceId: "m5" },
      readLocal,
      readRemote: async () => ({ readAt: 2, members: [priced("remote-parent", 2_000_000, { self: true })] }),
      localInstanceId: "viewer",
    });

    expect(readLocal).toHaveBeenCalledWith({ backend: "codex", threadId: "remote-parent", ownerInstanceId: "m5" });
    expect(family.members.map(({ threadId, self, ownerInstanceId }) => ({ threadId, self, ownerInstanceId }))).toEqual([
      { threadId: "remote-parent", self: true, ownerInstanceId: "m5" },
      { threadId: "local-child", self: false, ownerInstanceId: undefined },
    ]);
  });

  it("fails when the remote root itself cannot be read", async () => {
    await expect(readFederatedThreadFamilyPricing({
      root: { backend: "codex", threadId: "remote-parent", ownerInstanceId: "m5" },
      readLocal: async () => ({ readAt: 1, members: [] }),
      readRemote: async () => { throw new Error("Owner disconnected"); },
      localInstanceId: "viewer",
    })).rejects.toThrow("Owner disconnected");
  });

  it("reads each root once when owners refer to each other", async () => {
    const readRemote = vi.fn(async (instanceId: string, root: { backend: string; threadId: string }): Promise<ReadThreadFamilyPricingResponse> => ({
      readAt: 1,
      members: [priced(root.threadId, 1)],
      referrals: [{ backend: "codex", threadId: instanceId === "a" ? "on-b" : "on-a", ownerInstanceId: instanceId === "a" ? "b" : "a" }],
    }));
    const family = await readFederatedThreadFamilyPricing({
      root: { backend: "codex", threadId: "on-a", ownerInstanceId: "a" },
      readLocal: async () => ({ readAt: 1, members: [] }),
      readRemote,
    });
    expect(readRemote).toHaveBeenCalledTimes(2);
    expect(family.members.map((member) => member.threadId).sort()).toEqual(["on-a", "on-b"]);
  });
});
