import { createHash } from "node:crypto";
import { navigationRequestForOwner, stampRemoteNavigationQueryPage } from "../federation/federation-navigation-query";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
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
  fingerprintNavigationMaterialization,
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
  it.each([true, false])("records off-page turn boundaries independently of reads with promotion=%s", async (promoteOnTurnEnd) => {
    const store = new NavigationQueryStore();
    const threads = Array.from({ length: 30 }, (_, i) => ({ ...thread(`thread-${i}`), inbox: { inInbox: true }, threadStatus: "idle" as "idle" | "active" }));
    const view = request({ query: { kind: "lens", lens: "attention" }, pageSize: 10,
      attentionView: { id: "window", promoteOnTurnEnd } });
    const read = (cursor?: string) => store.readPage({ scopeKey: "viewer", loadIndex: async () => snapshot(threads), request: { ...view, cursor } });
    const initial = await read();
    const event = (id: number, active: boolean) => store.observeAttentionEvent({ backend: "codex",
      notification: { method: active ? "turn/started" : "turn/completed", params: { threadId: `thread-${id}`, turnId: `turn-${id}` } },
    } as AgentEvent);
    event(0, true);
    event(1, true);
    event(0, false);
    event(0, false);
    threads[0]!.updatedAt = 1000;
    threads[1]!.threadStatus = "active";
    const next = await read();
    expect(next.entries.slice(0, 2).map(({ row }) => row.id)).toEqual(promoteOnTurnEnd ? ["thread-0", "thread-1"] : ["thread-1", "thread-0"]);
    expect(next.counts.active).toBe(1);
    const frozenCursor = await read(initial.nextCursor);
    expect(frozenCursor.generation).toBe(initial.generation);
    expect(frozenCursor.counts.active).toBe(0);
    threads[0]!.updatedAt += 1;
    const overlay = await read();
    expect(overlay.entries.map(({ row, attentionRank }) => [row.id, attentionRank])).toEqual(next.entries.map(({ row, attentionRank }) => [row.id, attentionRank]));
  });

  it("rereads a late owner baseline after a canonical turn boundary instead of undoing its rank", async () => {
    const store = new NavigationQueryStore();
    const original = [{ ...thread("first"), threadStatus: "idle" as const, inbox: { inInbox: true } }];
    const view = request({ query: { kind: "lens", lens: "attention" }, attentionView: { id: "window", promoteOnTurnEnd: true } });
    await store.readPage({ scopeKey: "viewer", request: view, loadIndex: async () => snapshot(original) });
    let resolve!: (value: NavigationSnapshot) => void;
    const pending = new Promise<NavigationSnapshot>((done) => { resolve = done; });
    let reads = 0;
    const read = store.readPage({ scopeKey: "viewer", request: view,
      loadIndex: () => ++reads === 1 ? pending : Promise.resolve(snapshot([{ ...original[0]!, threadStatus: "active" }])),
    });
    store.observeAttentionEvent({ backend: "codex", notification: { method: "turn/started", params: { threadId: "first", turnId: "new-turn" } } } as AgentEvent);
    resolve(snapshot(original));
    const result = await read;
    expect(reads).toBe(2);
    expect(result.counts.active).toBe(1);
    expect(result.entries[0]?.attentionRank).toBe(2);
  });

  it("admits remote event ranks only for the exact viewer-owned mounted identity", async () => {
    const store = new NavigationQueryStore();
    const local = thread("same-id");
    const remote: NavigationThreadSummary = { ...local, federation: {
      instanceLabel: "Mounted owner", ref: { backend: "codex", threadId: local.id, target: { scope: "remote", instanceId: "mounted" } },
    } };
    const view = request({ query: { kind: "lens", lens: "attention" }, attentionView: { id: "window", promoteOnTurnEnd: true } });
    const read = () => store.readPage({ scopeKey: "viewer", request: view, loadIndex: async () => snapshot([local, remote]) });
    await read();
    for (const instanceId of ["unmounted", "mounted"]) store.observeAttentionEvent({ backend: "codex",
      federationTarget: { scope: "remote", instanceId },
      notification: { method: "turn/started", params: { threadId: local.id, turnId: "turn-1" } },
    } as AgentEvent);
    remote.threadStatus = "active";
    const result = await read();
    expect(result.entries.map((entry) => [entry.row.ref.ownerInstanceId, entry.attentionRank])).toEqual([["mounted", 1]]);
    expect(result.counts.active).toBe(1);
  });

  it("pages a complete group child-first and discovers children of foreign roots absent from the local index", async () => {
    const children = Array.from({ length: 121 }, (_, index) => ({ ...thread(`child-${index}`), parentThreadId: "root", parentThreadBackend: "codex" as const }));
    const foreignChild = { ...thread("foreign-child"), parentThreadId: "foreign-root", parentThreadBackend: "codex" as const, parentThreadInstanceId: "peer" };
    const store = new NavigationQueryStore();
    const read = (cursor?: string) => store.readPage({ scopeKey: "groups", loadIndex: async () => snapshot([thread("root"), ...children, foreignChild]),
      request: request({ query: { kind: "group-members", roots: [{ backend: "codex", threadId: "root" },
        { backend: "codex", threadId: "foreign-root", ownerInstanceId: "peer" }] }, pageSize: 10, cursor }) });
    const rows: string[] = [];
    let page = await read();
    while (true) {
      expect(page.entries.length).toBeLessThanOrEqual(10);
      expect(page.counts.total).toBe(123);
      rows.push(...page.entries.map(({ row }) => row.id));
      if (!page.nextCursor) break;
      page = await read(page.nextCursor);
    }
    expect(rows).toHaveLength(123);
    expect(rows.indexOf("root")).toBeGreaterThan(rows.indexOf("child-120"));
    expect(rows).toContain("foreign-child");
  });

  it("rejects cyclic group membership before returning a page", async () => {
    await expect(new NavigationQueryStore().readPage({ scopeKey: "groups",
      loadIndex: async () => snapshot([{ ...thread("root"), parentThreadId: "child" }, { ...thread("child"), parentThreadId: "root" }]),
      request: request({ query: { kind: "group-members", roots: [{ backend: "codex", threadId: "root" }] } }) }))
      .rejects.toThrow("cycle");
  });

  it("filters messaging eligibility before paging and reports the complete collection count", async () => {
    const threads = Array.from({ length: 100 }, (_, index) => ({ ...thread(String(index)),
      executionMode: index % 2 ? "full-access" as const : "default" as const,
      summary: "private selected-only text", agent: { name: "Agent", instructionLineCount: 0, instructionsTooLong: false, updatedAt: 1 },
    }));
    const index = snapshot(threads);
    index.directories = [{ key: "repo", kind: "directory", label: "Repo", threadKeys: threads.map((row) => `codex:${row.id}`), needsAttentionCount: 0 }];
    const store = new NavigationQueryStore();
    const read = (cursor?: string) => store.readPage({ scopeKey: "messaging", loadIndex: async () => index,
      request: request({ consumer: "messaging-browse", pageSize: 8, cursor,
        query: { kind: "messaging-threads", agentOnly: true, excludeFullAccess: true, allowedBackends: ["codex"], directoryKey: "repo" } }) });
    const first = await read();
    expect(first.collectionSize).toBe(50);
    expect(first.counts.total).toBe(50);
    expect(first.entries).toHaveLength(8);
    expect(first.entries.every(({ row }) => row.executionMode === "default")).toBe(true);
    expect(JSON.stringify(first)).not.toContain("private selected-only text");
    const second = await read(first.nextCursor);
    expect(second.collectionSize).toBe(50);
    expect(second.rangeStart).toBe(8);
    expect(second.entries.some(({ row }) => first.entries.some((entry) => entry.row.id === row.id))).toBe(false);
  });

  it("pages compact messaging projects with complete counts and a single owner scratchpad", async () => {
    const index = snapshot([thread("one"), thread("two")]);
    index.directories = [
      { key: "workspace:old", kind: "workspace", label: "Workspaces", path: "/old", threadKeys: ["codex:one"], needsAttentionCount: 0, latestUpdatedAt: 1 },
      { key: "workspace:new", kind: "workspace", label: "Workspaces", path: "/new", threadKeys: ["codex:one", "codex:two"], needsAttentionCount: 0, latestUpdatedAt: 2 },
      ...Array.from({ length: 20 }, (_, value) => ({ key: `repo:${value}`, kind: "directory" as const, label: `Repo ${value}`, threadKeys: [], needsAttentionCount: 0 })),
    ];
    const store = new NavigationQueryStore();
    const page = await store.readPage({ scopeKey: "messaging", loadIndex: async () => index,
      request: request({ consumer: "messaging-browse", pageSize: 8, query: { kind: "messaging-projects", scratchpadFirst: true } }) });
    expect(page.collectionSize).toBe(21);
    expect(page.directories).toHaveLength(8);
    expect(page.directories?.[0]).toMatchObject({ key: "workspace:new", counts: { total: 2 } });
    expect(page.directories?.[0]).not.toHaveProperty("threadKeys");
    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toBeDefined();
  });

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
    const read = (promoteOnTurnEnd: boolean, id = promoteOnTurnEnd ? "promoting-view" : "stable-view") => store.readPage({
      loadIndex: async () => owner,
      request: request({
        query: { kind: "lens", lens: "attention" },
        attentionView: { id, promoteOnTurnEnd },
        pageSize: 1,
      }),
      scopeKey: "requester",
    });
    await read(true);
    await read(false);
    owner.threads[0]!.updatedAt = 100;
    expect((await read(true)).entries[0]?.row.id).toBe("1");
    expect((await read(false)).entries[0]?.row.id).toBe("2");
    store.releaseAttentionView("requester", "stable-view");
    await expect(read(false)).rejects.toThrow("has closed");
    expect((await read(false, "replacement-view")).entries[0]?.row.id).toBe("1");
  });

  it("changing one view's promotion preference does not mint new membership ranks", async () => {
    const store = new NavigationQueryStore();
    const owner = snapshot([{ ...thread("1"), inbox: { inInbox: true }, threadStatus: "active" },
      { ...thread("2"), inbox: { inInbox: true }, threadStatus: "active" }]);
    const read = (promoteOnTurnEnd: boolean) => store.readPage({ scopeKey: "requester", loadIndex: async () => owner,
      request: request({ query: { kind: "lens", lens: "attention" }, attentionView: { id: "same-window", promoteOnTurnEnd } }) });
    const initial = await read(true);
    // Streamed timestamps cannot reorder already-ranked active turns, including
    // when the operator changes the end-of-turn promotion preference.
    owner.threads[0]!.updatedAt = 100;
    const changed = await read(false);
    expect(changed.entries.map((entry) => [entry.row.id, entry.orderKey]))
      .toEqual(initial.entries.map((entry) => [entry.row.id, entry.orderKey]));
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

it("stamps current viewer grants and removes a revoked grant on an already stamped row", async () => {
  const page = await new NavigationQueryStore().readPage({ scopeKey: "grants", loadIndex: async () => snapshot([thread("one")]), request: request() });
  const target = { scope: "remote" as const, instanceId: "owner" };
  const granted = stampRemoteNavigationQueryPage({ page, target, instanceLabel: "Owner", capabilities: ["thread_navigation", "turn_control"], peerStatus: "connected" });
  expect(granted.entries[0]?.row.federation).toMatchObject({ capabilities: ["thread_navigation", "turn_control"], peerStatus: "connected" });
  const revoked = stampRemoteNavigationQueryPage({ page: granted, target, instanceLabel: "Owner", capabilities: ["thread_navigation"], peerStatus: "disconnected" });
  expect(revoked.entries[0]?.row.federation).toMatchObject({ capabilities: ["thread_navigation"], peerStatus: "disconnected" });
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

it("rebaselines an expired cursor at an owner identity without replaying preceding pages", async () => {
  let now = 0;
  const store = new NavigationQueryStore({ now: () => now });
  const threads = Array.from({ length: 120 }, (_, index) => thread(String(index)));
  const loadIndex = async () => snapshot(threads);
  const query = request({ pageSize: 10 });
  const first = await store.readPage({ scopeKey: "window", loadIndex, request: query });
  now = 60_001;
  await expect(store.readPage({ scopeKey: "window", loadIndex, request: { ...query, cursor: first.nextCursor } }))
    .rejects.toMatchObject({ code: "navigation_cursor_expired" });
  const anchored = await store.readPage({ scopeKey: "window", loadIndex, request: { ...query,
    anchor: { kind: "thread", ref: { backend: "codex", threadId: "35" } },
  } });
  expect(anchored.entries[0]?.row.id).toBe("35");
  expect(anchored.entries).toHaveLength(10);
  expect(anchored.rangeStart).toBeGreaterThan(70);
  expect(anchored.counts.total).toBe(120);
  expect(anchored.generation).not.toBe(first.generation);
  await expect(store.readPage({ scopeKey: "window", loadIndex, request: { ...query,
    anchor: { kind: "thread", ref: { backend: "codex", threadId: "removed" } },
  } })).rejects.toMatchObject({ code: "navigation_anchor_missing" });
});

it("localizes only the serving owner's thread anchor", () => {
  const target = { scope: "remote" as const, instanceId: "owner" };
  const query = request({ anchor: { kind: "thread", ref: { backend: "codex", threadId: "t", ownerInstanceId: "owner" } } });
  expect(navigationRequestForOwner(query, target).anchor).toEqual({ kind: "thread", ref: { backend: "codex", threadId: "t" } });
  expect(navigationRequestForOwner({ ...query, anchor: { kind: "thread", ref: { backend: "codex", threadId: "t", ownerInstanceId: "other" } } }, target).anchor)
    .toEqual({ kind: "thread", ref: { backend: "codex", threadId: "t", ownerInstanceId: "other" } });
});

it("rejects cursor and unchanged-baseline combinations with an anchor", async () => {
  const store = new NavigationQueryStore();
  for (const conflict of [{ cursor: "old" }, { completeBaselineRevision: "old" }]) {
    await expect(store.readPage({ scopeKey: "window", loadIndex: async () => snapshot([]),
      request: request({ ...conflict, anchor: { kind: "directory", key: "directory:/selected" } }),
    })).rejects.toMatchObject({ code: "navigation_invalid_request" });
  }
});

it("does not certify incomplete provider coverage as an authoritative empty population", async () => {
  const store = new NavigationQueryStore();
  const checking = await store.readPage({ scopeKey: "window", request: request(),
    loadIndex: async () => ({ ...snapshot([]), coverage: { state: "checking" as const } }),
  });
  expect(checking.coverage.state).toBe("checking");
  const ready = await store.readPage({ scopeKey: "window", request: request({ completeBaselineRevision: checking.countsRevision }),
    loadIndex: async () => ({ ...snapshot([]), coverage: { state: "complete" as const } }),
  });
  expect(ready.coverage.state).toBe("complete");
  expect(ready.unchanged).not.toBe(true);
  expect(ready.countsRevision).not.toBe(checking.countsRevision);
});

it("does not recreate Attention ranks or generations when an owner read finishes after teardown", async () => {
  const store = new NavigationQueryStore();
  let resolve!: (value: ReturnType<typeof snapshot>) => void;
  const pending = store.readPage({ scopeKey: "window", request: request({ attentionView: { id: "closed-lifetime", promoteOnTurnEnd: true } }),
    loadIndex: () => new Promise((done) => { resolve = done; }),
  });
  store.releaseAttentionView("window", "closed-lifetime");
  resolve(snapshot([thread("1")]));
  await expect(pending).rejects.toThrow("closed during");
  await expect(store.readPage({ scopeKey: "window", request: request({ attentionView: { id: "closed-lifetime", promoteOnTurnEnd: true } }),
    loadIndex: async () => snapshot([]),
  })).rejects.toThrow("has closed");
  // Released generations cannot fill the eight-generation budget as views open and close.
  for (let index = 0; index < 12; index += 1) {
    await store.readPage({ scopeKey: "window", request: request({ attentionView: { id: `next-${index}`, promoteOnTurnEnd: true } }),
      loadIndex: async () => snapshot([thread("1")]),
    });
    store.releaseAttentionView("window", `next-${index}`);
  }
});

it("bounds closed Attention lifetime metadata and expires it after the late-read window", async () => {
  let now = 0;
  const store = new NavigationQueryStore({ now: () => now });
  const read = (id: string) => store.readPage({ scopeKey: "viewer", request: request({ attentionView: { id, promoteOnTurnEnd: true } }),
    loadIndex: async () => snapshot([]),
  });
  for (let index = 0; index < 256; index += 1) {
    await read(String(index));
    store.releaseAttentionView("viewer", String(index));
  }
  await expect(read("next")).rejects.toMatchObject({ code: "navigation_busy" });
  now = 60_001;
  await expect(read("next")).resolves.toMatchObject({ protocol: 2 });
});


it("does not spend cursor slots on complete exact reads or one-page lists", async () => {
  const store = new NavigationQueryStore();
  const owner = snapshot(Array.from({ length: 20 }, (_, index) => thread(String(index))));
  const first = await store.readPage({ scopeKey: "window", request: request({ pageSize: 10 }), loadIndex: async () => owner });
  for (let index = 0; index < 20; index += 1) {
    const exact = await store.readPage({ scopeKey: "window", request: request({ query: { kind: "exact", identities: [{ backend: "codex", threadId: String(index) }] } }), loadIndex: async () => owner });
    expect(exact.complete).toBe(true);
    expect(exact.nextCursor).toBeUndefined();
    const page = await store.readPage({ scopeKey: `window-${index}`, request: request(), loadIndex: async () => snapshot([thread(String(index))]) });
    expect(page.complete).toBe(true);
  }
  const rest = await store.readPage({ scopeKey: "window", request: request({ pageSize: 10, cursor: first.nextCursor }), loadIndex: async () => { throw new Error("Cursor must use retained authority"); } });
  expect(rest.generation).toBe(first.generation);
  expect(rest.entries).toHaveLength(10);
  expect(rest.complete).toBe(true);
});

it("idle_reconciliation_does_not_transfer_unchanged_rows: renews a retained range below 1 KiB after expiry", async () => {
  let now = 1;
  const store = new NavigationQueryStore({ now: () => now });
  const threads = Array.from({ length: 30 }, (_, index) => thread(`t${index}`));
  const read = (patch: Partial<NavigationQueryRequest> = {}) => store.readPage({
    scopeKey: "viewer", request: request({ pageSize: 10, ...patch }), loadIndex: async () => snapshot(threads),
  });
  const first = await read();
  now += 61_000;
  const retainedRange = { revision: first.countsRevision, ownerEpoch: first.ownerEpoch, start: 0, count: 10 };
  const ack = await read({ retainedRange });
  expect(ack.rangeUnchanged).toEqual({ start: 0, count: 10 });
  expect(ack.unchanged).toBeUndefined();
  expect(ack.complete).toBe(false);
  expect(ack.entries).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(ack))).toBeLessThan(1024);
  const next = await read({ cursor: ack.nextCursor });
  expect(next.entries).toHaveLength(10);
  expect(next.entries.some((entry) => first.entries.some((old) => old.row.ref.threadId === entry.row.ref.threadId))).toBe(false);
  threads[0]!.title = "Changed owner metadata";
  expect((await read({ retainedRange })).rangeUnchanged).toBeUndefined();
  expect((await read({ retainedRange: { ...retainedRange, ownerEpoch: "previous-process" } })).rangeUnchanged).toBeUndefined();
  await expect(read({ retainedRange: { ...retainedRange, count: -1 } })).rejects.toThrow("Invalid retained navigation range");
});

it("streams the same UTF-8 revision and backing count as canonical materialization JSON", () => {
  const value = { queryKey: "query", coverage: { state: "complete" as const },
    counts: { total: 1, active: 0, unread: 0, review: 0 }, pinnedRootCount: 0, unpinnedRootCount: 1, launchpadPresent: false,
    entries: [], directories: [{ key: "directory:日本語", kind: "directory" as const,
      label: "A \"quoted\" project 🚀", counts: { total: 1, active: 0, unread: 0, review: 0 }, pinnedRootCount: 0, unpinnedRootCount: 1, launchpadPresent: false }],
    collectionSize: undefined };
  const canonical = JSON.stringify(value);
  expect(fingerprintNavigationMaterialization(value)).toEqual({
    revision: createHash("sha256").update(canonical).digest("base64url"),
    retainedBytes: Buffer.byteLength(canonical, "utf8"),
  });
});

it("never serializes a whole retained collection while fingerprinting its generation", () => {
  const value = { queryKey: "large-query", coverage: { state: "complete" as const },
    counts: { total: 205, active: 0, unread: 0, review: 0 }, entries: [],
    directories: Array.from({ length: 205 }, (_, index) => ({ key: `directory:${index}`,
      kind: "directory" as const, label: "Label ".repeat(100),
      counts: { total: 1, active: 0, unread: 0, review: 0 }, pinnedRootCount: 0, unpinnedRootCount: 1, launchpadPresent: false })) };
  const stringify = vi.spyOn(JSON, "stringify");
  let serializedCollection: boolean;
  try {
    fingerprintNavigationMaterialization(value);
    serializedCollection = stringify.mock.calls.some(([input]) => {
      if (Array.isArray(input)) return input.length > 100;
      return input && typeof input === "object"
        && Object.values(input).some((field) => Array.isArray(field) && field.length > 100);
    });
  } finally { stringify.mockRestore(); }
  expect(serializedCollection).toBe(false);
});
