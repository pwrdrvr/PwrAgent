import { createHash, webcrypto } from "node:crypto";
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

it("keeps composer configuration ready while independent history pages load", async () => {
  const collection = deferred<NavigationSelectedDetailResponse>();
  const configured = { ...detail("config"), collections: [{ name: "subAgents" as const, count: 1, revision: "history" }] };
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>()
    .mockResolvedValueOnce(configured).mockReturnValueOnce(collection.promise);
  const release = vi.fn(async () => undefined);
  const api: DesktopApi = { getNavigationSelectedDetail: read, releaseNavigationQuery: release };
  const { result, unmount } = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(result.current.state?.readiness).toBe("ready");
  expect(result.current.state?.collectionReadiness).toBe("loading");
  expect(read.mock.calls[1]?.[1]).not.toBe(read.mock.calls[0]?.[1]);
  await act(async () => collection.resolve({ protocol: 2, ref, identity: "present", readiness: "ready", revision: "history",
    collectionPage: { name: "subAgents", revision: "history", complete: true,
      values: { subAgents: [{ monitorId: "old", task: "Completed task", status: "success", createdAt: 1, updatedAt: 1 }] } } }));
  await waitFor(() => expect(result.current.state?.collectionReadiness).toBe("ready"));
  expect(result.current.state?.detail?.thread?.subAgents?.[0]?.monitorId).toBe("old");
  expect(result.current.state?.readiness).toBe("ready");
  unmount();
});

it("revalidates exact workspace configuration after an owner handoff event", async () => {
  let listener: ((event: AgentEvent) => void) | undefined;
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>()
    .mockResolvedValueOnce({ ...detail("local"), workspaceDirectories: [{ key: "repo", path: "/repo", label: "Repo" }] })
    .mockResolvedValue({ ...detail("worktree"), workspaceDirectories: [{ key: "worktree", path: "/repo/worktree", label: "Repo" }] });
  const api: DesktopApi = { getNavigationSelectedDetail: read, onAgentEvent: (callback) => { listener = callback; return () => undefined; } };
  const { result, unmount } = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref }));
  await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
  expect(read.mock.calls[0]?.[0].includeWorkspaceConfiguration).toBe(true);
  act(() => listener!({ backend: "codex", notification: {
    method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: [ref.threadId] },
  } }));
  expect(result.current.state?.readiness).toBe("loading");
  await waitFor(() => expect(result.current.state?.detail?.revision).toBe("worktree"));
  expect(result.current.state?.detail?.workspaceDirectories?.[0]?.path).toBe("/repo/worktree");
  expect(read.mock.calls[1]?.[0].knownRevision).toBe("local");
  unmount();
});

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
  expect(read.mock.calls[2]?.[0].knownRevision).toBe("initial");
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
  expect(read.mock.calls[1]?.[0].knownRevision).toBe("visible");
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
  expect(read.mock.calls[2]?.[0].knownRevision).toBe("initial");
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("replaces a cancelled exact read after an owner-wide provider invalidation", async () => {
  let listener: ((event: AgentEvent) => void) | undefined;
  let reject!: (error: Error) => void;
  const old = new Promise<NavigationSelectedDetailResponse>((_resolve, failed) => { reject = failed; });
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>()
    .mockReturnValueOnce(old).mockResolvedValue(detail("fresh-owner"));
  const api: DesktopApi = { getNavigationSelectedDetail: read, onAgentEvent: (callback) => { listener = callback; return () => undefined; } };
  const { result, unmount } = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  act(() => listener!({ backend: "codex", notification: { method: "navigation/invalidated", params: {} } } as AgentEvent));
  await act(async () => reject(new Error("Navigation read cancelled")));
  expect(result.current.state?.readiness).toBe("loading");
  await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
  expect(result.current.state?.detail?.revision).toBe("fresh-owner");
  expect(read).toHaveBeenCalledTimes(2);
  unmount();
});


