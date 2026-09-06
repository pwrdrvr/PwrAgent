import { navigationRequestForOwner, stampRemoteNavigationQueryPage } from "../federation/federation-navigation-query";
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
  it("returns compact owner model counts without thread or launchpad contents", async () => {
    const threads = Array.from({ length: 1001 }, (_, index) => ({
      ...thread(String(index), "private thread contents".repeat(1000)), model: "owner-model",
      modelMigrationRevision: index % 2 ? "previous" : "current", fastMode: index % 3 === 0,
    }));
    threads.push({ ...thread("other"), source: "acp:grok", model: "foreign-backend", modelMigrationRevision: "current", fastMode: true });
    const store = new NavigationQueryStore();
    const page = await store.readPage({ scopeKey: "settings", loadIndex: async () => snapshot(threads),
      request: request({ consumer: "settings", backend: "codex", query: { kind: "model-inventory" } }),
    });
    expect(page.entries).toEqual([]);
    expect(page.modelGroups).toEqual([
      { backend: "codex", model: "owner-model", modelMigrationRevision: "current", threadCount: 501, fastThreadCount: 167 },
      { backend: "codex", model: "owner-model", modelMigrationRevision: "previous", threadCount: 500, fastThreadCount: 167 },
    ]);
    expect(page.counts.total).toBe(1001);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1024);
    expect(JSON.stringify(page)).not.toContain("private thread contents");
  });

  it("pages model inventory groups with immutable generation and unchanged semantics", async () => {
    const threads = Array.from({ length: 101 }, (_, index) => ({ ...thread(String(index)), model: `model-${index}` }));
    const store = new NavigationQueryStore();
    const query = request({ consumer: "settings", query: { kind: "model-inventory" }, pageSize: 100 });
    const first = await store.readPage({ scopeKey: "settings", loadIndex: async () => snapshot(threads), request: query });
    const last = await store.readPage({ scopeKey: "settings", loadIndex: async () => snapshot([]), request: { ...query, cursor: first.nextCursor } });
    expect(first.modelGroups).toHaveLength(100);
    expect(last.modelGroups).toHaveLength(1);
    expect(last.complete).toBe(true);
    expect(last.generation).toBe(first.generation);
    const unchanged = await store.readPage({ scopeKey: "settings", loadIndex: async () => snapshot(threads),
      request: { ...query, completeBaselineRevision: last.countsRevision },
    });
    expect(unchanged.unchanged).toBe(true);
  });

  it("pages complete project geometry by primary membership rather than loaded cards or secondary links", async () => {
    const threads = Array.from({ length: 101 }, (_, index) => ({
      ...thread(String(index)),
      linkedDirectories: [
        { id: `primary-${index}`, kind: "local" as const, label: `Project ${index}`, path: `/repos/project-${index}` },
        { id: `secondary-${index}`, kind: "local" as const, label: "Secondary", path: "/repos/secondary" },
      ],
    }));
    const store = new NavigationQueryStore();
    const query = request({ query: { kind: "star-map-geometry" }, pageSize: 100 });
    const first = await store.readPage({ loadIndex: async () => snapshot(threads), request: query, scopeKey: "viewer" });
    expect(first.directories).toHaveLength(100);
    expect(first.complete).toBe(false);
    const last = await store.readPage({ loadIndex: async () => snapshot([]), request: { ...query, cursor: first.nextCursor }, scopeKey: "viewer" });
    expect(last.directories).toHaveLength(1);
    expect(last.complete).toBe(true);
    const descriptors = [...first.directories!, ...last.directories!];
    expect(descriptors.reduce((total, directory) => total + directory.counts.total, 0)).toBe(101);
    expect(descriptors.some((directory) => directory.path === "/repos/secondary")).toBe(false);
    expect(JSON.stringify(descriptors)).not.toContain("threadKeys");
  });

  it("filters Star Map facets on the owner and counts off-page members", async () => {
    const threads = Array.from({ length: 1001 }, (_, index) => ({
      ...thread(String(index)),
      inbox: { inInbox: true, reason: "updated-since-seen" as const },
      ...(index % 2 === 0 ? { agent: { name: "Agent", instructions: "private configuration", instructionLineCount: 1, instructionsTooLong: false, updatedAt: 1 } } : {}),
    }));
    const store = new NavigationQueryStore();
    const result = await store.readPage({
      scopeKey: "viewer",
      loadIndex: async () => ({ ...snapshot(threads), inputRequestThreadKeys: new Set(["codex:1000"]) }),
      request: request({ query: { kind: "star-map", filters: { agent: "include", approval: "include" } }, pageSize: 10 }),
    });
    expect(result.entries.map((entry) => entry.row.id)).toEqual(["1000"]);
    expect(result.entries[0]?.row.needsInput).toBe(true);
    expect(result.facets?.matches).toMatchObject({ attention: 501, approval: 1, agent: 1 });
    expect(result.facets?.unread).toBe(501);
    expect(JSON.stringify(result)).not.toContain("private configuration");
    expect(result.counts.total).toBe(1001);
  });

  it("keeps numeric owner pin order and includes pins through unrelated facet filters", async () => {
    const threads = [
      { ...thread("1"), pinnedRank: "1024" },
      { ...thread("2"), pinnedRank: "256" },
      { ...thread("3"), pinnedRank: "2048" },
    ];
    const store = new NavigationQueryStore();
    const result = await store.readPage({ scopeKey: "viewer", loadIndex: async () => snapshot(threads),
      request: request({ query: { kind: "star-map", filters: { agent: "include" } } }),
    });
    expect(result.entries.map((entry) => entry.row.id)).toEqual(["2", "1", "3"]);
    const excluded = await store.readPage({ scopeKey: "viewer", loadIndex: async () => snapshot(threads),
      request: request({ query: { kind: "star-map", filters: { pinned: "exclude" } } }),
    });
    expect(excluded.entries).toEqual([]);
  });

  it("invalidates row and count revisions when owner input readiness changes", async () => {
    const store = new NavigationQueryStore();
    const threadKeys = new Set<string>();
    const params = { scopeKey: "viewer", loadIndex: async () => ({ ...snapshot([thread("1")]), inputRequestThreadKeys: threadKeys }),
      request: request({ query: { kind: "star-map" as const, filters: {} } }),
    };
    const first = await store.readPage(params);
    threadKeys.add("codex:1");
    const changed = await store.readPage({ ...params, request: { ...params.request, completeBaselineRevision: first.countsRevision } });
    expect(changed.unchanged).not.toBe(true);
    expect(changed.entries[0]?.row.rowRevision).not.toBe(first.entries[0]?.row.rowRevision);
    expect(changed.facets?.matches.approval).toBe(1);
  });

  it("rejects a cursor whose requester was rewritten around another retained generation", async () => {
    const store = new NavigationQueryStore();
    const loadIndex = async () => snapshot([thread("1"), thread("2")]);
    const first = await store.readPage({
      loadIndex, request: request({ pageSize: 1 }), scopeKey: "owner-a",
    });
    const cursor = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
    cursor.scopeKey = "owner-b";
    await expect(store.readPage({
      loadIndex,
      request: request({ cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url") }),
      scopeKey: "owner-b",
    })).rejects.toMatchObject({ code: "navigation_invalid_request" });
  });

  it("fits a continuation in the same byte budget as its rows", async () => {
    const load = (titleLength: number) => snapshot([
      thread("2", "x".repeat(titleLength)),
      thread("1"),
    ]);
    const probe = await new NavigationQueryStore().readPage({
      loadIndex: async () => load(1),
      request: request({ pageSize: 1 }), scopeKey: "scope",
    });
    const wrapperBytes = Buffer.byteLength(JSON.stringify(probe), "utf8") - 1;
    const page = await new NavigationQueryStore().readPage({
      loadIndex: async () => load(NAVIGATION_QUERY_MAX_RESULT_BYTES - wrapperBytes - 1),
      request: request({ pageSize: 100 }), scopeKey: "scope",
    });
    expect(page.entries).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(page), "utf8"))
      .toBeLessThanOrEqual(NAVIGATION_QUERY_MAX_RESULT_BYTES);
  });

  it("keeps owner Attention ranks across pages, lens changes and cursor expiry", async () => {
    let now = 1_000;
    const store = new NavigationQueryStore({ now: () => now });
    const a = { ...thread("1"), threadStatus: "active" as const };
    const b = { ...thread("2"), threadStatus: "active" as const };
    const owner = snapshot([a, b]);
    const loadIndex = async () => owner;
    const attention = request({
      query: { kind: "lens", lens: "attention" },
      attentionView: { id: "window-a", promoteOnTurnEnd: true },
      pageSize: 1,
    });
    const read = (next = attention) => store.readPage({
      loadIndex, request: next, scopeKey: "requester",
    });
    const first = await read();
    expect(first.entries[0]?.row.id).toBe("2");
    a.updatedAt = 100;
    await read({ ...attention, query: { kind: "lens", lens: "inbox" } });
    const second = await read({ ...attention, cursor: first.nextCursor });
    expect(second.entries[0]?.row.id).toBe("1");
    expect(second.entries[0]?.attentionRank).toBeLessThan(first.entries[0]!.attentionRank!);
    now += 60_001;
    const rebaseline = await read();
    expect(rebaseline.entries[0]?.row.id).toBe("2");
    expect(rebaseline.entries[0]?.attentionRank).toBe(first.entries[0]?.attentionRank);

    owner.threads = [{ ...a, threadStatus: "idle", inbox: { inInbox: true } }, b];
    const finished = await read();
    expect(finished.entries[0]?.row.id).toBe("1");
    expect(finished.counts).toMatchObject({ active: 1, review: 1 });
  });

  it("isolates Attention view policies and retains off-page membership", async () => {
    const store = new NavigationQueryStore();
    const owner = snapshot([
      { ...thread("1"), inbox: { inInbox: true } },
      { ...thread("2"), inbox: { inInbox: true } },
    ]);
    const read = (promoteOnTurnEnd: boolean) => store.readPage({
      loadIndex: async () => owner,
      request: request({
        query: { kind: "lens", lens: "attention" },
        attentionView: { id: "view", promoteOnTurnEnd },
        pageSize: 1,
      }),
      scopeKey: "requester",
    });
    await read(true);
    await read(false);
    owner.threads[0]!.updatedAt = 100;
    expect((await read(true)).entries[0]?.row.id).toBe("1");
    expect((await read(false)).entries[0]?.row.id).toBe("2");
    store.releaseAttentionView("requester", "view");
    expect((await read(false)).entries[0]?.row.id).toBe("1");
  });

  it("cursor_preserves_generation_during_owner_activity", async () => {
    let owner = snapshot(
      Array.from({ length: 25 }, (_, index) => thread(String(index + 1))),
    );
    const store = new NavigationQueryStore();
    const loadIndex = async (): Promise<NavigationSnapshot> => owner;
    const first = await store.readPage({
      loadIndex,
      request: request({ pageSize: 10 }),
      scopeKey: "local-window",
    });
    expect(first.entries).toHaveLength(10);
    expect(first.nextCursor).toBeTruthy();

    owner = snapshot([thread("26"), ...owner.threads]);
    const second = await store.readPage({
      loadIndex,
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
    const loadIndex = async (): Promise<NavigationSnapshot> => owner;
    const first = await store.readPage({
      loadIndex,
      request: request(),
      scopeKey: "local-window",
    });
    expect(first.complete).toBe(true);

    const unchanged = await store.readPage({
      loadIndex,
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
      loadIndex,
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
      loadIndex: async () => owner,
      request: request(),
      scopeKey: "local-window",
    });
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8"))
      .toBeLessThanOrEqual(NAVIGATION_QUERY_MAX_RESULT_BYTES);

    await expect(store.readPage({
      loadIndex: async () => snapshot([thread("large", "x".repeat(300_000))]),
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
      loadIndex: async () => owner,
      request: request({ pageSize: 1 }),
      scopeKey: "local-window",
    });
    now += 60_001;

    await expect(store.readPage({
      loadIndex: async () => owner,
      request: request({ cursor: first.nextCursor, pageSize: 1 }),
      scopeKey: "local-window",
    })).rejects.toMatchObject({
      code: "navigation_cursor_expired",
    } satisfies Partial<NavigationQueryError>);
  });
});

it.each([undefined, "owner", "other-owner"])("stamps off-page parent ownership independently of child ownership %s", async (childOwner) => {
  const store = new NavigationQueryStore();
  const page = await store.readPage({ scopeKey: "remote-placement", loadIndex: async () => snapshot([thread("child")]), request: request() });
  const entry = page.entries[0]!;
  const stamped = stampRemoteNavigationQueryPage({ instanceLabel: "Owner", target: { scope: "remote", instanceId: "owner" }, page: {
    ...page, entries: [{ ...entry,
      row: { ...entry.row, ref: { ...entry.row.ref, ownerInstanceId: childOwner } },
      placement: { kind: "child", parent: { backend: "codex", threadId: "off-page-parent" } },
    }],
  } });
  expect(stamped.entries[0]?.placement).toEqual({ kind: "child", parent: {
    backend: "codex", threadId: "off-page-parent", ownerInstanceId: "owner",
  } });
  expect(stamped.entries[0]?.row.ref.ownerInstanceId).toBe(childOwner ?? "owner");
  const foreign = stampRemoteNavigationQueryPage({ instanceLabel: "Owner", target: { scope: "remote", instanceId: "owner" }, page: {
    ...stamped, entries: [{ ...stamped.entries[0]!, placement: { kind: "child", parent: {
      backend: "codex", threadId: "off-page-parent", ownerInstanceId: "foreign-parent-owner",
    } } }],
  } });
  expect(foreign.entries[0]?.placement).toEqual({ kind: "child", parent: {
    backend: "codex", threadId: "off-page-parent", ownerInstanceId: "foreign-parent-owner",
  } });
});

it("localizes exact and child identities only for the serving owner", () => {
  const owner = { scope: "remote" as const, instanceId: "owner" };
  const identities = [{ backend: "codex" as const, threadId: "same", ownerInstanceId: "owner" },
    { backend: "codex" as const, threadId: "same", ownerInstanceId: "foreign" }];
  expect(navigationRequestForOwner(request({ federationTarget: owner, query: { kind: "exact", identities } }), owner).query)
    .toEqual({ kind: "exact", identities: [{ backend: "codex", threadId: "same" }, identities[1]] });
  expect(navigationRequestForOwner(request({ query: { kind: "children", parent: identities[0]! } }), owner).query)
    .toEqual({ kind: "children", parent: { backend: "codex", threadId: "same" } });
});
