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
