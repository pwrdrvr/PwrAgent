import fc from "fast-check";
import { expect, it, vi } from "vitest";
import {
  buildFederatedThreadRef,
  type FederationCapability,
  type FederationProtocolEnvelope,
} from "@pwragent/shared/contracts/federation";
import { buildThreadIdentityKey, type NavigationQueryRequest } from "@pwragent/shared/contracts/navigation";
import { expandNavigationRemoteOwner } from "@pwragent/shared/navigation-remote-owner";
import { navigationQueryEventRequiresRefresh } from "@pwragent/shared/navigation-query-events";
import { type AgentEvent } from "@pwragent/shared/contracts/agent";
import { createNavigationQuerySnapshot, type NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import { NavigationWindowQueries } from "../../renderer/src/lib/navigation-window-queries";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { FederationRouter } from "../federation/federation-router";
import { navigationRequestForOwner } from "../federation/federation-navigation-query";
import { readFederationPinnedSnapshot } from "../federation/federation-collection-client";
import { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";
import type { FederationBackendOperations } from "../federation/federation-backend-bridge";
import { listingDiagnostics, listingRequestFields } from "../diagnostics/listing-diagnostics";

const target = { scope: "remote" as const, instanceId: "owner_one" };
const capabilities: FederationCapability[] = ["event_subscriptions", "thread_navigation", "thread_detail", "navigation_snapshot_deltas"];
const ref = (threadId: string) => ({ backend: "codex" as const, threadId, ownerInstanceId: target.instanceId });
const directoryKey = (group: number) => `directory:/fixture/${group}`;
const worktreePath = (id: string) => `/working/${id}`;
const workingState = { dirtyFiles: 1, dirtyAdditions: 2, dirtyDeletions: 0, untrackedFiles: 0, unpushedCommits: 0 };

function population(groups: number, coverage: "complete" | "degraded" = "complete"): NavigationQueryIndex {
  const threads: NavigationQueryIndex["threads"] = [];
  const directories: NavigationQueryIndex["directories"] = [];
  for (let group = 0; group < groups; group++) {
    const members = Array.from({ length: 3 }, (_, tray) => [undefined, 0, 1].map((child) => {
      const parent = `${group}-${tray}`;
      const id = child === undefined ? parent : `${parent}-${child}`;
      return {
        id, source: "codex" as const, title: id, titleSource: "explicit" as const,
        createdAt: child === undefined ? tray : child + 10, updatedAt: 100, inbox: { inInbox: true },
        linkedDirectories: [], projectKey: worktreePath(id),
        ...(child === undefined ? {} : { parentThreadId: parent, parentThreadBackend: "codex" as const }),
      };
    })).flat();
    threads.push(...members);
    directories.push({ key: directoryKey(group), label: `Project ${group}`, kind: "directory", needsAttentionCount: members.length,
      threadKeys: members.map((thread) => buildThreadIdentityKey(thread.source, thread.id)) });
  }
  return { threads, directories, coverage: { state: coverage } };
}

function request(query: NavigationQueryRequest["query"], pageSize = 1): NavigationQueryRequest {
  return { protocol: 2, consumer: "main-sidebar", inventory: "owner", federationTarget: target, pageSize, query };
}

function demand(groups: number) {
  const queries = new Map([["index", request({ kind: "directory-index" }, 100)],
    ["exact", request({ kind: "exact", identities: [ref("0-2")], includeAncestry: true }, 100)]]);
  for (let group = 0; group < groups; group++) {
    for (const roots of ["pinned", "unpinned"] as const) {
      queries.set(`${roots}:${group}`, request({ kind: "directory", directoryKey: directoryKey(group), roots }));
    }
    for (let tray = 0; tray < 3; tray++) {
      const parent = ref(`${group}-${tray}`);
      queries.set(`children:${group}-${tray}`, request({ kind: "children", parent, directoryKey: directoryKey(group) }));
    }
  }
  return queries;
}

type WireEndpoint = {
  localInstanceId: string;
  router: FederationRouter;
  applyEventSubscription(envelope: FederationProtocolEnvelope, source: string): boolean;
  publishRemoteBackendEvent(envelope: FederationProtocolEnvelope, source: string): boolean;
  forwardLocalBackendEvent(event: AgentEvent): void;
  remoteThreadSummaryCache: { invalidate: ReturnType<typeof vi.fn> };
};

function connect(publish: (event: AgentEvent) => void, cache?: RemoteThreadSummaryCache) {
  const makeRuntime = (id: string) => {
    const runtime = new DesktopFederationRuntime();
    const wire = runtime as unknown as WireEndpoint;
    wire.localInstanceId = id;
    wire.router = new FederationRouter({ localInstanceId: id });
    return { runtime, wire };
  };
  const owner = makeRuntime(target.instanceId);
  const viewer = makeRuntime("viewer_one");
  const invalidateSummary = vi.fn((instanceId: string, event?: AgentEvent) => cache?.invalidate(instanceId, event));
  viewer.wire.remoteThreadSummaryCache = { invalidate: invalidateSummary };
  viewer.runtime.setAgentEventPublisher(publish);
  viewer.wire.router.registerConnection({ peerId: target.instanceId, capabilities,
    sendEnvelope: (frame) => { owner.wire.applyEventSubscription(frame, "viewer_one"); } });
  let dropNext = false;
  owner.wire.router.registerConnection({ peerId: "viewer_one", capabilities,
    sendEnvelope: (frame) => {
      if (dropNext) { dropNext = false; return; }
      viewer.wire.publishRemoteBackendEvent(frame, target.instanceId);
    } });
  viewer.runtime.setEventSubscriptions("navigation", [{ sourceInstanceId: target.instanceId,
    eventClasses: ["navigation"], threadSelection: { kind: "all" } }]);
  return {
    emit: (event: AgentEvent) => owner.wire.forwardLocalBackendEvent(event),
    dropNext: () => { dropNext = true; },
    invalidateSummary,
    select: (threadId: string) => viewer.runtime.setEventSubscriptions("transcript", [{ sourceInstanceId: target.instanceId,
      eventClasses: ["transcript"], threadSelection: { kind: "threads", threads: [ref(threadId)] } }]),
  };
}

const workingStateEvent = (id: string): AgentEvent => ({ backend: "codex", notification: {
  method: "navigation/threadGitWorkingState/updated", params: { worktreePath: worktreePath(id), gitWorkingState: workingState, fetchedAt: 100 },
} });
const seenEvent = (threadId: string): AgentEvent => ({ backend: "codex", notification: {
  method: "navigation/thread/seen", params: { threadId, seenUpdatedAt: 100 },
} });
const delta = (threadId: string): AgentEvent => ({ backend: "codex", notification: {
  method: "item/agentMessage/delta", params: { threadId, turnId: "turn", itemId: "item", delta: "part" },
} });

async function until(predicate: () => boolean) {
  for (let step = 0; step < 1_000 && !predicate(); step++) await Promise.resolve();
  expect(predicate()).toBe(true);
}

const idle = (window: NavigationWindowQueries) => [...window.getSnapshot().resources.values()].every((resource) => !resource.loading);

async function exerciseMetadata(groups: number, group: number, tray: number, kind: "seen" | "working", coverage: "complete" | "degraded" = "complete") {
  let data = population(groups, coverage);
  let indexWork = 0;
  let childWork = 0;
  const snapshot = () => createNavigationQuerySnapshot(data, (stage, threads) => {
    if (stage === "index") indexWork += threads;
    else childWork += threads;
  });
  let index = snapshot();
  const store = new NavigationQueryStore();
  const requests = demand(groups);
  const byQuery = new Map([...requests].map(([id, value]) => [JSON.stringify(value.query), id]));
  const attempts: string[] = [];
  const logicalReads = new Set<number>();
  let indexReads = 0;
  const window = new NavigationWindowQueries({ getNavigationQueryPage: async (sent) => {
    attempts.push(byQuery.get(JSON.stringify(sent.query))!);
    logicalReads.add(sent.diagnostic!.logical);
    // Use the production IPC trace at the renderer-to-main seam. The owner
    // is in-process here, so these are handler starts rather than OS IPC.
    const page = await listingDiagnostics.trace("ipc", { ...listingRequestFields(sent), sender: 3 }, () => store.readPage({
      request: navigationRequestForOwner(sent, target), scopeKey: "viewer_one", loadIndex: async () => { indexReads++; return index; },
    }));
    return expandNavigationRemoteOwner({ ...page, remoteOwner: { instanceId: target.instanceId, instanceLabel: "Owner" } });
  } });
  const wire = connect((event) => {
    if (navigationQueryEventRequiresRefresh(event.notification.method, event.notification.params)) window.invalidate(undefined, [target], event);
  });
  try {
    window.setDemand(requests);
    await until(() => idle(window));
    const id = `children:${group}-${tray}`;
    const rows = () => [...window.getSnapshot().resources].map(([key, resource]) => [key, resource.state.page?.entries.map(({ row }) => row.id)]);
    const initial = rows();
    for (const [, resource] of window.getSnapshot().resources) expect(resource.state.page).toBeDefined();
    const child = [`${group}-${tray}-0`, `${group}-${tray}-1`].find((name) =>
      !window.getSnapshot().resources.get(id)?.state.page?.entries.some(({ row }) => row.id === name))!;
    const publications: unknown[] = [];
    const off = window.subscribe(() => publications.push(rows()));
    try {
      attempts.length = indexReads = indexWork = childWork = 0;
      logicalReads.clear();
      listingDiagnostics.setEnabled(true, "replay");
      data = { ...data, threads: data.threads.map((thread) => thread.id !== child ? thread : kind === "seen"
        ? { ...thread, inbox: { inInbox: false } } : { ...thread, gitWorkingState: workingState, gitWorkingStateFetchedAt: 100 }) };
      index = snapshot();
      wire.emit(kind === "seen" ? seenEvent(child) : workingStateEvent(child));
      await window.refresh(undefined, [target], true);
      const expected = kind === "working" ? [id] : ["index", ...(group === 0 ? ["exact"] : []),
        `pinned:${group}`, `unpinned:${group}`, ...Array.from({ length: 3 }, (_, index) => `children:${group}-${index}`)];
      if (coverage === "complete") expect(attempts.toSorted(), `${groups} directories, ${kind} page attempts`).toEqual(expected.toSorted());
      else expect(attempts).toContain(id);
      const starts = listingDiagnostics.snapshot().events.filter((event) => event.stage === "ipc" && event.phase === "start");
      expect(starts).toHaveLength(attempts.length);
      expect(new Set(starts.map((event) => event.logical))).toEqual(logicalReads);
      expect(logicalReads.size).toBe(attempts.length); // this first-page demand does not require a continuation
      expect(indexReads).toBe(attempts.length);
      expect(indexWork).toBe(data.threads.length);
      expect(childWork).toBeLessThanOrEqual(data.threads.length + 9 * attempts.length);
      for (const commit of publications) expect(commit).toEqual(initial);
      if (kind === "seen") {
        expect(window.getSnapshot().resources.get(id)?.state.page?.counts.unread).toBe(1);
        expect(window.getSnapshot().resources.get("index")?.state.page?.directories?.find((directory) => directory.key === directoryKey(group))?.counts.unread).toBe(8);
      }
      if (coverage === "complete") {
        attempts.length = 0;
        wire.emit(workingStateEvent("unknown"));
        await window.refresh(undefined, [target], true);
        expect(attempts).toHaveLength(0);
      }
    } finally { listingDiagnostics.setEnabled(false, "replay"); off(); }
  } finally { window.dispose(); }
}

it.each([3, 6].flatMap((groups) => (["seen", "working"] as const).map((kind) => ({ groups, kind }))))(
  "bounds a single off-page $kind change with $groups expanded directories", async ({ groups, kind }) => {
    await exerciseMetadata(groups, 0, 0, kind);
});

it("matches complete owner counts and retains ordered rows for generated off-page metadata changes", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(3, 6), fc.nat(5), fc.nat(2), fc.boolean(), fc.boolean(),
    async (groups, group, tray, seen, complete) => {
      await exerciseMetadata(groups, group % groups, tray, seen ? "seen" : "working", complete ? "complete" : "degraded");
    }), { numRuns: 25 });
});

