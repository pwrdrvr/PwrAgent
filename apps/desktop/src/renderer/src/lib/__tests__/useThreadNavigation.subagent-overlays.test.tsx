import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import type { NavigationThreadSummary, ThreadSubAgentSummary } from "@pwragent/shared/contracts/navigation";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import type { DesktopApi } from "../desktop-api";
import { threadSummaryIdentityKey } from "../federated-thread-events";
import { readRendererFederationTarget } from "../federation-window";
import { useThreadNavigation } from "../useThreadNavigation";

const owner = (instanceId: string): FederationRemoteTarget => ({ scope: "remote", instanceId });
const studio = owner("fixture-studio");
const tower = owner("fixture-tower");
const threadOwner = (thread: NavigationThreadSummary) => thread.federation?.ref.target.scope === "remote"
  ? thread.federation.ref.target.instanceId : undefined;
const helper = (monitorId: string): ThreadSubAgentSummary => ({
  monitorId, agentName: "Fixture helper", task: "Inspect contrived changes", status: "running", createdAt: 2_000, updatedAt: 2_000,
});

const visits = { rows: 0 };
vi.mock("../navigation-window-demand", async (importOriginal) => {
  const original = await importOriginal<typeof import("../navigation-window-demand")>();
  return { ...original, projectDisclosedNavigationParents: (...args: Parameters<typeof original.projectDisclosedNavigationParents>) => {
    visits.rows += args[0]?.size ?? 0;
    return original.projectDisclosedNavigationParents(...args);
  } };
});

function fixture(extraRows = 0) {
  const local: NavigationThreadSummary = {
    id: "shared-thread", source: "codex", title: "Local fixture", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: true }, subAgents: [],
  };
  const threads = [local, ...[studio, tower].map((target): NavigationThreadSummary => ({
    ...local, title: target.instanceId,
    federation: { instanceLabel: target.instanceId, ref: { backend: "codex", threadId: local.id, target } },
  }))];
  for (let i = 0; i < extraRows; i++) threads.push({ ...local, id: `extra-${i}` });
  const listeners = new Set<(event: AgentEvent) => void>();
  let holdPages = false;
  // Keep refreshes pending after mounting: an event overlay must be visible
  // before an owner query returns. The transport never applies events for us.
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>((request) => holdPages
    ? new Promise(() => {}) : Promise.resolve(navigationQueryFixture(request, { threads })));
  const detail = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>(async (request) => ({
    protocol: 2, ref: request.ref, revision: "fixture-detail", readiness: "ready", identity: "present",
    thread: threads.find((thread) => thread.id === request.ref.threadId && thread.source === request.ref.backend
      && threadOwner(thread) === (request.federationTarget?.scope === "remote" ? request.federationTarget.instanceId : undefined)),
  }));
  const api: DesktopApi = {
    getNavigationQueryPage: read, getNavigationSelectedDetail: detail,
    releaseNavigationQuery: async () => undefined,
    onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    api, read, threads,
    holdPages: () => { holdPages = true; },
    send: (event: AgentEvent) => { for (const listener of listeners) listener(event); },
    emit: (target: FederationRemoteTarget, params: { subAgents?: ThreadSubAgentSummary[]; navigationChanged?: false }) => {
      const event: AgentEvent = { backend: "codex", federationTarget: target,
        notification: { method: "thread/subAgents/updated", params: { threadId: local.id, ...params } } };
      for (const listener of listeners) listener(event);
    },
  };
}

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  expect(readRendererFederationTarget()).toBeUndefined();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("patches only the emitting peer's mounted sub-agent overlay with colliding thread IDs", async () => {
  const f = fixture();
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.threads).toHaveLength(3));
  await act(async () => { await result.current.showThread({ backend: "codex", threadId: "shared-thread", federationTarget: studio }); });
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  expect(result.current.selectedThread?.federation?.ref.target).toEqual(studio);
  const row = (target?: FederationRemoteTarget) => result.current.threads.find((thread) =>
    threadOwner(thread) === target?.instanceId)!;
  const localBefore = row();
  const towerBefore = row(tower);
  f.holdPages();
  const readsBefore = f.read.mock.calls.length;
  const studioHelpers = [helper("fixture-studio-helper")];

  await act(async () => { f.emit(studio, { subAgents: studioHelpers }); });

  // Exact selected detail has its own production event path. It does not
  // replace the loaded-row overlay used by other navigation consumers.
  expect(result.current.selectedThread?.subAgents).toEqual(studioHelpers);
  expect(row(studio).subAgents).toEqual(studioHelpers);
  expect(row()).toEqual(localBefore);
  expect(row(tower)).toEqual(towerBefore);

  const towerHelpers = [helper("fixture-tower-helper")];
  await act(async () => { f.emit(tower, { subAgents: towerHelpers }); });

  expect(row(tower).subAgents).toEqual(towerHelpers);
  expect(row(studio).subAgents).toEqual(studioHelpers);
  expect(result.current.selectedThread?.subAgents).toEqual(studioHelpers);
  expect(row()).toEqual(localBefore);
  await waitFor(() => expect(f.read.mock.calls.length).toBeGreaterThan(readsBefore));
  unmount();
});

