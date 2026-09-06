import { describe, expect, it, vi } from "vitest";
import type { NavigationSnapshot, NavigationThreadSummary } from "@pwragent/shared";
import { buildFederatedThreadRef } from "@pwragent/shared";
import { projectNavigationDescendantPage, type FederationNavigationSelectionRequest } from "../federation/federation-navigation-selection";
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
    const getNavigationDescendantPage = vi.fn(async (request: FederationNavigationSelectionRequest) => {
      const page = projectNavigationDescendantPage(value, "1", request);
      expect(page.snapshot.threads.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256 * 1024);
      return page;
    });
    const result = await readFederationPinnedSnapshot({ getNavigationDescendantPage, getNavigationSnapshot } as unknown as FederationBackendOperations,
      ["codex:root"]);
    expect(result.threads).toHaveLength(206);
    expect(new Set(result.threads.map((row) => row.id)).size).toBe(206);
    expect(getNavigationDescendantPage.mock.calls.length).toBeGreaterThan(2);
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
    expect(() => projectNavigationDescendantPage(value, "2", { threadKeys: ["codex:root"], revision: "1" })).toThrow("changed");
  });

  it("only method-not-found permits a legacy full baseline", async () => {
    const getNavigationSnapshot = vi.fn(async () => snapshot([]));
    const getNavigationDescendantPage = vi.fn().mockRejectedValue({ code: "method_not_found" });
    const backend = { getNavigationSnapshot, getNavigationDescendantPage } as unknown as FederationBackendOperations;
    await readFederationPinnedSnapshot(backend, ["codex:root"]);
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
    getNavigationSnapshot.mockClear();
    getNavigationDescendantPage.mockRejectedValue(new Error("timeout"));
    await expect(readFederationPinnedSnapshot(backend, ["codex:root"])).rejects.toThrow("timeout");
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
  });

  it("rejects oversized rows and terminates cycles and repeated cursors", async () => {
    const value = snapshot([thread("a", { parentThreadId: "b" }), thread("b", { parentThreadId: "a" })]);
    expect(projectNavigationDescendantPage(value, "1", { threadKeys: ["codex:a"] }).snapshot.threads).toHaveLength(2);
    expect(() => projectNavigationDescendantPage(snapshot([thread("a", { title: "日".repeat(100_000) })]), "1",
      { threadKeys: ["codex:a"] })).toThrow("byte budget");
    const backend = { getNavigationDescendantPage: async () => ({ revision: "1", snapshot: value, nextAfterKey: "same" }) } as unknown as FederationBackendOperations;
    await expect(readFederationPinnedSnapshot(backend, ["codex:a"])).rejects.toThrow("inconsistent");
  });
});
