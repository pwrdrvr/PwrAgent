import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationQueryPage, NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import { appendViewerNavigationPins } from "../app-server/navigation-viewer-pins";
import { buildDirectorySummaries } from "@pwragent/shared/directory-navigation";
import { expandNavigationRemoteOwner, navigationQueryPageBudgetBytes } from "@pwragent/shared/navigation-remote-owner";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { NavigationQueryStore } from "@pwragent/owner-core/navigation-query-store";
import { createNavigationQuerySnapshot, projectNavigationQuery } from "@pwragent/owner-core/navigation-query-projection";
import { LiveNavigationIndex } from "../app-server/live-navigation-index";
import { NavigationWindowPageDeltas } from "../app-server/navigation-window-page-deltas";
import { expandWindowNavigationPage, NavigationWindowQueries } from "../../renderer/src/lib/navigation-window-queries";

function fixture(observe?: (event: AgentEvent) => void, durable = false,
  refresh?: ConstructorParameters<typeof LiveNavigationIndex>[0]["refresh"]) {
  const db = durable ? openInMemoryStateDb() : undefined;
  const storage = db && new SqliteOverlayStore(db);
  const providers = new Map<string, AppServerThreadSummary>(["a", "b", "c", "d"].map((id) =>
    [id, { id, source: "codex", title: id, titleSource: "explicit", updatedAt: 2, linkedDirectories: [{ id: "project", label: "Project", path: "/project", kind: "local" }], threadStatus: "idle" }]));
  const archived = new Set<string>();
  const overlays = new Map<string, Partial<NavigationThreadSummary>>();
  const rows = () => [...providers.values()].filter((row) => !archived.has(row.id));
  const projectRows = (threads: AppServerThreadSummary[]): NavigationThreadSummary[] => storage
    ? storage.readNavigationQueryThreads({ backend: "all", threads }).threads
    : threads.map((row) => ({ ...row, inbox: { inInbox: false }, ...overlays.get(row.id) }));
  const directories = (threads: NavigationThreadSummary[]) => ({ directories: storage ? storage.readNavigationQueryDirectories(threads).directories : buildDirectorySummaries({ threads }) });
  const full = () => {
    const inputs = rows();
    const threads = storage ? storage.readNavigationQueryIndex({ backend: "all", threads: inputs }) : undefined;
    if (threads) return { threads: threads.threads, directories: threads.directories, coverage: { state: "complete" as const } };
    const projected = projectRows(inputs);
    const index = { threads: projected, ...directories(projected) };
    return { threads: index.threads, directories: index.directories, coverage: { state: "complete" as const } };
  };
  function persist(id: string) {
    const row = overlays.get(id)!;
    db?.raw.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:" + id,
      JSON.stringify({ backend: "codex", threadId: id, parentThreadId: row.parentThreadId, pinnedRank: row.pinnedRank,
        lastSeenUpdatedAt: row.inbox?.inInbox ? 1 : 2 }));
  }
  let complete = Promise.withResolvers<void>();
  let gate: Promise<void> | undefined;
  let version = 0;
  const lists: string[] = [];
  const live = new LiveNavigationIndex({
    backend: "all", version: () => String(version) + ":0", changedKeys: () => undefined,
    sqlite: async (known) => { const result = structuredClone(rows().filter((row) => known.some((old) => old.id === row.id))); await gate; return result; },
    list: async (scope) => {
      lists.push(scope);
      const captured = structuredClone(rows());
      await gate;
      return { rows: captured, coverage: { state: "complete" } };
    },
    join: async (rows, coverage) => {
      const threads = projectRows(rows);
      return { threads, coverage, ...directories(threads) };
    },
    cached: (_, id) => providers.get(id), refresh,
    projectRows: async (rows) => projectRows(rows), directories: async (threads) => { await gate; return directories(threads); },
    inputKeys: () => new Set(), retentionChanged: () => {}, notify: () => complete.resolve(), failed: (error) => { throw error; },
  });
  const emit = (notification: AgentEvent["notification"]) => {
    const event = { backend: "codex" as const, notification };
    observe?.(event);
    live.event(event);
  };
  return { live, providers, archived, overlays, full, emit, lists, persist, close: () => { live.close(); db?.close(); },
    block: (promise: Promise<void>) => { gate = promise; },
    external: () => { version++; },
    completion: () => { complete = Promise.withResolvers<void>(); return complete.promise; } };
}

