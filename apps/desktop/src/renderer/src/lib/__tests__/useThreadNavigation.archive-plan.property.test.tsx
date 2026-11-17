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
