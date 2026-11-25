import "@testing-library/jest-dom/vitest";
import { useMemo } from "react";
import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  NavigationSnapshot,
  NavigationThreadSummary,
  ThreadPrAutoDispatchPending,
} from "@pwragent/shared/contracts/navigation";
import { act, renderHook, waitFor } from "../../test/phase-probes";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import { navigationOwnerApiFixture, type NavigationOwnerFixtureApi } from "../../test/navigation-owner-api-fixture";
import { useComposerDraftStore } from "../../features/composer/useComposerDraftStore";
import { threadSummaryIdentityKey } from "../federated-thread-events";
import { useThreadNavigation } from "../useThreadNavigation";
import { useThreadQueuedMessageIndicators } from "../useThreadQueuedMessageIndicators";

/*
 * The sidebar's Scheduled chip for an Auto-fix repair, through the real
 * renderer path: owner pages merged into the loaded rows, the
 * pendingUpdated patch, the refresh that event causes, and the indicator
 * hook. The owner's rows (navigation-query-fixture, as the owner-core
 * projection) carry `prAutoDispatchActive` while a repair is pending or
 * being tried, and the cancellable `prAutoDispatchPending` only while it
 * is pending. Contrived data throughout.
 */
const pending = (scheduledAt: number): ThreadPrAutoDispatchPending => ({
  fingerprint: `fingerprint-${scheduledAt}`,
  prKey: "github.com/example/project#4400",
  prNumber: 4400,
  prTitle: "Contrived merge-conflict fixture",
  prUrl: "https://github.com/example/project/pull/4400",
  headSha: "a".repeat(40),
  eventKinds: ["merge-conflict"],
  createdAt: 1_000,
  scheduledAt,
});
const baseThread: NavigationThreadSummary = {
  id: "thread-auto-fix",
  title: "Auto-fix fixture",
  titleSource: "explicit",
  source: "codex",
  linkedDirectories: [],
  threadStatus: "active",
  prAutoDispatchEnabled: true,
  inbox: { inInbox: false },
  updatedAt: 1_000,
};
const threadKey = threadSummaryIdentityKey(baseThread);

it("keeps Scheduled across pendingUpdated patches, their refreshes and a mid-attempt refresh", async () => {
  let ownerThread: NavigationThreadSummary = baseThread;
  const snapshot = (): NavigationSnapshot => ({
    backend: "all", fetchedAt: 1_000, unchanged: false, inboxThreadKeys: [],
    threads: [ownerThread], directories: [],
    launchpadDefaults: { backend: "codex", executionMode: "default" },
  });
  const listeners = new Set<(event: AgentEvent) => void>();
  const getNavigationQueryPage = vi.fn(async (request: Parameters<NonNullable<NavigationOwnerFixtureApi["getNavigationQueryPage"]>>[0]) =>
    navigationQueryFixture(request, snapshot()));
  const api: NavigationOwnerFixtureApi = {
    readPopulation: async () => snapshot(),
    getNavigationQueryPage,
    // Selection falls back to the loaded row until its detail arrives.
    getNavigationSelectedDetail: () => new Promise(() => undefined),
    onAgentEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emit = (value: ThreadPrAutoDispatchPending | null) => {
    for (const listener of listeners) listener({ backend: "codex", notification: {
      method: "thread/prAutoDispatch/pendingUpdated", params: { threadId: baseThread.id, pending: value } } });
  };
  /** A refresh caused by an unrelated row change on the same thread. */
  const touch = () => {
    for (const listener of listeners) listener({ backend: "codex", notification: {
      method: "thread/name/updated", params: { threadId: baseThread.id, threadName: baseThread.title } } });
  };
  const { result } = renderHook(() => {
    const composerDraftStore = useComposerDraftStore();
    const ownerApi = useMemo(() => navigationOwnerApiFixture(api), []);
    const navigation = useThreadNavigation(ownerApi, { composerDraftStore });
    const indicators = useThreadQueuedMessageIndicators({ composerDraftStore, threads: navigation.threads });
    return { ...navigation, indicators };
  });
  await waitFor(() => expect(result.current.threads.map(threadSummaryIdentityKey)).toEqual([threadKey]));
  expect(result.current.indicators).toEqual({});
  const refreshed = async () => {
    const calls = getNavigationQueryPage.mock.calls.length;
    await waitFor(() => expect(getNavigationQueryPage.mock.calls.length).toBeGreaterThan(calls));
    await act(async () => { await Promise.resolve(); });
  };

  // Scheduled: the patch shows the chip, and the refresh it causes keeps it.
  const first = pending(31_000);
  ownerThread = { ...baseThread, prAutoDispatchPending: first, prAutoDispatchActive: true };
  act(() => emit(first));
  expect(result.current.indicators).toEqual({ [threadKey]: "scheduled" });
  await refreshed();
  expect(result.current.indicators).toEqual({ [threadKey]: "scheduled" });

  // The countdown elapses and the coordinator claims the repair for
  // dispatch; a refresh lands before the busy thread refunds it.
  ownerThread = { ...baseThread, prAutoDispatchActive: true };
  act(() => touch());
  await refreshed();
  await waitFor(() => expect(result.current.threads[0]?.prAutoDispatchPending).toBeUndefined());
  expect(result.current.indicators).toEqual({ [threadKey]: "scheduled" });
  // The selected row offers no Send now or Cancel for a repair being tried.
  act(() => result.current.selectThread(result.current.threads[0]!));
  await waitFor(() => expect(result.current.selectedThread?.id).toBe(baseThread.id));
  expect(result.current.selectedThread?.prAutoDispatchPending).toBeUndefined();

  // Busy: refunded and rescheduled 30 seconds later.
  const retry = pending(61_000);
  ownerThread = { ...baseThread, prAutoDispatchPending: retry, prAutoDispatchActive: true };
  act(() => emit(retry));
  expect(result.current.indicators).toEqual({ [threadKey]: "scheduled" });
  await refreshed();
  expect(result.current.indicators).toEqual({ [threadKey]: "scheduled" });
  expect(result.current.selectedThread?.prAutoDispatchPending).toEqual(retry);

  // Started: the repair is a turn now, and the chip goes.
  ownerThread = baseThread;
  act(() => emit(null));
  expect(result.current.indicators).toEqual({});
  await refreshed();
  expect(result.current.indicators).toEqual({});
});