it("keeps navigationChanged:false peer events out of row overlays and navigation refresh", async () => {
  const f = fixture();
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.threads).toHaveLength(3));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  const before = result.current.threads;
  const readsBefore = f.read.mock.calls.length;
  f.holdPages();
  vi.useFakeTimers();

  await act(async () => {
    f.emit(studio, { navigationChanged: false, subAgents: [helper("fixture-detail-only-helper")] });
    await vi.advanceTimersByTimeAsync(1_000);
  });

  expect(result.current.threads).toEqual(before);
  expect(f.read).toHaveBeenCalledTimes(readsBefore);
  unmount();
});

it("refreshes mounted navigation for a peer sub-agent invalidation without a payload", async () => {
  const f = fixture();
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.threads).toHaveLength(3));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  const before = result.current.threads;
  const readsBefore = f.read.mock.calls.length;
  f.holdPages();

  await act(async () => { f.emit(studio, {}); });

  await waitFor(() => expect(f.read.mock.calls.length).toBeGreaterThan(readsBefore));
  expect(result.current.threads).toEqual(before);
  unmount();
});

it("retains each peer’s live card reading across a pending page without fetching another", async () => {
  const f = fixture();
  const { result } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.threads).toHaveLength(3));
  const savedRead = f.read.getMockImplementation()!;
  const gate = Promise.withResolvers<void>();
  f.read.mockImplementation(async (request) => {
    const page = await savedRead(request);
    await gate.promise;
    return { ...page, entries: page.entries.map((entry) => ({
      ...entry, row: { ...entry.row, title: "Read before the usage event" },
    })) };
  });
  let pending!: Promise<void>;
  act(() => { pending = result.current.pagedNavigation.restart("lens"); });
  await waitFor(() => expect(result.current.pagedNavigation.resources.get("lens")?.loading).toBe(true));
  const reads = f.read.mock.calls.length;
  const threadId = "shared-thread";
  await act(async () => f.send({ backend: "codex", federationTarget: studio, notification: {
    method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: {
      last: { totalTokens: 25 }, total: { totalTokens: 750 }, modelContextWindow: 100,
    } },
  } }));
  await act(async () => f.send({ backend: "codex", federationTarget: tower, notification: {
    method: "thread/contextWindow/updated", params: { threadId, usedTokens: 60, modelContextWindow: 200 },
  } }));
  const reading = (target?: FederationRemoteTarget) => {
    const row = result.current.threads.find((thread) => threadOwner(thread) === target?.instanceId)!;
    return result.current.contextWindows.read(threadSummaryIdentityKey(row), row.contextWindow);
  };
  expect(reading(studio)).toEqual({ totalTokens: 25, modelContextWindow: 100 });
  expect(reading(tower)).toEqual({ totalTokens: 60, modelContextWindow: 200 });
  expect(reading()).toBeUndefined();
  await act(async () => f.send({ backend: "codex", federationTarget: { scope: "local" }, notification: {
    method: "thread/contextWindow/updated", params: { threadId, usedTokens: 0, modelContextWindow: 100 },
  } }));
  expect(reading()).toEqual({ totalTokens: 0, modelContextWindow: 100 });
  expect(f.read).toHaveBeenCalledTimes(reads);
  await act(async () => { gate.resolve(); await pending; });
  expect(reading(studio)).toEqual({ totalTokens: 25, modelContextWindow: 100 });
  expect(reading(tower)).toEqual({ totalTokens: 60, modelContextWindow: 200 });
});

