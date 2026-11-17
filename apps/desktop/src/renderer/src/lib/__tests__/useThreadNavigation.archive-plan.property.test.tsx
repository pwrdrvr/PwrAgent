import { act, renderHook, waitFor } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { ArchiveThreadRequest, NavigationThreadSummary } from "@pwragent/shared";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import type { DesktopApi } from "../desktop-api";
import { threadSummaryIdentityKey } from "../federated-thread-events";
import { useThreadNavigation } from "../useThreadNavigation";

async function executePlan(confirmed: boolean, failed: boolean, backend: NavigationThreadSummary["source"]) {
  const root: NavigationThreadSummary = { id: "same-id", source: "codex", title: "Local root", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false } };
  const child: NavigationThreadSummary = { ...root, source: backend, title: "Peer child", parentThreadId: root.id,
    parentThreadBackend: "codex", parentThreadInstanceId: "viewer",
    federation: { instanceLabel: "Peer machine", capabilities: ["turn_control"],
      ref: { backend, threadId: root.id, target: { scope: "remote", instanceId: "peer" } } } };
  const key = threadSummaryIdentityKey;
  let viewer = [root, child];
  let owner = [{ ...child, parentThreadId: "unloaded-middle", parentThreadBackend: backend, parentThreadInstanceId: undefined }];
  const archived = new Set<string>();
  const attempts: ArchiveThreadRequest[] = [];
  let resolve!: (value: boolean) => void;
  const confirm = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
  const errors = vi.fn();
  const removePin = vi.fn<NonNullable<DesktopApi["removeRemoteThreadPin"]>>(async () => ({ removed: true }));
  const api: DesktopApi = {
    readFederationHealth: async () => ({ health: { instanceId: "viewer", enabled: true, role: "gateway", status: "connected", peers: [] } }),
    getNavigationQueryPage: async (request) => navigationQueryFixture(request, { threads:
      (request.inventory === "owner" ? request.federationTarget?.scope === "remote" ? owner : [root] : viewer)
        .filter((thread) => !archived.has(key(thread))),
    }),
    getNavigationSelectedDetail: async ({ ref }) => ({ protocol: 2, ref, revision: "fixture", readiness: "ready", identity: "present",
      thread: viewer.find((thread) => thread.id === ref.threadId && thread.source === ref.backend) }),
    releaseNavigationQuery: async () => undefined,
    removeRemoteThreadPin: removePin,
    archiveThread: async (request) => {
      attempts.push(request);
      // A parent change is permitted after the operator confirms identities.
      expect(request.expectedParent).toBeUndefined();
      if (request.federationTarget?.scope === "remote" && failed) throw new Error("Peer unavailable");
      archived.add(request.federationTarget?.scope === "remote" ? key(child) : key(root));
      return { backend: request.backend, threadId: request.threadId, archivedAt: 1000, cleanup: [] };
    },
    onAgentEvent: () => () => undefined,
  };
  const hook = renderHook(() => useThreadNavigation(api, { confirmArchiveGroup: confirm, onThreadActionError: errors }));
  try {
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let operation!: ReturnType<typeof hook.result.current.archiveThread>;
    await act(async () => { operation = hook.result.current.archiveThread(root, { includeSubthreads: true }); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual([]);
    expect(hook.result.current.archivedThreadKeys.size).toBe(0);
    // Neither a new child nor a reparent while the dialog is open may change
    // the confirmed identity set. Same IDs on different owners stay distinct.
    viewer = [...viewer, { ...root, id: "arrived-later", parentThreadId: root.id, parentThreadBackend: "codex" }];
    owner = owner.map((thread) => ({ ...thread, parentThreadId: "moved-while-confirming" }));
    let result!: Awaited<typeof operation>;
    await act(async () => { resolve(confirmed); result = await operation; });
    expect(attempts.map((request) => [request.federationTarget?.scope, request.backend, request.threadId]))
      .toEqual(confirmed ? [["remote", backend, root.id], ["local", "codex", root.id]] : []);
    expect(result).toHaveLength(confirmed ? failed ? 1 : 2 : 0);
    expect(archived.has(key(root))).toBe(confirmed);
    expect(archived.has(key(child))).toBe(confirmed && !failed);
    expect(hook.result.current.archivedThreadKeys).toEqual(archived);
    expect(removePin.mock.calls.map(([request]) => request.ref)).toEqual(confirmed && !failed ? [child.federation!.ref] : []);
    expect(attempts.some((request) => request.threadId === "arrived-later")).toBe(false);
    if (confirmed && failed) expect(errors.mock.calls.some(([event]) => event.message === "Peer unavailable")).toBe(true);
  } finally { hook.unmount(); }
}

it("keeps the confirmed identities through owner reparenting and new viewer children", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(),
    fc.constantFrom<NavigationThreadSummary["source"]>("codex", "claude", "acp:kimi"),
    async (confirmed, failed, backend) => { await executePlan(confirmed, failed, backend); },
  ), { numRuns: 12 });
});

it("continues to the local parent after the selected peer child fails", async () => {
  await executePlan(true, true, "claude");
});

it("cancels without archiving or optimistically removing any selected thread", async () => {
  await executePlan(false, false, "codex");
});

// Confirmation can stay open for minutes while the sidebar keeps refreshing.
// The selection that replaces an archived thread must come from the rows on
// screen when the operator confirms, never from rows that have since gone.
it("falls back to a thread still on screen after a long confirmation", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 }), async (before, after) => {
    const thread = (id: string, updatedAt: number): NavigationThreadSummary => ({ id, source: "codex", title: id,
      titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false }, updatedAt });
    const root = thread("root", 10_000);
    let rows = [root, ...Array.from({ length: before }, (_, index) => thread(`gone-${index}`, 5_000 - index))];
    const archived = new Set<string>();
    let resolve!: (value: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    const api: DesktopApi = {
      getNavigationQueryPage: async (request) => navigationQueryFixture(request, {
        threads: rows.filter((candidate) => !archived.has(candidate.id)) }),
      getNavigationSelectedDetail: async ({ ref }) => ({ protocol: 2, ref, revision: "fixture", readiness: "ready", identity: "present",
        thread: rows.find((candidate) => candidate.id === ref.threadId) }),
      releaseNavigationQuery: async () => undefined,
      archiveThread: async (request) => {
        archived.add(request.threadId);
        return { backend: request.backend, threadId: request.threadId, archivedAt: 1000, cleanup: [] };
      },
      onAgentEvent: () => () => undefined,
    };
    const hook = renderHook(() => useThreadNavigation(api, { confirmArchiveGroup: confirm }));
    try {
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      act(() => { hook.result.current.selectThread(root); });
      await waitFor(() => expect(hook.result.current.selectedItemKey).toBe(threadSummaryIdentityKey(root)));
      let operation!: ReturnType<typeof hook.result.current.archiveThread>;
      await act(async () => { operation = hook.result.current.archiveThread(root, { includeSubthreads: true }); });
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      // While the dialog is open, every neighbour is archived elsewhere and
      // new threads arrive.
      rows = [root, ...Array.from({ length: after }, (_, index) => thread(`arrived-${index}`, 4_000 - index))];
      await act(async () => { await hook.result.current.refresh(); });
      await act(async () => { resolve(true); await operation; });
      const selected = hook.result.current.selectedItemKey;
      expect(selected).toBe(threadSummaryIdentityKey(rows[1]!));
    } finally { hook.unmount(); }
  }), { numRuns: 8 });
});
