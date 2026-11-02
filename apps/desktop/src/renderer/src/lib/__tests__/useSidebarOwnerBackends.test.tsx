import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, BackendSummary, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../useBackendSummaries";
import { useSidebarOwnerBackends } from "../useSidebarOwnerBackends";

const backend: BackendSummary = {
  kind: "acp:grok", label: "Grok", available: true, methods: [], executionModes: [],
  capabilities: {
    listThreads: true, createThread: true, resumeThread: true, readThread: true,
    renameThread: true, archiveThread: true, forkThread: true, startTurn: true,
    interruptTurn: true, steerTurn: false, transcriptPagination: false,
    toolUse: true, approvalRequests: false, multiDirectoryThreads: false,
  },
};
function row(owner: string, status: "connected" | "disconnected" = "connected"): NavigationThreadSummary {
  return {
    id: `thread-${owner}`, source: "acp:grok", title: owner, titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: true },
    federation: {
      ref: { backend: "acp:grok", threadId: `thread-${owner}`, target: { scope: "remote", instanceId: owner } },
      instanceLabel: owner, peerStatus: status, capabilities: ["thread_navigation", "turn_control"],
    },
  };
}
function deferredCatalog() {
  let resolve!: (value: { fetchedAt: number; backends: BackendSummary[] }) => void;
  const promise = new Promise<{ fetchedAt: number; backends: BackendSummary[] }>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(cleanup);

describe("useSidebarOwnerBackends", () => {
  it("reads each reachable foreign owner once using only listBackends protocol data", async () => {
    const listBackends = vi.fn<NonNullable<DesktopApi["listBackends"]>>()
      .mockResolvedValue({ fetchedAt: 1, backends: [backend] });
    const api = { listBackends };
    const local = { ...row("local"), federation: undefined };
    const noControl = { ...row("no-control"), federation: { ...row("no-control").federation!, capabilities: [] } };
    const threads = [local, row("window"), row("a"), row("a"), row("b"), row("offline", "disconnected"), noControl];
    const { result, rerender } = renderHook(({ rows, enabled }) => useSidebarOwnerBackends(api, rows, {
      enabled, windowInstanceId: "window",
    }), { initialProps: { rows: threads, enabled: true } });
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(listBackends.mock.calls.map(([request]) => request)).toEqual([
      { includeUnavailable: true, federationTarget: { scope: "remote", instanceId: "a" } },
      { includeUnavailable: true, federationTarget: { scope: "remote", instanceId: "b" } },
    ]);
    rerender({ rows: [...threads].reverse(), enabled: true });
    expect(listBackends).toHaveBeenCalledTimes(2);
    rerender({ rows: threads, enabled: false });
    expect(result.current.size).toBe(0);
  });

  it("discards an in-flight catalog on disconnect and reads again on reconnect", async () => {
    const stale = deferredCatalog();
    const fresh = deferredCatalog();
    const listBackends = vi.fn<NonNullable<DesktopApi["listBackends"]>>()
      .mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const api = { listBackends };
    const { result, rerender } = renderHook(({ connected }) => useSidebarOwnerBackends(api,
      [row("owner", connected ? "connected" : "disconnected")], { enabled: true }),
    { initialProps: { connected: true } });
    rerender({ connected: false });
    expect(result.current.size).toBe(0);
    rerender({ connected: true });
    await act(async () => { fresh.resolve({ fetchedAt: 2, backends: [backend] }); });
    expect(result.current.get("owner")).toEqual([backend]);
    await act(async () => { stale.resolve({ fetchedAt: 1, backends: [] }); });
    expect(result.current.get("owner")).toEqual([backend]);
    expect(listBackends).toHaveBeenCalledTimes(2);
  });

  it("keeps failed reads empty and refreshes on focus, provider events and explicit refresh", async () => {
    const listBackends = vi.fn<NonNullable<DesktopApi["listBackends"]>>()
      .mockRejectedValueOnce(new Error("Owner unavailable"))
      .mockResolvedValue({ fetchedAt: 2, backends: [backend] });
    let focus: (() => void) | undefined;
    let event: ((value: AgentEvent) => void) | undefined;
    const stopFocus = vi.fn();
    const stopEvents = vi.fn();
    const api: DesktopApi = {
      listBackends,
      onWindowFocus: (listener) => { focus = listener; return stopFocus; },
      onAgentEvent: (listener) => { event = listener; return stopEvents; },
    };
    const { result, unmount } = renderHook(() => useSidebarOwnerBackends(api, [row("owner")], { enabled: true }));
    await waitFor(() => expect(result.current.get("owner")).toEqual([]));
    await act(async () => { focus?.(); });
    expect(result.current.get("owner")).toEqual([backend]);
    const notification: AgentEvent = { backend: "acp:grok", notification: {
      method: "backend/providerStatus/updated", params: { backend: "acp:grok" },
    } };
    await act(async () => { event?.({ ...notification, federationTarget: { scope: "remote", instanceId: "other" } }); });
    expect(listBackends).toHaveBeenCalledTimes(2);
    await act(async () => { event?.({ ...notification, federationTarget: { scope: "remote", instanceId: "owner" } }); });
    expect(listBackends).toHaveBeenCalledTimes(3);
    await act(async () => { window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT)); });
    expect(listBackends).toHaveBeenCalledTimes(4);
    unmount();
    expect(stopFocus).toHaveBeenCalledOnce();
    expect(stopEvents).toHaveBeenCalledOnce();
  });

  it("keeps the newest provider refresh when earlier responses arrive late", async () => {
    const stale = deferredCatalog();
    const listBackends = vi.fn<NonNullable<DesktopApi["listBackends"]>>()
      .mockReturnValueOnce(stale.promise).mockResolvedValue({ fetchedAt: 2, backends: [] });
    const api = { listBackends };
    const { result } = renderHook(() => useSidebarOwnerBackends(api, [row("owner")], { enabled: true }));
    await act(async () => { window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT)); });
    expect(result.current.get("owner")).toEqual([]);
    await act(async () => { stale.resolve({ fetchedAt: 1, backends: [backend] }); });
    expect(result.current.get("owner")).toEqual([]);
  });
});
