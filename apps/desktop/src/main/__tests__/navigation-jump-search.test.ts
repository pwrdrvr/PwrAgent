import { describe, expect, it, vi } from "vitest";
import type { FederationJumpSearchProgress, NavigationQueryRequest } from "@pwragent/shared";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { stampRemoteNavigationQueryPage } from "../federation/federation-navigation-query";
import { searchNavigationOwners } from "../app-server/navigation-jump-search";

const owner = (id: string) => ({ label: id, target: { scope: "remote" as const, instanceId: id } });
async function page(request: NavigationQueryRequest) {
  const target = request.federationTarget;
  if (target?.scope !== "remote") throw new Error("Expected an explicit owner");
  const result = await new NavigationQueryStore().readPage({ scopeKey: target.instanceId, request,
    loadIndex: async () => ({ directories: [], threads: [{ id: "same-id", source: "codex",
      title: "Navigation work", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    }] }) });
  return stampRemoteNavigationQueryPage({ target, instanceLabel: target.instanceId, page: result });
}

describe("bounded navigation jump search", () => {
  it("preserves equal thread ids on different owners and publishes a fast owner independently", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const progress: FederationJumpSearchProgress[] = [];
    const readPage = vi.fn(async (request: NavigationQueryRequest) => {
      if (request.federationTarget?.scope === "remote" && request.federationTarget.instanceId === "slow") await gate;
      return page(request);
    });
    const pending = searchNavigationOwners({ request: { query: "Navigation" }, owners: [owner("fast"), owner("slow")],
      readPage, onProgress: (value) => progress.push(value) });
    await vi.waitFor(() => expect(progress).toHaveLength(1));
    expect(progress[0]).toMatchObject({ completedPeerCount: 1, totalPeerCount: 2, complete: false,
      results: [{ ref: { ownerInstanceId: "fast", threadId: "same-id" } }] });
    finish();
    const result = await pending;
    expect(result.results).toHaveLength(2);
    expect(result.incomplete).toBeUndefined();
    expect(readPage.mock.calls.every(([request]) => request.pageSize === 8 && request.inventory === "owner")).toBe(true);
  });

  it("reports upgrade failure and omitted owners without a snapshot fallback", async () => {
    const readPage = vi.fn(async () => { throw new Error("Upgrade the owning instance to navigation query protocol 2."); });
    const result = await searchNavigationOwners({ request: { query: "Navigation" },
      owners: Array.from({ length: 12 }, (_, index) => owner(`peer-${index}`)), readPage });
    expect(readPage).toHaveBeenCalledTimes(8);
    expect(result).toMatchObject({ results: [], incomplete: true });
    expect(result.notes?.join(" ")).toContain("Upgrade the owning instance");
    expect(result.notes?.join(" ")).toContain("eight instances");
  });

  it("rejects a row stamped with a different owner instead of resolving a same-id thread", async () => {
    const result = await searchNavigationOwners({ request: { query: "Navigation" }, owners: [owner("requested")],
      readPage: async (request) => {
        const response = await page(request);
        response.entries[0]!.row.ref.ownerInstanceId = "wrong-owner";
        return response;
      } });
    expect(result.results).toEqual([]);
    expect(result.incomplete).toBe(true);
    expect(result.notes?.join(" ")).toContain("mismatched search identity");
  });
});
