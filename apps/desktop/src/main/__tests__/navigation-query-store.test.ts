import { describe, expect, it } from "vitest";
import type {
  NavigationQueryRequest,
  NavigationSnapshot,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
} from "@pwragent/shared";
import {
  NavigationQueryError,
  NavigationQueryStore,
} from "../app-server/navigation-query-store";

function thread(id: string, title = `Thread ${id}`): NavigationThreadSummary {
  const order = Number(id.replace(/\D/g, "")) || 1;
  return {
    id,
    source: "codex",
    title,
    titleSource: "derived",
    createdAt: order,
    updatedAt: order,
    linkedDirectories: [],
    inbox: { inInbox: false },
  };
}

function snapshot(threads: NavigationThreadSummary[]): NavigationSnapshot {
  return {
    backend: "all",
    fetchedAt: 1,
    unchanged: false,
    threads,
    inboxThreadKeys: [],
    directories: [],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
  };
}

function request(
  patch: Partial<NavigationQueryRequest> = {},
): NavigationQueryRequest {
  return {
    protocol: 2,
    consumer: "main-sidebar",
    query: { kind: "lens", lens: "recents" },
    ...patch,
  };
}

describe("NavigationQueryStore", () => {
  it("cursor_preserves_generation_during_owner_activity", async () => {
    let owner = snapshot(
      Array.from({ length: 25 }, (_, index) => thread(String(index + 1))),
    );
    const store = new NavigationQueryStore();
    const loadSnapshot = async (): Promise<NavigationSnapshot> => owner;
    const first = await store.readPage({
      loadSnapshot,
      request: request({ pageSize: 10 }),
      scopeKey: "local-window",
    });
    expect(first.entries).toHaveLength(10);
    expect(first.nextCursor).toBeTruthy();

    owner = snapshot([thread("26"), ...owner.threads]);
    const second = await store.readPage({
      loadSnapshot,
      request: request({ cursor: first.nextCursor, pageSize: 10 }),
      scopeKey: "local-window",
    });

    expect(second.generation).toBe(first.generation);
    expect(second.entries.map((entry) => entry.row.id)).not.toContain("26");
    expect(new Set([
      ...first.entries.map((entry) => entry.row.id),
      ...second.entries.map((entry) => entry.row.id),
    ]).size).toBe(20);
  });

  it("unchanged_requires_a_complete_matching_query_baseline", async () => {
    const owner = snapshot([thread("1"), thread("2")]);
    const store = new NavigationQueryStore();
    const loadSnapshot = async (): Promise<NavigationSnapshot> => owner;
    const first = await store.readPage({
      loadSnapshot,
      request: request(),
      scopeKey: "local-window",
    });
    expect(first.complete).toBe(true);

    const unchanged = await store.readPage({
      loadSnapshot,
      request: request({ completeBaselineRevision: first.countsRevision }),
      scopeKey: "local-window",
    });
    expect(unchanged).toEqual(expect.objectContaining({
      complete: true,
      entries: [],
      unchanged: true,
    }));
    expect(Buffer.byteLength(JSON.stringify(unchanged), "utf8")).toBeLessThan(1024);

    const otherQuery = await store.readPage({
      loadSnapshot,
      request: request({
        completeBaselineRevision: first.countsRevision,
        query: { kind: "lens", lens: "inbox" },
      }),
      scopeKey: "local-window",
    });
    expect(otherQuery.unchanged).not.toBe(true);
    expect(otherQuery.entries).toHaveLength(2);
  });

  it("caps every serialized result and rejects one oversized identity row", async () => {
    const store = new NavigationQueryStore();
    const owner = snapshot(
      Array.from({ length: 100 }, (_, index) =>
        thread(String(index + 1), `Thread ${index + 1} ${"x".repeat(4_000)}`)),
    );
    const page = await store.readPage({
      loadSnapshot: async () => owner,
      request: request(),
      scopeKey: "local-window",
    });
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8"))
      .toBeLessThanOrEqual(NAVIGATION_QUERY_MAX_RESULT_BYTES);

    await expect(store.readPage({
      loadSnapshot: async () => snapshot([thread("large", "x".repeat(300_000))]),
      request: request({ query: { kind: "lens", lens: "inbox" } }),
      scopeKey: "local-window",
    })).rejects.toMatchObject({
      code: "navigation_item_too_large",
    } satisfies Partial<NavigationQueryError>);
  });

  it("expires an idle cursor explicitly", async () => {
    let now = 1_000;
    const store = new NavigationQueryStore({ now: () => now });
    const owner = snapshot(
      Array.from({ length: 5 }, (_, index) => thread(String(index + 1))),
    );
    const first = await store.readPage({
      loadSnapshot: async () => owner,
      request: request({ pageSize: 1 }),
      scopeKey: "local-window",
    });
    now += 60_001;

    await expect(store.readPage({
      loadSnapshot: async () => owner,
      request: request({ cursor: first.nextCursor, pageSize: 1 }),
      scopeKey: "local-window",
    })).rejects.toMatchObject({
      code: "navigation_cursor_expired",
    } satisfies Partial<NavigationQueryError>);
  });
});
