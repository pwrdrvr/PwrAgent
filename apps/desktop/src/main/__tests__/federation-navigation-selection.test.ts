import { describe, expect, it, vi } from "vitest";
import type { NavigationSnapshot, NavigationThreadSummary, NavigationQueryRequest } from "@pwragent/shared";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared";
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
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(NAVIGATION_QUERY_MAX_RESULT_BYTES);
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
      coverage: { state: "complete" }, entries: [], complete: false, nextCursor: "next" };
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

  it("terminates repeated cursors", async () => {
    const backend = { getNavigationQueryPage: async () => ({ protocol: 2, generation: "1", queryKey: "q", ownerEpoch: "e", coverage: { state: "complete" }, entries: [], nextCursor: "same", complete: false }) } as unknown as FederationBackendOperations;
    await expect(readFederationPinnedSnapshot(backend, ["codex:a"])).rejects.toThrow("inconsistent");
  });
});

it("reports which provider coverage prevented pin refresh", async () => {
  const backend = { getNavigationQueryPage: async () => ({ protocol: 2, entries: [], complete: true,
    coverage: { state: "degraded", failedProviders: 1, pendingProviders: 2 } }) } as unknown as FederationBackendOperations;
  await expect(readFederationPinnedSnapshot(backend, ["codex:child"]))
    .rejects.toThrow("Pinned navigation owner coverage is degraded (pending providers: 2, failed providers: 1).");
});

it("conditionally revalidates complete pinned groups, including paginated descendants", async () => {
  const rows = [thread("root"), ...Array.from({ length: 205 }, (_, i) => thread(`child-${i}`, { parentThreadId: "root" })), thread("unrelated")];
  const store = new NavigationQueryStore();
  const state = new Map();
  const responses: Array<{ bytes: number; rows: number }> = [];
  const getNavigationQueryPage = vi.fn(async (request: NavigationQueryRequest) => {
    const page = await store.readPage({ request, scopeKey: "viewer", loadIndex: async () => snapshot(rows) });
    responses.push({ bytes: Buffer.byteLength(JSON.stringify(page)), rows: page.entries.length });
    return page;
  });
  const backend = { getNavigationQueryPage } as unknown as FederationBackendOperations;
  const initial = await readFederationPinnedSnapshot(backend, ["codex:root"], {}, state);
  expect(initial.threads).toHaveLength(206);
  const initialBytes = responses.reduce((sum, response) => sum + response.bytes, 0);
  responses.length = 0;
  getNavigationQueryPage.mockClear();
  rows[206]!.title = "Unrelated changed";
  const unchanged = await readFederationPinnedSnapshot(backend, ["codex:root"], {}, state);
  expect(unchanged.threads).toEqual(initial.threads);
  expect(getNavigationQueryPage).toHaveBeenCalledTimes(1);
  expect(getNavigationQueryPage.mock.calls[0]![0].completeBaselineRevision).toBeTruthy();
  expect(responses.reduce((sum, response) => sum + response.rows, 0)).toBe(0);
  expect(responses[0]!.bytes).toBeLessThan(initialBytes / 20);
  rows.push(thread("new-child", { parentThreadId: "root" }));
  const changed = await readFederationPinnedSnapshot(backend, ["codex:root"], {}, state);
  expect(changed.threads).toHaveLength(207);
  expect(changed.threads.some((row) => row.id === "new-child")).toBe(true);
});

it("does not commit a partial conditional baseline when a later page fails", async () => {
  const rows = [thread("root"), ...Array.from({ length: 105 }, (_, i) => thread(`child-${i}`, { parentThreadId: "root" }))];
  const store = new NavigationQueryStore();
  const state = new Map();
  let failContinuation = false;
  const backend = { getNavigationQueryPage: async (request: NavigationQueryRequest) => {
    if (failContinuation && request.cursor) throw new Error("lost continuation");
    return store.readPage({ request, scopeKey: "viewer", loadIndex: async () => snapshot(rows) });
  } } as FederationBackendOperations;
  await readFederationPinnedSnapshot(backend, ["codex:root"], {}, state);
  const baseline = [...state.entries()];
  rows.push(thread("new-child", { parentThreadId: "root" }));
  failContinuation = true;
  await expect(readFederationPinnedSnapshot(backend, ["codex:root"], {}, state)).rejects.toThrow("lost continuation");
  expect([...state.entries()]).toEqual(baseline);
  failContinuation = false;
  expect((await readFederationPinnedSnapshot(backend, ["codex:root"], {}, state)).threads).toHaveLength(107);
  const remounted = await readFederationPinnedSnapshot(backend, ["codex:new-child"], {}, state);
  expect(remounted.threads.map((row) => row.id)).toEqual(["new-child"]);
  expect(state.size).toBe(1);
});

it("rejects unchanged responses without the exact retained complete-query baseline", async () => {
  const store = new NavigationQueryStore();
  const state = new Map();
  let corrupt = false;
  const backend = { getNavigationQueryPage: async (request: NavigationQueryRequest) => {
    const page = await store.readPage({ request, scopeKey: "viewer", loadIndex: async () => snapshot([thread("root")]) });
    return corrupt ? { ...page, unchanged: true, entries: [], countsRevision: "wrong" } : page;
  } } as FederationBackendOperations;
  await readFederationPinnedSnapshot(backend, ["codex:root"], {}, state);
  corrupt = true;
  await expect(readFederationPinnedSnapshot(backend, ["codex:root"], {}, state)).rejects.toThrow("invalid unchanged baseline");
  await expect(readFederationPinnedSnapshot(backend, ["codex:root"], {})).rejects.toThrow("invalid unchanged baseline");
});
