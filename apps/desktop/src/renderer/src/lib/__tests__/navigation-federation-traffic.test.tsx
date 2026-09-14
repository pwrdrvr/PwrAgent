import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AgentEvent, NavigationIdentity, NavigationQueryPage, NavigationRow } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useBoundedNavigationWindow } from "../useBoundedNavigationWindow";
import { useThreadNavigation } from "../useThreadNavigation";

// Measures uncompressed query request/response JSON at the desktop API boundary.
// Excludes transport envelopes, TLS, selected configuration, and history pages.
// Cold includes incremental 10-row sidebar pages and existing owner-batch rebuilds.
// Selection includes its one-time batch replacement; refresh must have no overlap.
// Full responses deliberately bound the changed-data case; unchanged responses
// can be smaller. Keep identities and revisions deterministic for byte budgets.
it.each([1, 10, 101])("budgets federation navigation traffic for %s visible mounts", async (count) => {
  const rows: NavigationRow[] = Array.from({ length: count }, (_, index) => ({
    ref: { backend: "codex", threadId: `thread-${index}`, ownerInstanceId: "peer" },
    id: `thread-${index}`, source: "codex", title: `Thread ${index}`, titleSource: "explicit", rowRevision: "r",
    linkedDirectories: [], inbox: { inInbox: false }, ordinaryChildCount: 0,
    nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown",
    prs: [884, 874, 1722].map((number) => ({ number, provider: "github", org: "fixture", repo: "project",
      title: `PR ${number}`, url: `https://github.com/fixture/project/pull/${number}`, state: "merged" })),
  }));
  let samples: { requestBytes: number; responseBytes: number; ids: string[] }[] = [];
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
    const query = request.query;
    const selected = query.kind === "directory-index" ? [] : query.kind === "exact"
      ? rows.filter((row) => query.identities.some((ref) => ref.threadId === row.id)) : rows;
    const offset = Number(request.cursor ?? 0);
    const end = offset + (request.pageSize ?? 100);
    const response: NavigationQueryPage = {
      protocol: 2, queryKey: "q", generation: "g", ownerEpoch: "o", countsRevision: "c",
      counts: { total: count, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" }, complete: end >= selected.length,
      ...(end < selected.length ? { nextCursor: String(end) } : {}),
      entries: selected.slice(offset, end).map((row) => ({ row, placement: { kind: "root" }, orderKey: row.id })),
    };
    if (request.federationTarget?.scope === "remote") samples.push({
      requestBytes: new TextEncoder().encode(JSON.stringify(request)).byteLength,
      responseBytes: new TextEncoder().encode(JSON.stringify(response)).byteLength,
      ids: response.entries.map(({ row }) => row.id),
    });
    return response;
  });
  const desktopApi = { getNavigationQueryPage: read };
  const { result, rerender, unmount } = renderHook(({ selectedRef }: { selectedRef?: NavigationIdentity }) =>
    useBoundedNavigationWindow({ desktopApi, browseMode: "inbox", attentionView: { id: "traffic", promoteOnTurnEnd: true },
      expandedByKey: {}, unpinnedExpandedByKey: {}, enabled: true, visible: true, selectedRef,
    }), { initialProps: {} });
  const settled = async () => {
    await waitFor(() => {
      expect([...result.current.resources.values()].every((resource) => resource.state.page && !resource.loading)).toBe(true);
      expect(samples.length).toBeGreaterThan(0);
    });
    await act(async () => {});
  };
  const measure = () => ({
    requests: samples.length,
    requestBytes: samples.reduce((total, sample) => total + sample.requestBytes, 0),
    responseBytes: samples.reduce((total, sample) => total + sample.responseBytes, 0),
    rows: samples.flatMap((sample) => sample.ids).length,
    duplicates: samples.flatMap((sample) => sample.ids).length - new Set(samples.flatMap((sample) => sample.ids)).size,
  });
  await settled();
  while (result.current.resources.get("lens")?.state.page?.nextCursor) {
    await act(() => result.current.loadMore("lens"));
    await settled();
  }
  const cold = measure();
  samples = [];
  rerender({ selectedRef: rows[0]!.ref });
  await settled();
  const selection = measure();
  samples = [];
  await act(() => result.current.refresh());
  const refresh = measure();
  samples = [];
  await act(() => result.current.refresh());
  expect(measure()).toEqual(refresh);
  // A rerender with identical demand must never initiate another owner read.
  samples = [];
  rerender({ selectedRef: { ...rows[0]!.ref } });
  await act(async () => {});
  expect(samples).toEqual([]);
  unmount();
  expect(refresh.duplicates).toBe(0);
  // Exact counts catch repeated requests even if small payloads fit a byte cap.
  // Snapshots make every change to the traffic budget reviewable.
  expect({ cold, selection, refresh }).toMatchSnapshot();
});

function useSidebarTraffic(api: DesktopApi) {
  return useThreadNavigation(api).pagedNavigation;
}
function useWindowTraffic(api: DesktopApi) {
  return useBoundedNavigationWindow({ desktopApi: api, browseMode: "inbox",
    attentionView: { id: "events", promoteOnTurnEnd: true }, expandedByKey: {}, unpinnedExpandedByKey: {},
    enabled: true, visible: true });
}