it("retains live Token Miser subagents while the authoritative collection refresh is pending", async () => {
  let listener: ((event: AgentEvent) => void) | undefined;
  const refreshed = deferred<NavigationSelectedDetailResponse>();
  const gate = { monitorId: "system:token-miser:live", parentTurnId: "active-turn", task: "Gate",
    status: "success" as const, createdAt: 1, updatedAt: 2,
    tokenMiserAccounting: { baselineParentCostMicros: 100, baselineParentTokens: 10,
      currency: "USD" as const, gateCostMicros: 1, gateModel: "gpt-5.6-luna", gateTotalTokens: 1,
      originalModel: "gpt-6-astra", revealedParentCostMicros: 10, revealedParentTokens: 1, savingsMicros: 89 } };
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>()
    .mockResolvedValueOnce({ ...detail("initial", true), collections: [{ name: "subAgents", count: 0, revision: "empty" }] })
    .mockResolvedValueOnce({ ...detail("fresh", true), collections: [{ name: "subAgents", count: 1, revision: "live" }] })
    .mockReturnValue(refreshed.promise);
  const api: DesktopApi = { getNavigationSelectedDetail: read,
    onAgentEvent: (callback) => { listener = callback; return () => undefined; } };
  const { result, unmount } = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref }));
  await waitFor(() => expect(result.current.state?.collectionReadiness).toBe("ready"));
  act(() => listener!({ backend: "codex", notification: { method: "thread/subAgents/updated",
    params: { threadId: ref.threadId, subAgents: [gate] } } }));
  expect(result.current.state?.detail?.thread?.subAgents).toEqual([gate]);
  // Dispatch precedes React's commit. Observe the pending collection state,
  // not just the mock call, before checking the retained live subagents.
  await waitFor(() => {
    expect(result.current.state?.collectionReadiness).toBe("loading");
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.current.state?.detail?.thread?.subAgents).toEqual([gate]);
  });
  await act(async () => refreshed.resolve({ ...detail("fresh", true), collectionPage: {
    name: "subAgents", revision: "live", complete: true, values: { subAgents: [gate] },
  } }));
  await waitFor(() => expect(result.current.state?.collectionReadiness).toBe("ready"));
  expect(result.current.state?.detail?.thread?.subAgents).toEqual([gate]);
  unmount();
});


it("revalidates a canonical baseline without trusting event-patched configuration", async () => {
  let listener!: (event: AgentEvent) => void;
  const confirmation = deferred<NavigationSelectedDetailResponse>();
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>()
    .mockResolvedValueOnce(detail("canonical-idle")).mockReturnValueOnce(confirmation.promise);
  const api: DesktopApi = { getNavigationSelectedDetail: read, onAgentEvent: (callback) => { listener = callback; return () => {}; } };
  const { result, unmount } = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref }));
  await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
  act(() => listener({ backend: "codex", notification: { method: "thread/status/changed", params: { threadId: ref.threadId, status: { type: "active" } } } }));
  expect(result.current.state?.readiness).toBe("loading");
  expect(result.current.state?.detail?.thread?.threadStatus).toBe("active");
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read.mock.calls[1]?.[0].knownRevision).toBe("canonical-idle");
  await act(async () => confirmation.resolve({ protocol: 2, ref, revision: "canonical-idle", unchanged: true, identity: "present", readiness: "ready" }));
  await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
  expect(result.current.state?.detail?.thread?.threadStatus).toBe("idle");
  unmount();
});

