import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { NavigationIdentity, NavigationQueryPage, NavigationRow } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useBoundedNavigationWindow } from "../useBoundedNavigationWindow";

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
