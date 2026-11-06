import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { federatedThreadIdentityKey, type AgentEvent, type NavigationRow } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";

function fixture() {
  const listeners = new Set<(event: AgentEvent) => void>();
  const archived = new Set<string>();
  const row = (id: string): NavigationRow => ({
    id, source: "codex", title: id, titleSource: "explicit", ref: { backend: "codex", threadId: id },
    rowRevision: "r", linkedDirectories: [], inbox: { inInbox: true }, ordinaryChildCount: 0,
    nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown",
  });
  const archive = vi.fn<NonNullable<DesktopApi["archiveThread"]>>(async ({ threadId }) => {
    archived.add(threadId);
    return { backend: "codex", threadId, archivedAt: 1, cleanup: [] };
  });
  const api: DesktopApi = {
    archiveThread: archive,
    restoreThread: async ({ threadId }) => { archived.delete(threadId); return { backend: "codex", threadId, restoredAt: 2 }; },
    getNavigationQueryPage: async ({ query }) => {
      const pinned = query.kind === "lens" && query.roots === "pinned";
      const rows = query.kind === "lens" && !pinned ? ["c", "a", "b"].filter((id) => !archived.has(id)).map(row)
        : query.kind === "exact" ? query.identities.filter((ref) => !archived.has(ref.threadId)).map((ref) => row(ref.threadId)) : [];
      return { protocol: 2, queryKey: JSON.stringify(query), generation: "g", ownerEpoch: "owner", countsRevision: "r",
        coverage: { state: "complete" }, counts: { total: 3 - archived.size, active: 0, unread: 3 - archived.size, review: 0 },
        entries: rows.map((row) => ({ row, placement: { kind: "root" }, orderKey: row.id })), directories: [], complete: true };
    },
    getNavigationSelectedDetail: async ({ ref }) => ({ protocol: 2, ref, revision: "r", readiness: "ready",
      identity: archived.has(ref.threadId) ? "archived" : "present", thread: archived.has(ref.threadId) ? undefined : row(ref.threadId) }),
    releaseNavigationQuery: async () => undefined,
    onAgentEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { api, archive, emit: (event: AgentEvent) => { for (const listener of listeners) listener(event); } };
}

beforeEach(() => vi.spyOn(document, "hasFocus").mockReturnValue(true));
afterEach(() => vi.restoreAllMocks());

it("publishes optimistic archive identities with the fallback and lifts them on response-only Undo", async () => {
  const f = fixture();
  const { result } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  await act(async () => { await result.current.showThread({ backend: "codex", threadId: "b" }); });
  await waitFor(() => expect(result.current.selectedThread?.id).toBe("b"));
  const b = result.current.selectedThread!;
  const archive = f.archive.getMockImplementation()!;
  let complete!: () => void;
  f.archive.mockImplementation(async (request) => { await new Promise<void>((resolve) => { complete = resolve; }); return archive(request); });
  let pending!: ReturnType<typeof result.current.archiveThread>;
  act(() => { pending = result.current.archiveThread(b); });
  await waitFor(() => expect(result.current.archivedThreadKeys.has("codex:b")).toBe(true));
  expect(result.current.selectedThreadKey).toBe("codex:c");
  await act(async () => { complete(); await pending; });
  await act(async () => { await result.current.restoreArchivedThreads([{ backend: "codex", threadId: "b", remote: false }], "codex:b"); });
  expect(result.current.archivedThreadKeys.has("codex:b")).toBe(false);
  await waitFor(() => expect(result.current.selectedThread?.id).toBe("b"));
});

it("lifts the archive exclusion when the request fails", async () => {
  const f = fixture();
  f.archive.mockRejectedValue(new Error("Synthetic archive failure"));
  const { result } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  await act(async () => { await result.current.showThread({ backend: "codex", threadId: "b" }); });
  await waitFor(() => expect(result.current.selectedThread?.id).toBe("b"));
  await act(async () => { await result.current.archiveThread(result.current.selectedThread!); });
  expect(result.current.archivedThreadKeys.has("codex:b")).toBe(false);
  await waitFor(() => expect(result.current.selectedThread?.id).toBe("b"));
});

it("shows active cleanup before completion, respects dismissal for the batch, and clears on drain", async () => {
  const f = fixture();
  const { result } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  const progress = (batchId: string, drained = false): AgentEvent => ({ backend: "codex", notification: {
    method: "archiveCleanup/progress",
    params: { batchId, active: drained ? [] : [{ backend: "codex", threadId: "a", worktreePath: "/contrived/checkout" }],
      queued: drained ? 0 : 2, completed: drained ? 3 : 0, total: 3 },
  } });
  act(() => f.emit(progress("first")));
  expect(result.current.archiveCleanupProgressNotice?.message).toContain("1 active");
  expect(result.current.archiveCleanupProgressNotice?.facts?.[0]?.value).toBe("/contrived/checkout");
  act(() => result.current.dismissArchiveCleanupProgressNotice());
  act(() => f.emit(progress("first")));
  expect(result.current.archiveCleanupProgressNotice).toBeUndefined();
  act(() => f.emit(progress("second")));
  expect(result.current.archiveCleanupProgressNotice).toBeDefined();
  act(() => f.emit(progress("second", true)));
  expect(result.current.archiveCleanupProgressNotice).toBeUndefined();
});

it("keeps archive and unarchive events scoped to the full backend and instance identity", async () => {
  const f = fixture();
  const { result } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  const target = { scope: "remote" as const, instanceId: "fixture-peer" };
  const peerKey = federatedThreadIdentityKey({ backend: "codex", threadId: "b", target });
  act(() => {
    f.emit({ backend: "codex", notification: { method: "thread/archived", params: { threadId: "b" } } });
    f.emit({ backend: "claude", notification: { method: "thread/archived", params: { threadId: "b" } } });
    f.emit({ backend: "codex", federationTarget: target, notification: { method: "thread/archived", params: { threadId: "b" } } });
  });
  expect(result.current.archivedThreadKeys).toEqual(new Set(["codex:b", "claude:b", peerKey]));
  act(() => f.emit({ backend: "codex", federationTarget: target, notification: { method: "thread/unarchived", params: { threadId: "b" } } }));
  expect(result.current.archivedThreadKeys).toEqual(new Set(["codex:b", "claude:b"]));
});