it("keeps a large owner row on its original page when the optional proof does not fit", async () => {
  const data = population(3);
  data.threads[0] = { ...data.threads[0]!, title: "x".repeat(230_000), projectKey: `/${"p".repeat(18_000)}` };
  const store = new NavigationQueryStore();
  const sent = navigationRequestForOwner(request({ kind: "exact", identities: [ref(data.threads[0]!.id)] }), target);
  const page = await store.readPage({ request: sent, scopeKey: "owner", loadIndex: async () => data });
  expect(page.complete).toBe(true);
  expect(page.metadataDependencies).toBeUndefined();
  expect(page.entries.map(({ row }) => row.id)).toEqual([data.threads[0]!.id]);
});

it("delivers transcript acknowledgements without reopening a continuous navigation subscription", () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 15 }), (dropBeforeSelection) => {
    const events: AgentEvent[] = [];
    const wire = connect((event) => events.push(event));
    let selected = 0;
    wire.select(`thread-${selected}`);
    for (const drop of dropBeforeSelection) {
      events.length = 0;
      wire.invalidateSummary.mockClear();
      if (drop) wire.dropNext();
      wire.emit(delta(`thread-${selected}`));
      wire.select(`thread-${++selected}`);
      const acknowledgements = events.filter(({ notification }) => notification.method === "federation/eventStream/changed");
      expect(acknowledgements).toHaveLength(1);
      const { method, params } = acknowledgements[0]!.notification;
      expect(navigationQueryEventRequiresRefresh(method, params)).toBe(drop);
      expect(wire.invalidateSummary).toHaveBeenCalledTimes(Number(drop));
      wire.emit(delta(`thread-${selected}`));
      expect(events.at(-1)?.notification).toEqual(delta(`thread-${selected}`).notification);
    }
  }), { numRuns: 25 });
});

