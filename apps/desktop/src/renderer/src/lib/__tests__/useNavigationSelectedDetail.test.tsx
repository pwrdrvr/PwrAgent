import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AgentEvent, NavigationSelectedDetailResponse } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useNavigationSelectedDetail } from "../useNavigationSelectedDetail";

const ref = { backend: "codex" as const, threadId: "selected" };
function detail(revision: string, active = false): NavigationSelectedDetailResponse {
  return { protocol: 2, ref, revision, readiness: "ready", identity: "present", thread: {
    source: "codex", id: ref.threadId, title: "Selected", titleSource: "explicit", linkedDirectories: [],
    inbox: { inInbox: true }, threadStatus: active ? "active" : "idle",
  } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("fences a late selected-detail response at canonical event admission", async () => {
  const old = deferred<NavigationSelectedDetailResponse>();
  const fresh = deferred<NavigationSelectedDetailResponse>();
  let listener: ((event: AgentEvent) => void) | undefined;
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>()
    .mockResolvedValueOnce(detail("initial")).mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise);
  const api: DesktopApi = { getNavigationSelectedDetail: read, onAgentEvent: (callback) => { listener = callback; return () => undefined; } };
  const { result, unmount } = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref }));
  await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
  let pending!: Promise<void>;
  act(() => { pending = result.current.refresh(); });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  act(() => listener!({ backend: "codex", notification: { method: "thread/status/changed", params: { threadId: ref.threadId, status: { type: "active" } } } }));
  expect(result.current.state?.detail?.thread?.threadStatus).toBe("active");
  expect(result.current.state?.readiness).toBe("loading");
  await act(async () => { old.resolve(detail("late-idle")); await pending; });
  expect(result.current.state?.detail?.thread?.threadStatus).toBe("active");
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(read.mock.calls[2]?.[0].knownRevision).toBeUndefined();
  await act(async () => { fresh.resolve(detail("canonical", true)); });
  await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
  expect(result.current.state?.detail?.revision).toBe("canonical");
  unmount();
});

it("does not invalidate a same-id selection for another owner's event", async () => {
  let listener: ((event: AgentEvent) => void) | undefined;
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>().mockResolvedValue(detail("local"));
  const api: DesktopApi = { getNavigationSelectedDetail: read, onAgentEvent: (callback) => { listener = callback; return () => undefined; } };
  const { result, unmount } = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref }));
  await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
  act(() => listener!({ backend: "codex", federationTarget: { scope: "remote", instanceId: "peer" },
    notification: { method: "thread/status/changed", params: { threadId: ref.threadId, status: { type: "active" } } } }));
  expect(result.current.state?.readiness).toBe("ready");
  expect(result.current.state?.detail?.thread?.threadStatus).toBe("idle");
  expect(read).toHaveBeenCalledTimes(1);
  unmount();
});


it("disables remote actions on disconnect and coalesces duplicate reconnect notifications", async () => {
  let listener: ((event: AgentEvent) => void) | undefined;
  const target = { scope: "remote" as const, instanceId: "peer" };
  const remoteRef = { ...ref, ownerInstanceId: "peer" };
  const remoteDetail = { ...detail("remote"), ref: remoteRef, thread: { ...detail("remote").thread!,
    federation: { ref: { backend: ref.backend, threadId: ref.threadId, target }, instanceLabel: "Peer", peerStatus: "connected" as const } } };
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>().mockResolvedValue(remoteDetail);
  const api: DesktopApi = { getNavigationSelectedDetail: read, onAgentEvent: (callback) => { listener = callback; return () => undefined; } };
  const { result, unmount } = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref: remoteRef, federationTarget: target }));
  await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
  const notify = (status: "connected" | "disconnected") => listener!({ backend: "codex", federationTarget: target,
    notification: { method: "federation/peerStatus/changed", params: { instanceId: "peer", status } } });
  act(() => notify("disconnected"));
  expect(result.current.state?.readiness).toBe("failed");
  expect(result.current.state?.detail?.thread?.federation?.peerStatus).toBe("disconnected");
  await act(() => result.current.refresh());
  expect(read).toHaveBeenCalledTimes(1);
  act(() => { notify("connected"); notify("connected"); });
  expect(result.current.state?.readiness).toBe("loading");
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
  expect(read.mock.calls[1]?.[0].knownRevision).toBeUndefined();
  unmount();
});

