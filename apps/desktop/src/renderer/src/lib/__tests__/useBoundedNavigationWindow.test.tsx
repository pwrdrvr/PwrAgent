import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import type { AgentEvent, NavigationDirectoryRow, NavigationQueryPage } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useBoundedNavigationWindow } from "../useBoundedNavigationWindow";

const directory: NavigationDirectoryRow = { key: "directory:off-page", kind: "directory", label: "Project",
  counts: { total: 1000, active: 20, unread: 30, review: 10 }, pinnedRootCount: 4, unpinnedRootCount: 996, launchpadPresent: false };
const base = { browseMode: "directories" as const, attentionView: { id: "window", promoteOnTurnEnd: true },
  expandedByKey: {}, unpinnedExpandedByKey: {}, enabled: true, visible: true };
function page(patch: Partial<NavigationQueryPage> = {}): NavigationQueryPage {
  return { protocol: 2, queryKey: "query", generation: "g", ownerEpoch: "owner", countsRevision: "r",
    counts: { total: 1000, active: 20, unread: 30, review: 10 }, coverage: { state: "complete" }, entries: [], complete: true, ...patch };
}
function api() {
  let listener: ((event: AgentEvent) => void) | undefined;
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => page({
    directories: request.query.kind === "directory-index" ? request.query.keys ? [directory] : [] : undefined,
  }));
  const release = vi.fn(async () => undefined);
  return { read, release, emit: (event: AgentEvent) => act(() => listener?.(event)),
    desktopApi: { getNavigationQueryPage: read, releaseNavigationQuery: release,
      onAgentEvent: (callback: (event: AgentEvent) => void) => { listener = callback; return () => { listener = undefined; }; },
    } satisfies DesktopApi };
}

it("resolves selected off-page descriptors exactly without repeatedly dropping their demand", async () => {
  const fixture = api();
  const { result, unmount } = renderHook(() => useBoundedNavigationWindow({ ...base, desktopApi: fixture.desktopApi,
    selectedDirectoryKeys: [directory.key],
  }));
  await waitFor(() => expect(result.current.resources.get(`directory:${directory.key}`)?.loading).toBe(false));
  expect(result.current.directories).toEqual([directory]);
  expect(fixture.read.mock.calls.map(([request]) => request.query)).toEqual([
    { kind: "directory-index" }, { kind: "directory-index", keys: [directory.key] },
    { kind: "directory", directoryKey: directory.key, roots: "all" },
  ]);
  expect(result.current.resources.has("selected-directories")).toBe(true);
  unmount();
  expect(fixture.release).toHaveBeenCalledTimes(3);
});

it("does not fetch hidden demand, survives StrictMode restart, and retains pages when hidden", async () => {
  const fixture = api();
  const { result, rerender, unmount } = renderHook(({ visible }) => useBoundedNavigationWindow({ ...base,
    desktopApi: fixture.desktopApi, visible,
  }), { initialProps: { visible: false }, wrapper: StrictMode });
  await act(async () => undefined);
  expect(fixture.read).not.toHaveBeenCalled();
  rerender({ visible: true });
  await waitFor(() => expect(result.current.resources.get("directory-index")?.state.page).toBeDefined());
  expect(fixture.read).toHaveBeenCalledTimes(1);
  rerender({ visible: false });
  expect(result.current.resources.get("directory-index")?.state.page?.counts.total).toBe(1000);
  await act(() => result.current.refresh());
  expect(fixture.read).toHaveBeenCalledTimes(1);
  unmount();
});

it("deduplicates connected events and refreshes only the affected owner after a reconnect", async () => {
  const fixture = api();
  const { result, unmount } = renderHook(() => useBoundedNavigationWindow({ ...base, desktopApi: fixture.desktopApi,
    target: { scope: "remote", instanceId: "owner" },
  }));
  await waitFor(() => expect(result.current.resources.get("directory-index")?.loading).toBe(false));
  const peer = (instanceId: string, status: "connected" | "disconnected") => ({ backend: "codex" as const,
    notification: { method: "federation/peerStatus/changed" as const, params: { instanceId, status } },
  }) as AgentEvent;
  fixture.emit(peer("other", "disconnected"));
  fixture.emit(peer("owner", "connected"));
  fixture.emit(peer("owner", "connected"));
  expect(fixture.read).toHaveBeenCalledTimes(1);
  fixture.emit(peer("owner", "disconnected"));
  expect(result.current.connected).toBe(false);
  fixture.emit(peer("owner", "connected"));
  fixture.emit(peer("owner", "connected"));
  await waitFor(() => expect(fixture.read).toHaveBeenCalledTimes(2));
  expect(result.current.connected).toBe(true);
  unmount();
});

it("coalesces canonical owner row changes and ignores stream events and another owner", async () => {
  const fixture = api();
  const { result, unmount } = renderHook(() => useBoundedNavigationWindow({ ...base, desktopApi: fixture.desktopApi }));
  await waitFor(() => expect(result.current.resources.get("directory-index")?.loading).toBe(false));
  for (const method of ["thread/pullRequests/updated", "navigation/threadDirectories/updated", "thread/pin/added"]) {
    fixture.emit({ backend: "codex", notification: { method, params: { threadId: "off-page" } } } as AgentEvent);
  }
  fixture.emit({ backend: "codex", federationTarget: { scope: "remote", instanceId: "other" },
    notification: { method: "thread/status/changed", params: { threadId: "off-page", status: { type: "active" } } },
  } as AgentEvent);
  fixture.emit({ backend: "codex", notification: { method: "item/agentMessage/delta", params: {} } } as AgentEvent);
  expect(result.current.resources.get("directory-index")?.state.stale).toBe(true);
  await waitFor(() => expect(fixture.read).toHaveBeenCalledTimes(2));
  expect(fixture.read.mock.calls[1]?.[0].completeBaselineRevision).toBeUndefined();
  unmount();
});