it("publishes the owner's discovered rows after late reads while an independent window changes owners", async () => {
  // Model: each commit contains the original two ordered children, plus the
  // new third child only after an authoritative read for its own owner.
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), async (drop, reverseReplies, markSeen) => {
    const other = { scope: "remote" as const, instanceId: "owner_two" };
    let index = createNavigationQuerySnapshot(population(3));
    const otherIndex = index;
    const store = new NavigationQueryStore();
    const replies: Array<() => void> = [];
    const firstAttempts: Array<{ logical: number; cursor: boolean }> = [];
    const cancelled = vi.fn(async (_token: string) => undefined);
    const selection = request({ kind: "children", parent: ref("0-0") });
    const readOwner = (sent: NavigationQueryRequest, scopeKey: string, observed = index) =>
      store.readPage({ request: sent, scopeKey, loadIndex: async () => observed });
    const renderer = (name: string) => new NavigationWindowQueries({ releaseNavigationQuery: cancelled,
      getNavigationQueryPage: async (sent) => {
        if (name === "first") firstAttempts.push({ logical: sent.diagnostic!.logical, cursor: Boolean(sent.cursor) });
        const owner = sent.federationTarget?.scope === "remote" ? sent.federationTarget : target;
        const page = await readOwner(navigationRequestForOwner(sent, owner), name, owner.instanceId === target.instanceId ? index : otherIndex);
        if (hold && owner.instanceId === target.instanceId && !sent.cursor) await new Promise<void>((resolve) => replies.push(resolve));
        return expandNavigationRemoteOwner({ ...page, remoteOwner: { instanceId: owner.instanceId, instanceLabel: owner.instanceId } });
      },
    });
    let hold = false;
    const first = renderer("first");
    const second = renderer("second");
    const viewerStore = new NavigationQueryStore();
    let viewerBuilds = 0;
    let summaries = 0;
    let pinPages = 0;
    const pin = (threadId: string) => ({ ref: buildFederatedThreadRef({ backend: "codex", instanceId: target.instanceId, threadId }),
      instanceLabel: "Owner", addedAt: 1 });
    const pins = ["0-0", "0-0-0", "0-0-1"].map(pin);
    const backend = { getNavigationQueryPage: async (sent: NavigationQueryRequest) => {
      pinPages++;
      const page = await readOwner(sent, "pins");
      return expandNavigationRemoteOwner({ ...page, remoteOwner: { instanceId: target.instanceId, instanceLabel: "Owner" } });
    } } as FederationBackendOperations;
    const cache = new RemoteThreadSummaryCache({ peers: () => [{ target, label: "Owner", capabilities }],
      peerStatus: () => ({ status: "connected" }), hasNavigationSubscription: () => true,
      fetchSnapshot: async () => { throw new Error("Unexpected legacy snapshot"); }, fetchArchivedThreads: async () => [],
      fetchPinnedSnapshot: (_owner, keys, options, baseline) => readFederationPinnedSnapshot(backend, keys, options, baseline),
      onPinnedSummariesRefreshed: (instanceId, rowChanges) => {
        summaries++;
        viewer.invalidate(undefined, [{ scope: "local" }], { backend: "codex", notification: {
          method: "navigation/remoteThreadPins/changed", params: { instanceId, ...(rowChanges ? { rowChanges } : {}) },
        } });
        void viewer.refresh(undefined, undefined, true);
      },
    });
    const viewer = new NavigationWindowQueries({ getNavigationQueryPage: (sent) => viewerStore.readPage({ request: sent, scopeKey: "viewer",
      loadIndex: async () => {
        viewerBuilds++;
        const { threads } = await cache.resolvePinnedThreads(pins);
        return createNavigationQuerySnapshot({ threads, directories: [], coverage: { state: "complete" } });
      },
    }) });
    const wire = connect((event) => {
      if (!navigationQueryEventRequiresRefresh(event.notification.method, event.notification.params)) return;
      for (const window of [first, second]) window.invalidate(undefined, [target], event);
    }, cache);
    const ids = (window: NavigationWindowQueries) => window.getSnapshot().resources.get("tray")?.state.page?.entries.map(({ row }) => row.id);
    const required = ["0-0-1", "0-0-0"];
    const published: string[][] = [];
    try {
      for (const window of [first, second]) window.setDemand(new Map([["tray", selection]]));
      await cache.resolvePinnedThreads(pins);
      await until(() => summaries > 0 && idle(first) && idle(second));
      viewer.setDemand(new Map([["tray", { ...selection, inventory: "viewer", federationTarget: undefined, pageSize: 100 }]]));
      await Promise.all([first.loadMore("tray"), second.loadMore("tray")]);
      await until(() => idle(viewer));
      for (const window of [first, second, viewer]) expect(ids(window)).toEqual(required);
      first.subscribe(() => published.push(ids(first)!));
      wire.select("0-0");
      await until(() => idle(viewer));
      // A transcript consumer receives the raw accounting notice even though
      // the owner correctly withheld the navigation-class announcement.
      const beforeAccounting = pinPages;
      wire.invalidateSummary.mockClear();
      wire.emit({ backend: "codex", notification: { method: "thread/subAgents/updated",
        params: { threadId: "0-0", navigationChanged: false } } });
      await Promise.resolve();
      expect(wire.invalidateSummary).not.toHaveBeenCalled();
      expect(pinPages).toBe(beforeAccounting);
      hold = true;
      firstAttempts.length = 0;
      const action = first.refresh("tray");
      void second.refresh("tray");
      await until(() => replies.length === 2);

      // On a continuous stream, transcript selection alone starts no owner
      // or viewer reads. A lost tail instead requires navigation recovery.
      if (drop) wire.dropNext();
      wire.emit(delta("0-0"));
      wire.select("0-1");
      const childId = "discovered";
      const child = { ...index.threads.find((thread) => thread.id === "0-0-1")!, id: childId, createdAt: 5, projectKey: worktreePath(childId) };
      index = createNavigationQuerySnapshot({ ...index, threads: [...index.threads, child], directories: index.directories.map((directory) =>
        directory.key === directoryKey(0) ? { ...directory, threadKeys: [...directory.threadKeys, `codex:${childId}`] } : directory) });
      wire.emit({ backend: "codex", notification: { method: "thread/parent/set", params: { threadId: childId, parentThreadId: "0-0" } } });
      if (markSeen) {
        index = createNavigationQuerySnapshot({ ...index, threads: index.threads.map((thread) =>
          thread.id === childId ? { ...thread, inbox: { inInbox: false } } : thread) });
        wire.emit(seenEvent(childId));
      }
      // Same-owner children are mounted individually by the viewer. The
      // pin demand can arrive before the owner's relationship is published.
      pins.push(pin(childId));
      await cache.resolvePinnedThreads(pins);
      second.setDemand(new Map([["tray", { ...selection, federationTarget: other,
        query: { kind: "children", parent: { ...ref("0-0"), ownerInstanceId: other.instanceId } } }]]));
      await until(() => idle(second));
      expect(cancelled).toHaveBeenCalledTimes(1);
      hold = false;
      if (reverseReplies) replies.reverse();
      replies.splice(0).forEach((reply) => reply());
      await action;
      const expected = [...required, childId];
      await until(() => idle(viewer) && ids(viewer)?.includes(childId) === true);
      expect(ids(first)).toEqual(expected);
      // One overtaken baseline, then a replacement whose continuation
      // restores the expanded range before the action completes.
      expect(new Set(firstAttempts.map(({ logical }) => logical)).size).toBe(2);
      expect(firstAttempts.map(({ cursor }) => cursor)).toEqual([false, false, true]);
      expect(ids(viewer)).toEqual(expected);
      expect(second.getSnapshot().resources.get("tray")?.state.page?.entries[0]?.row.ref.ownerInstanceId).toBe(other.instanceId);
      for (const commit of published) expect(commit).toEqual(commit.includes(childId) ? expected : required);
      for (const window of [first, viewer]) {
        expect(window.getSnapshot().resources.get("tray")?.state.page?.entries.at(-1)?.row.inbox.inInbox).toBe(!markSeen);
      }
      expect(viewerBuilds).toBeGreaterThan(1);
      expect(pinPages).toBeGreaterThanOrEqual(viewerBuilds);
    } finally {
      hold = false;
      replies.splice(0).forEach((reply) => reply());
      cache.dispose(); first.dispose(); second.dispose(); viewer.dispose();
    }
  }), { numRuns: 15 });
});
