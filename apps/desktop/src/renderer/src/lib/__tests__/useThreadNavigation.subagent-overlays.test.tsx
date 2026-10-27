import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent, FederationRemoteTarget, NavigationThreadSummary, ThreadSubAgentSummary } from "@pwragent/shared";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import type { DesktopApi } from "../desktop-api";
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

function fixture() {
  const local: NavigationThreadSummary = {
    id: "shared-thread", source: "codex", title: "Local fixture", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: true }, subAgents: [],
  };
  const threads = [local, ...[studio, tower].map((target): NavigationThreadSummary => ({
    ...local, title: target.instanceId,
    federation: { instanceLabel: target.instanceId, ref: { backend: "codex", threadId: local.id, target } },
  }))];
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
    api, read,
    holdPages: () => { holdPages = true; },
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
