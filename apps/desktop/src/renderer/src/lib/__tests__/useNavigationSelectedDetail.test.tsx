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