it("uses a streamed remote collection when it matches the owner's content revision", async () => {
  vi.stubGlobal("crypto", webcrypto);
  let listener!: (event: AgentEvent) => void;
  const target = { scope: "remote" as const, instanceId: "owner" };
  const remoteRef = { ...ref, ownerInstanceId: "owner" };
  const subAgents = [{ monitorId: "monitor", task: "Historical task ".repeat(2000), status: "success" as const, createdAt: 1, updatedAt: 1 }];
  const revision = createHash("sha256").update(JSON.stringify({ ref, name: "subAgents", values: subAgents })).digest("base64url");
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>()
    .mockResolvedValueOnce({ ...detail("initial"), ref: remoteRef })
    .mockResolvedValue({ ...detail("next"), ref: remoteRef, collections: [{ name: "subAgents", count: 1, revision }] });
  const api: DesktopApi = { getNavigationSelectedDetail: read, onAgentEvent: (callback) => { listener = callback; return () => {}; } };
  const { result, unmount } = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref: remoteRef, federationTarget: target }));
  try {
    await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
    act(() => listener({ backend: "codex", federationTarget: target, notification: {
      method: "thread/subAgents/updated", params: { threadId: ref.threadId, subAgents },
    } }));
    await waitFor(() => expect(result.current.state?.collectionReadiness).toBe("ready"));
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.every(([request]) => !request.collection)).toBe(true);
    expect(result.current.state?.detail?.thread?.subAgents).toEqual(subAgents);
  } finally { unmount(); vi.unstubAllGlobals(); }
});

it("retains a completed history page across a configuration invalidation", async () => {
  let listener!: (event: AgentEvent) => void;
  const page = deferred<NavigationSelectedDetailResponse>();
  const configured = { ...detail("config"), collections: [{ name: "subAgents" as const, count: 2, revision: "history" }] };
  const subAgents = [0, 1].map((index) => ({ monitorId: `m-${index}`, task: "Old task", status: "success" as const, createdAt: index, updatedAt: index }));
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>().mockImplementation(async (request) => {
    if (!request.collection) return configured;
    if (!request.collection.cursor) return page.promise;
    return { ...detail("history"), collectionPage: { name: "subAgents", revision: "history", complete: true, values: { subAgents: subAgents.slice(1) } } };
  });
  const api: DesktopApi = { getNavigationSelectedDetail: read, onAgentEvent: (callback) => { listener = callback; return () => {}; } };
  const { result, unmount } = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  act(() => listener({ backend: "codex", notification: { method: "navigation/invalidated", params: { sourceMethod: "provider/threads/updated" } } }));
  await act(async () => page.resolve({ ...detail("history"), collectionPage: { name: "subAgents", revision: "history", complete: false, nextCursor: "page-2", values: { subAgents: subAgents.slice(0, 1) } } }));
  await waitFor(() => expect(result.current.state?.collectionReadiness).toBe("ready"));
  expect(read.mock.calls.filter(([request]) => request.collection)).toHaveLength(2);
  expect(result.current.state?.detail?.thread?.subAgents).toEqual(subAgents);
  unmount();
});

it("does not fetch sub-agent history when the transcript requests only its required collections", async () => {
  let listener!: (event: AgentEvent) => void;
  const activeSubAgents = [{ monitorId: "live", task: "Watch build", status: "running" as const, createdAt: 1, updatedAt: 1 }];
  const configured = { ...detail("config"), thread: { ...detail("config").thread!, activeSubAgents },
    collections: [{ name: "subAgents" as const, count: 10000, revision: "history" }] };
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>().mockResolvedValue(configured);
  const api: DesktopApi = { getNavigationSelectedDetail: read,
    onAgentEvent: (callback) => { listener = callback; return () => {}; } };
  const { result, unmount } = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref, collections: ["turnFailureLog"] }));
  await waitFor(() => expect(result.current.state?.readiness).toBe("ready"));
  expect(read).toHaveBeenCalledTimes(1);
  expect(result.current.state?.detail?.thread?.subAgents).toBeUndefined();
  expect(result.current.state?.detail?.thread?.activeSubAgents).toEqual(activeSubAgents);
  read.mockResolvedValue({ ...configured, revision: "completed", thread: { ...configured.thread, activeSubAgents: [] } });
  act(() => listener({ backend: "codex", notification: { method: "thread/subAgents/updated", params: { threadId: ref.threadId } } }));
  await waitFor(() => expect(result.current.state?.detail?.thread?.activeSubAgents).toEqual([]));
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls.every(([request]) => !request.collection)).toBe(true);
  unmount();
});