const operation = fc.record({
  kind: fc.constantFrom("status", "pin", "parent", "archive", "seen", "reconnect"),
  id: fc.constantFrom("a", "b", "c", "d"), on: fc.boolean(),
});

async function compareSequence(ops: readonly { kind: string; id: string; on: boolean }[], durable = false) {
  const actualStore = new NavigationQueryStore();
  const expectedStore = new NavigationQueryStore();
  const f = fixture((event) => {
    actualStore.observeAttentionEvent(event);
    expectedStore.observeAttentionEvent(event);
  }, durable);
  try {
    await f.live.read();
    for (const { kind, id, on } of ops) {
      const provider = f.providers.get(id)!;
      const overlay = f.overlays.get(id) ?? {};
      f.overlays.set(id, overlay);
      if (kind === "reconnect") {
        provider.threadStatus = on ? "active" : "idle";
        const done = f.completion();
        f.emit({ method: "navigation/providerThreads/refreshed", params: { failedProviders: 0, backend: "codex" } });
        await done;
      } else if (kind === "archive") {
        if (on) f.archived.add(id);
        else f.archived.delete(id);
        f.emit(on ? { method: "thread/archived", params: { threadId: id } } : { method: "thread/unarchived", params: { threadId: id } });
      } else if (kind === "status") {
        provider.threadStatus = on ? "active" : "idle";
        f.emit({ method: "thread/status/changed", params: { threadId: id, status: { type: provider.threadStatus } } });
      } else if (kind === "pin") {
        overlay.pinnedRank = on ? "100" : undefined;
        f.emit(on ? { method: "thread/pin/added", params: { threadId: id, pinnedRank: "100" } }
          : { method: "thread/pin/removed", params: { threadId: id } });
      } else if (kind === "parent" && id !== "a") {
        overlay.parentThreadId = on ? "a" : undefined;
        f.emit(on ? { method: "thread/parent/set", params: { threadId: id, parentThreadId: "a" } }
          : { method: "thread/parent/cleared", params: { threadId: id } });
      } else {
        overlay.inbox = { inInbox: on };
        f.emit({ method: "navigation/thread/seen", params: { threadId: id } });
      }
      if (kind === "pin" || kind === "parent" || kind === "seen") f.persist(id);
      const index = await f.live.read();
      const reference = createNavigationQuerySnapshot({ ...f.full(), observedAt: index.observedAt });
      for (const query of [
        { kind: "lens", lens: "inbox", roots: "pinned" }, { kind: "directory-index" },
      ] as const) {
        const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query };
        expect(projectNavigationQuery({ index, request })).toEqual(projectNavigationQuery({ index: reference, request }));
      }
      const comparePage = async (request: NavigationQueryRequest) => {
        const actual = await actualStore.readPage({ incremental: true, scopeKey: "test", request, loadIndex: async () => index });
        const expected = await expectedStore.readPage({ incremental: true, scopeKey: "test", request, loadIndex: async () => reference });
        expect([actual.entries, actual.countsRevision, actual.counts, Boolean(actual.nextCursor)])
          .toEqual([expected.entries, expected.countsRevision, expected.counts, Boolean(expected.nextCursor)]);
      };
      await comparePage({ protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox", roots: "unpinned" }, pageSize: 1 });
      for (const promote of [true, false]) {
        const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "attention" },
          attentionView: { id: String(promote), promoteOnTurnEnd: promote }, pageSize: 2 };
        await comparePage(request);
      }
    }
  } finally { f.close(); }
}

it("agrees with full projection after status, pin, archive, parent, seen and reconnect events", async () => {
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 5, maxLength: 18 }), (ops) => compareSequence(ops)), { numRuns: Number(process.env.AUDIT_CASES), seed: 45904590 });
});
