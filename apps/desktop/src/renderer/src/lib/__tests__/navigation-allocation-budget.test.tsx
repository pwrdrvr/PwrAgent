import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent, NavigationQueryPage, NavigationRow } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import * as demand from "../navigation-window-demand";
import { useThreadNavigation } from "../useThreadNavigation";

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as Window & { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget;
});

function fixture(remoteWindow: boolean) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const rows: NavigationRow[] = Array.from({ length: 20 }, (_, i) => {
    const threadId = `thread-${i}`;
    const instanceId = remoteWindow ? "peer-1" : `peer-${i % 2}`;
    return { id: threadId, source: "codex", title: threadId, titleSource: "explicit",
      ref: { backend: "codex", threadId, ownerInstanceId: instanceId }, rowRevision: "r",
      federation: { instanceLabel: instanceId, peerStatus: "connected",
        ref: { backend: "codex", threadId, target: { scope: "remote", instanceId } } },
      linkedDirectories: [], inbox: { inInbox: true }, threadStatus: "idle", ordinaryChildCount: 1,
      nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" };
  });
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request): Promise<NavigationQueryPage> => ({
    protocol: 2, queryKey: JSON.stringify(request.query), generation: "g", ownerEpoch: "owner", countsRevision: "r",
    counts: { total: rows.length, active: 0, unread: rows.length, review: 0 }, coverage: { state: "complete" },
    directories: [], complete: true,
    entries: (request.query.kind === "lens" && request.query.roots !== "pinned" ? rows
      : request.query.kind === "exact" ? rows.filter((row) => request.query.kind === "exact"
        && request.query.identities.some((ref) => ref.threadId === row.id && ref.ownerInstanceId === row.ref.ownerInstanceId))
        : []).map((row) => ({ row, placement: { kind: "root" }, orderKey: row.id })),
  }));
  const api: DesktopApi = { getNavigationQueryPage: read, releaseNavigationQuery: vi.fn(async () => undefined),
    getNavigationSelectedDetail: async (request) => ({ protocol: 2, ref: request.ref, revision: "detail",
      readiness: "ready", identity: "present", thread: rows.find((row) => row.id === request.ref.threadId)! }),
    onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { api, read, emit: (event: AgentEvent) => { for (const listener of listeners) listener(event); } };
}

/** Count allocation-producing operations, not elapsed time or sampled GC attribution. */
function operations() {
  const build = vi.spyOn(demand, "buildNavigationWindowDemand");
  const stringify = vi.spyOn(JSON, "stringify");
  return () => ({
    demandMaps: build.mock.calls.length,
    demandRequests: build.mock.results.reduce((count, result) => count + (result.type === "return" ? result.value.size : 0), 0),
    canonicalizations: stringify.mock.calls.filter(([, replacer]) => typeof replacer === "function").length,
    identitySerializations: stringify.mock.calls.filter(([value]) => Array.isArray(value)
      && value.length === 3 && (value[0] === null || typeof value[0] === "string")
      && value[1] === "codex" && typeof value[2] === "string").length,
  });
}

it.each(["unchanged", "remote status", "remote subagent"] as const)("budgets demand allocations during 20 %s renders", async (scenario) => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  // A peer window receives the subagent overlay directly from its owner.
  const remoteWindow = scenario === "remote subagent";
  if (remoteWindow) Object.assign(window, { __pwragentFederationTarget: { scope: "remote", instanceId: "peer-1" } });
  const f = fixture(remoteWindow);
  const { result, rerender, unmount } = renderHook(() => useThreadNavigation(f.api));
  try {
    await waitFor(() => expect(result.current.pagedNavigation.presentationReady).toBe(true));
    await waitFor(() => expect(result.current.threads).toHaveLength(20));
    await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
    const count = operations();
    const reads = f.read.mock.calls.length;
    for (let i = 0; i < 20; i++) {
      if (scenario === "unchanged") rerender();
      else act(() => f.emit({ backend: "codex", federationTarget: { scope: "remote", instanceId: "peer-1" },
        notification: scenario === "remote status"
          ? { method: "thread/status/changed", params: { threadId: "thread-1", status: { type: i % 2 ? "idle" : "active" } } }
          : { method: "thread/subAgents/updated", params: { threadId: "thread-1", subAgents: [{ monitorId: "monitor",
            task: "Contrived task", status: "running", createdAt: 1, updatedAt: i + 2 }] } },
      }));
    }
    const measured = count();
    // Printed only on demand when collecting before/after PR evidence.
    if (process.env.NAVIGATION_OPERATION_REPORT) console.info(scenario, measured);
    expect(measured).toEqual({ demandMaps: 0, demandRequests: 0, canonicalizations: 0, identitySerializations: 0 });
    expect(f.read.mock.calls.length).toBe(reads);
    const updated = result.current.threads.find((row) => row.id === "thread-1")!;
    if (scenario === "remote status") expect(updated.threadStatus).toBe("idle");
    if (scenario === "remote subagent") expect(updated.subAgents?.[0]?.updatedAt).toBe(21);
  } finally { unmount(); }
});