it.each([["main sidebar", useSidebarTraffic], ["bounded window", useWindowTraffic]] as const)("isolates event-driven owner reads in %s", async (_name, useWindow) => {
  const listeners = new Set<(event: AgentEvent) => void>();
  const rows: NavigationRow[] = [undefined, "peer-a", "peer-b"].map((ownerInstanceId, index) => ({
    ref: { backend: "codex", threadId: `thread-${index}`, ownerInstanceId },
    id: `thread-${index}`, source: "codex", title: `Thread ${index}`, titleSource: "explicit", rowRevision: "r",
    linkedDirectories: [], inbox: { inInbox: true }, ordinaryChildCount: 0,
    nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown",
  }));
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
    const query = request.query;
    const selected = query.kind === "directory-index" ? [] : query.kind === "exact"
      ? rows.filter((row) => query.identities.some((ref) => ref.threadId === row.id)) : rows;
    return { protocol: 2, queryKey: JSON.stringify(query), generation: "g", ownerEpoch: "o", countsRevision: "c",
      counts: { total: 3, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" }, complete: true,
      entries: selected.map((row) => ({ row: { ...row }, placement: { kind: "root" }, orderKey: row.id })),
    };
  });
  const api: DesktopApi = { getNavigationQueryPage: read,
    getNavigationSelectedDetail: async (request) => ({ protocol: 2, ref: request.ref, revision: "detail",
      readiness: "ready", identity: "present", thread: rows.find((row) => row.id === request.ref.threadId)! }),
    onAgentEvent: (callback) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
  };
  const { result, unmount } = renderHook(() => useWindow(api));
  try {
    await waitFor(() => {
      expect(result.current.resources.has('visible-owner:"peer-a":0')).toBe(true);
      expect(result.current.resources.has('visible-owner:"peer-b":0')).toBe(true);
      expect([...result.current.resources.values()].every((resource) => resource.state.page && !resource.loading)).toBe(true);
    });
    await act(async () => {});
    vi.useFakeTimers();
    const emit = async (ownerInstanceId?: string) => {
      await act(async () => {
        for (const listener of listeners) listener({ backend: "codex",
          federationTarget: ownerInstanceId ? { scope: "remote", instanceId: ownerInstanceId } : undefined,
          notification: ownerInstanceId
            ? { method: "navigation/invalidated", params: { sourceMethod: "thread/status/changed", threadId: "thread-1" } }
            : { method: "thread/status/changed", params: { threadId: "thread-0", status: { type: "active" } } },
        });
        await vi.advanceTimersByTimeAsync(500);
      });
    };
    const remoteCalls = () => read.mock.calls.filter(([request]) => request.federationTarget?.scope === "remote");
    read.mockClear();
    rows[0]!.title = "Local changed";
    await emit();
    expect(read).toHaveBeenCalled();
    expect(remoteCalls()).toEqual([]);
    expect(result.current.resources.get("lens")?.state.page?.entries[0]?.row.title).toBe("Local changed");

    read.mockClear();
    rows[1]!.title = "Peer A changed";
    await emit("peer-a");
    expect(remoteCalls().map(([request]) => request.federationTarget)).toEqual([{ scope: "remote", instanceId: "peer-a" }]);
    expect(result.current.resources.get('visible-owner:"peer-a":0')?.state.page?.entries[0]?.row.title).toBe("Peer A changed");

    // A replacement stream must repair a missed owner invalidation even if
    // that owner is now idle and emits no further navigation events.
    read.mockClear();
    rows[1]!.title = "Peer A recovered";
    await act(async () => {
      for (const listener of listeners) listener({ backend: "codex",
        federationTarget: { scope: "remote", instanceId: "peer-a" },
        notification: { method: "federation/eventStream/changed", params: { instanceId: "peer-a", epoch: "recovered" } },
      });
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(remoteCalls().map(([request]) => request.federationTarget)).toEqual([{ scope: "remote", instanceId: "peer-a" }]);
    expect(result.current.resources.get('visible-owner:"peer-a":0')?.state.page?.entries[0]?.row.title).toBe("Peer A recovered");

    // Coalescing must retain both origins instead of letting the last event win.
    read.mockClear();
    await act(async () => {
      for (const ownerInstanceId of ["peer-a", "peer-b"]) for (const listener of listeners) listener({ backend: "codex",
        federationTarget: { scope: "remote", instanceId: ownerInstanceId },
        notification: { method: "navigation/invalidated", params: { sourceMethod: "thread/status/changed" } },
      });
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(remoteCalls().map(([request]) => request.federationTarget?.scope === "remote" && request.federationTarget.instanceId).sort())
      .toEqual(["peer-a", "peer-b"]);

    // Explicit refresh still revalidates all displayed owners.
    read.mockClear();
    await act(() => result.current.refresh());
    expect(remoteCalls()).toHaveLength(2);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});