const fill = (totalTokens: number) => ({ totalTokens, modelContextWindow: 100 });
const contextEvent = (thread: NavigationThreadSummary, usedTokens: number, source?: "session" | "compaction"): AgentEvent => ({
  backend: thread.source, notification: { method: "thread/contextWindow/updated",
    params: { threadId: thread.id, usedTokens, modelContextWindow: 100, source } },
});

// The live model call wins until its fill reaches the owner page. Session hints
// and billing/compaction telemetry are not observations of an ordinary model call.
it.each([
  { order: "event before read", source: "acp:fixture", initial: 25, live: 60, page: 25, expected: 60 },
  { order: "first page pending", source: "acp:fixture", initial: 25, live: 60, page: 25, expected: 60 },
  { order: "compaction", source: "acp:fixture", initial: 25, live: 60, page: 75, expected: 75 },
  { order: "billing", source: "claude", initial: 25, live: 60, page: 75, expected: 75 },
  { order: "repeat", source: "acp:fixture", initial: 25, live: 25, page: 10, expected: 25 },
  { order: "session hint", source: "acp:fixture", initial: 25, live: 60, page: 75, expected: 75 },
] as const)("resolves the card reading when $order", async ({ order, source, initial, live, page, expected }) => {
  const f = fixture();
  const thread = { ...f.threads[0]!, source, id: "meter", contextWindow: fill(initial) };
  if (order !== "first page pending") f.threads.push(thread);
  const { result } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.threads.length).toBe(f.threads.length));
  const key = threadSummaryIdentityKey(thread);
  const row = () => result.current.threads.find((entry) => entry.id === thread.id);
  const reading = () => result.current.contextWindows.read(key, row()?.contextWindow);
  const send = () => f.send(order === "billing" ? { backend: source, notification: {
    method: "thread/tokenUsage/updated", params: { threadId: thread.id, tokenUsage: { total: { totalTokens: 750 } } },
  } } : contextEvent(thread, live, order === "compaction" ? "compaction" : order === "session hint" ? "session" : undefined));
  if (order === "event before read") await act(async () => send());
  if (order === "first page pending") f.threads.push(thread);
  thread.contextWindow = fill(page);
  const gate = Promise.withResolvers<void>();
  const original = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (request) => { const result = await original(request); await gate.promise; return result; });
  let pending!: Promise<void>;
  act(() => { pending = result.current.pagedNavigation.restart("lens"); });
  await waitFor(() => expect(result.current.pagedNavigation.resources.get("lens")?.loading).toBe(true));
  if (order !== "event before read") await act(async () => send());
  if (order === "first page pending") expect(row()).toBeUndefined();
  if (order === "compaction" || order === "billing" || order === "session hint") expect(reading()).toEqual(fill(initial));
  await act(async () => { gate.resolve(); await pending; });
  expect(row()?.contextWindow).toBeDefined();
  expect(reading()).toEqual(fill(expected));
  thread.contextWindow = fill(expected);
  await act(async () => result.current.pagedNavigation.restart("lens"));
  thread.contextWindow = fill(80);
  await act(async () => result.current.pagedNavigation.restart("lens"));
  expect(reading()).toEqual(fill(80));
});

it("visits no navigation rows and preserves the thread list across a burst of meter events", async () => {
  const f = fixture(21);
  const { result } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.threads).toHaveLength(10));
  await act(async () => result.current.pagedNavigation.loadMore("lens"));
  await waitFor(() => expect(result.current.threads).toHaveLength(24));
  const before = result.current.threads;
  visits.rows = 0;
  for (let i = 0; i < 8; i++) await act(async () => f.send(contextEvent(f.threads[0]!, i)));
  expect(visits.rows).toBe(0);
  expect(result.current.threads).toBe(before);
});
