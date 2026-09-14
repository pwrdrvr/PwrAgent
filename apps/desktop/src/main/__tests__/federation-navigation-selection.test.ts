import { describe, expect, it, vi } from "vitest";
import type { NavigationSnapshot, NavigationThreadSummary, NavigationQueryRequest } from "@pwragent/shared";
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
  it("protocol-2 pin queries preserve descendants without unrelated rows", async () => {
    const parent = thread("parent");
    const child = thread("child", { parentThreadId: "parent", parentThreadBackend: "codex" });
    const grandchild = thread("grandchild", { parentThreadId: "child", parentThreadBackend: "codex" });
    const rows = [parent, child, grandchild, ...Array.from({ length: 10_000 }, (_, i) => thread(`unrelated-${i}`))];
    const store = new NavigationQueryStore();
    const page = await readFederationPinnedSnapshot({ getNavigationQueryPage: (request) =>
      store.readPage({ scopeKey: "viewer", loadIndex: async () => snapshot(rows), request }),
    } as FederationBackendOperations, ["codex:parent"]);
    expect(page.threads.map((row) => row.id).sort()).toEqual(["child", "grandchild", "parent"]);
    expect(page.threads.find((row) => row.id === "grandchild")?.parentThreadId).toBe("child");
    expect(page.directories).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4096);
  });

  it("pages a complete closure with stable revision, row and UTF-8 budgets", async () => {
    const value = snapshot([thread("root"), ...Array.from({ length: 205 }, (_, i) =>
      thread(`child-${String(i).padStart(3, "0")}`, { parentThreadId: "root", title: "日".repeat(1200) }))]);
    const getNavigationSnapshot = vi.fn();
    const store = new NavigationQueryStore();
    const getNavigationDescendantPage = vi.fn();
    const getNavigationQueryPage = vi.fn(async (request: NavigationQueryRequest) => {
      const page = await store.readPage({ scopeKey: "viewer", loadIndex: async () => value, request });
      expect(page.entries.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256 * 1024);
      return page;
    });
    const result = await readFederationPinnedSnapshot({ getNavigationQueryPage, getNavigationDescendantPage, getNavigationSnapshot } as unknown as FederationBackendOperations,
      ["codex:root"]);
    expect(result.threads).toHaveLength(206);
    expect(new Set(result.threads.map((row) => row.id)).size).toBe(206);
    expect(getNavigationQueryPage.mock.calls.length).toBeGreaterThan(2);
    expect(getNavigationDescendantPage).not.toHaveBeenCalled();
    expect(getNavigationQueryPage.mock.calls[0]?.[0].query).toEqual({ kind: "group-members", roots: [{ backend: "codex", threadId: "root" }] });
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
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

  it("terminates repeated cursors", async () => {
    const backend = { getNavigationQueryPage: async () => ({ protocol: 2, generation: "1", queryKey: "q", ownerEpoch: "e", coverage: { state: "complete" }, entries: [], nextCursor: "same", complete: false }) } as unknown as FederationBackendOperations;
    await expect(readFederationPinnedSnapshot(backend, ["codex:a"])).rejects.toThrow("inconsistent");
  });
});