it("does not read hidden detail and revalidates when the window becomes visible", async () => {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>().mockResolvedValue(detail("visible"));
  const api: DesktopApi = { getNavigationSelectedDetail: read };
  const { result, rerender, unmount } = renderHook(({ enabled }) => useNavigationSelectedDetail({ desktopApi: api, ref, enabled }),
    { initialProps: { enabled: false } });
  expect(read).not.toHaveBeenCalled();
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
  rerender({ enabled: false });
  expect(result.current.state?.readiness).toBe("loading");
  await act(() => result.current.refresh());
  expect(read).toHaveBeenCalledTimes(1);
  rerender({ enabled: true });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read.mock.calls[1]?.[0].knownRevision).toBeUndefined();
  unmount();
});

it("applies working-directory events to exact detail and fences an older read", async () => {
  let listener: ((event: AgentEvent) => void) | undefined;
  const initial = detail("initial");
  initial.thread!.projectKey = "/repo";
  initial.thread!.linkedDirectories = [{ id: "directory:/repo", kind: "local", label: "repo", path: "/repo" }];
  const old = deferred<NavigationSelectedDetailResponse>();
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>()
    .mockResolvedValueOnce(initial).mockReturnValue(old.promise);
  const api: DesktopApi = { getNavigationSelectedDetail: read, onAgentEvent: (callback) => { listener = callback; return () => undefined; } };
  const { result, unmount } = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref }));
  await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
  let pending!: Promise<void>;
  act(() => { pending = result.current.refresh(); });
  const notify = (worktreePath: string, fetchedAt: number, owner?: string) => listener!({ backend: "codex",
    ...(owner ? { federationTarget: { scope: "remote" as const, instanceId: owner } } : {}),
    notification: { method: "navigation/threadGitWorkingState/updated", params: {
      worktreePath, fetchedAt, gitWorkingState: { dirtyFiles: 3, dirtyAdditions: 12, dirtyDeletions: 4, untrackedFiles: 1, unpushedCommits: 2 },
    } } });
  act(() => { notify("/unrelated", 10); notify("/repo", 10, "peer"); });
  expect(result.current.state?.detail?.thread?.gitWorkingState).toBeUndefined();
  act(() => notify("/repo", 20));
  expect(result.current.state?.detail?.thread?.gitWorkingState?.dirtyFiles).toBe(3);
  expect(result.current.state?.detail?.thread?.gitWorkingStateFetchedAt).toBe(20);
  act(() => notify("/repo", 10));
  expect(result.current.state?.detail?.thread?.gitWorkingStateFetchedAt).toBe(20);
  await act(async () => { old.resolve(initial); await pending; });
  expect(result.current.state?.detail?.thread?.gitWorkingStateFetchedAt).toBe(20);
  expect(result.current.state?.readiness).toBe("loading");
  unmount();
});

it("invalidates exact configuration at binding-change admission without requiring a row event", async () => {
  const old = deferred<NavigationSelectedDetailResponse>();
  let changed!: () => void;
  const unsubscribe = vi.fn();
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>()
    .mockResolvedValueOnce(detail("initial")).mockReturnValueOnce(old.promise).mockResolvedValue(detail("bindings-current"));
  const api: DesktopApi = { getNavigationSelectedDetail: read,
    onMessagingBindingsChanged: (callback) => { changed = () => callback({ at: 1 }); return unsubscribe; } };
  const { result, unmount } = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref }));
  await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
  let pending!: Promise<void>;
  act(() => { pending = result.current.refresh(); });
  act(() => { changed(); changed(); });
  expect(result.current.state?.readiness).toBe("loading");
  await act(async () => { old.resolve(detail("obsolete-bindings")); await pending; });
  expect(result.current.state?.detail?.revision).toBe("initial");
  await waitFor(() => expect(result.current.state?.detail?.revision).toBe("bindings-current"));
  expect(read).toHaveBeenCalledTimes(3);
  expect(read.mock.calls[2]?.[0].knownRevision).toBeUndefined();
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
