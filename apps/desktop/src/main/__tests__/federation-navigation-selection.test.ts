import { describe, expect, it, vi } from "vitest";
import type { NavigationQueryRequest, NavigationSnapshot, NavigationThreadSummary } from "@pwragent/shared";
import { buildFederatedThreadRef, NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared";
import { projectNavigationDescendantPage } from "../federation/federation-navigation-selection";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { readFederationPinnedSnapshot } from "../federation/federation-collection-client";
import type { FederationBackendOperations } from "../federation/federation-backend-bridge";

function thread(id: string, extra: Partial<NavigationThreadSummary> = {}): NavigationThreadSummary {
  return { source: "codex", id, title: id, linkedDirectories: [], inbox: { inInbox: false }, ...extra } as NavigationThreadSummary;
}
function snapshot(threads: NavigationThreadSummary[]): NavigationSnapshot {
  return { backend: "all", fetchedAt: 1, unchanged: false, threads, directories: [], inboxThreadKeys: [],
    launchpadDefaults: { backend: "codex", executionMode: "default" } };
}

describe("owner-filtered navigation descendants", () => {
  it("sparse_parent_selection_preserves_remote_descendants without unrelated rows", () => {
    const parent = thread("parent");
    const child = thread("child", {
      parentThreadId: "parent", parentThreadBackend: "codex", parentThreadInstanceId: "owner",
      federation: { ref: buildFederatedThreadRef({ backend: "codex", instanceId: "third", threadId: "child" }),
        instanceLabel: "Third", peerStatus: "connected", capabilities: [] },
    });
    const grandchild = thread("grandchild", {
      parentThreadId: "child", parentThreadBackend: "codex", parentThreadInstanceId: "third",
    });
    const rows = [parent, child, grandchild, ...Array.from({ length: 10_000 }, (_, i) => thread(`unrelated-${i}`))];
    const page = projectNavigationDescendantPage(snapshot(rows), "1", { threadKeys: ["codex:parent"] });
    expect(page.snapshot.threads.map((row) => row.id).sort()).toEqual(["child", "grandchild", "parent"]);
    expect(page.snapshot.threads.find((row) => row.id === "child")?.federation?.ref).toEqual(child.federation?.ref);
    expect(page.snapshot.directories).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4096);
  });

  it("pages a complete closure with stable revision, row and UTF-8 budgets", async () => {
    const value = snapshot([thread("root"), ...Array.from({ length: 205 }, (_, i) =>
      thread(`child-${String(i).padStart(3, "0")}`, { parentThreadId: "root", title: "日".repeat(1200) }))]);
    const getNavigationSnapshot = vi.fn();
    const store = new NavigationQueryStore();
    const getNavigationQueryPage = vi.fn(async (request: NavigationQueryRequest) => {
      const page = await store.readPage({ request, scopeKey: "viewer", loadIndex: async () => value });
      expect(page.entries.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(NAVIGATION_QUERY_MAX_RESULT_BYTES);
      return page;
    });
    const getNavigationDescendantPage = vi.fn().mockRejectedValue(new Error("Retired protocol"));
    const result = await readFederationPinnedSnapshot({ getNavigationQueryPage, getNavigationDescendantPage, getNavigationSnapshot } as unknown as FederationBackendOperations,
      ["codex:root"]);
    expect(result.threads).toHaveLength(206);
    expect(new Set(result.threads.map((row) => row.id)).size).toBe(206);
    expect(getNavigationQueryPage.mock.calls.length).toBeGreaterThan(2);
    expect(getNavigationDescendantPage).not.toHaveBeenCalled();
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
    expect(() => projectNavigationDescendantPage(value, "2", { threadKeys: ["codex:root"], revision: "1" })).toThrow("changed");
  });

  it("batches more than 100 roots and deduplicates overlapping descendant groups", async () => {
    const value = snapshot(Array.from({ length: 101 }, (_, i) => thread(`root-${i}`)));
    value.threads.push(thread("child", { parentThreadId: "root-0" }));
    const store = new NavigationQueryStore();
    const getNavigationQueryPage = vi.fn((request: NavigationQueryRequest) =>
      store.readPage({ request, scopeKey: "viewer", loadIndex: async () => value }));
    const result = await readFederationPinnedSnapshot({ getNavigationQueryPage } as unknown as FederationBackendOperations,
      [...value.threads.map((row) => `codex:${row.id}`), "codex:root-0"]);
    expect(result.threads).toHaveLength(102);
    expect(getNavigationQueryPage.mock.calls.every(([request]) =>
      request.query.kind === "group-members" && request.query.roots.length <= 100)).toBe(true);
  });

  it.each(["generation", "ownerEpoch", "queryKey"] as const)("rejects %s drift between pages", async (field) => {
    const page = { protocol: 2, ownerEpoch: "owner", generation: "1", queryKey: "pins",
      entries: [], complete: false, nextCursor: "next" };
    const getNavigationQueryPage = vi.fn().mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ ...page, [field]: "changed", complete: true, nextCursor: undefined });
    await expect(readFederationPinnedSnapshot({ getNavigationQueryPage } as unknown as FederationBackendOperations,
      ["codex:root"])).rejects.toThrow("inconsistent");
  });

  it("requires an upgrade for a missing bounded method and never falls back after a timeout", async () => {
    const getNavigationSnapshot = vi.fn(async () => snapshot([]));
    const getNavigationQueryPage = vi.fn().mockRejectedValue({ code: "method_not_found" });
    const backend = { getNavigationSnapshot, getNavigationQueryPage } as unknown as FederationBackendOperations;
    await expect(readFederationPinnedSnapshot(backend, ["codex:root"])).rejects.toThrow("Upgrade");
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
    getNavigationQueryPage.mockRejectedValue(new Error("timeout"));
    await expect(readFederationPinnedSnapshot(backend, ["codex:root"])).rejects.toThrow("timeout");
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
  });

  it("rejects oversized rows and terminates cycles and repeated cursors", async () => {
    const value = snapshot([thread("a", { parentThreadId: "b" }), thread("b", { parentThreadId: "a" })]);
    expect(projectNavigationDescendantPage(value, "1", { threadKeys: ["codex:a"] }).snapshot.threads).toHaveLength(2);
    expect(() => projectNavigationDescendantPage(snapshot([thread("a", { title: "日".repeat(100_000) })]), "1",
      { threadKeys: ["codex:a"] })).toThrow("byte budget");
    const backend = { getNavigationQueryPage: async () => ({ protocol: 2, ownerEpoch: "owner", generation: "1",
      queryKey: "pins", entries: [], complete: false, nextCursor: "same" }) } as unknown as FederationBackendOperations;
    await expect(readFederationPinnedSnapshot(backend, ["codex:a"])).rejects.toThrow("inconsistent");
  });
});
