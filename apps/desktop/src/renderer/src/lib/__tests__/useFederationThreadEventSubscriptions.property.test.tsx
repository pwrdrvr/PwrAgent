import { renderHook } from "@testing-library/react";
import fc from "fast-check";
import type { FederationCapability, NavigationThreadSummary } from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../desktop-api";
import { buildFederationThreadEventSubscriptions, useFederationThreadEventSubscriptions } from "../useFederationThreadEventSubscriptions";

const capabilities: FederationCapability[] = [
  "event_subscriptions", "thread_navigation", "thread_detail", "pending_request_control", "scheduled_actions",
];

function thread(index: number): NavigationThreadSummary {
  const source = index % 2 ? "claude" : "codex";
  const id = `thread-${Math.floor(index / 4)}`;
  return {
    id, source, title: `Thread ${index}`, titleSource: "explicit", executionMode: "default",
    linkedDirectories: [], inbox: { inInbox: false },
    federation: { ref: { backend: source, threadId: id, target: { scope: "remote", instanceId: `owner-${index % 4}` } },
      instanceLabel: "Owner", peerStatus: "connected", capabilities: [...capabilities] },
  };
}

function harness(threads: NavigationThreadSummary[]) {
  const setFederationEventSubscriptions = vi.fn(async ({ subscriptions }) => ({ subscriptions }));
  const desktopApi = { setFederationEventSubscriptions } as DesktopApi;
  const params = { desktopApi, enabled: true, threads, selectedThread: threads[0], retainedRemoteThreads: threads.slice(1, 3) };
  const rendered = renderHook(useFederationThreadEventSubscriptions, { initialProps: params });
  return { params, rendered, setFederationEventSubscriptions };
}

function isSubscriptionSerialization(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry: unknown) =>
    entry !== null && typeof entry === "object" && "sourceInstanceId" in entry);
}

function isSubscriptionSort(value: unknown): boolean {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return false;
  const entry: unknown = value[0][1];
  return entry instanceof Map || (entry !== null && typeof entry === "object" && "threadId" in entry);
}

describe("federation subscription projection properties", () => {
  it("does not rebuild a canonical subscription for irrelevant metadata changes", () => {
    fc.assert(fc.property(fc.array(fc.string({ maxLength: 12 }), { minLength: 1, maxLength: 8, size: "max" }), (titles) => {
      const { params, rendered, setFederationEventSubscriptions } = harness(Array.from({ length: 8 }, (_, index) => thread(index)));
      const stringify = vi.spyOn(JSON, "stringify");
      try {
        for (const title of titles) {
          params.threads = params.threads.map((row) => ({ ...row, title, updatedAt: title.length }));
          params.selectedThread = params.threads[0];
          params.retainedRemoteThreads = params.threads.slice(1, 3);
          stringify.mockClear();
          rendered.rerender({ ...params });
          // Metadata cannot change which owner/backend/thread receives each event class.
          expect(stringify.mock.calls.filter(([value]) => isSubscriptionSerialization(value))).toHaveLength(0);
          expect(setFederationEventSubscriptions).toHaveBeenCalledTimes(1);
        }
      } finally {
        stringify.mockRestore();
        rendered.unmount();
      }
    }), { numRuns: 25 });
  });

  it.each([32, 64])("budgets one and twenty unchanged shell actions at %i loaded threads", (count) => {
    let identityReads = 0;
    const rows = Array.from({ length: count }, (_, index) => {
      const row = thread(index);
      const id = row.id;
      Object.defineProperty(row, "id", { enumerable: true, get: () => { identityReads++; return id; } });
      return row;
    });
    const { params, rendered } = harness(rows);
    const stringify = vi.spyOn(JSON, "stringify");
    const sort = vi.spyOn(Array.prototype, "sort");
    try {
      for (const actions of [1, 20]) {
        stringify.mockClear();
        sort.mockClear();
        identityReads = 0;
        for (let action = 0; action < actions; action++) {
          // Retention currently returns a new, bounded array on every shell render.
          rendered.rerender({ ...params, retainedRemoteThreads: [...params.retainedRemoteThreads] });
        }
        expect({
          canonicalSerializations: stringify.mock.calls.filter(([value]) => isSubscriptionSerialization(value)).length,
          canonicalSorts: sort.mock.contexts.filter(isSubscriptionSort).length,
          identityReads,
        }).toEqual({ canonicalSerializations: 0, canonicalSorts: 0, identityReads: actions * (count + 3) });
      }
    } finally {
      stringify.mockRestore();
      sort.mockRestore();
      rendered.unmount();
    }
  });

  it("matches the uncached canonical builder after generated owner, interest, and capability transitions", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 16 }), { minLength: 8, maxLength: 18, size: "max" }), (actions) => {
      const rows = Array.from({ length: 8 }, (_, index) => {
        const row = thread(index);
        // Both backends can share an id on one owner; a second owner can share both.
        row.federation!.ref.target = { scope: "remote", instanceId: `owner-${Math.floor(index / 2) % 2}` };
        return row;
      });
      const { params, rendered, setFederationEventSubscriptions } = harness(rows);
      let nextThread = 12;
      try {
        for (const action of actions) {
          const row = params.threads[0]!;
          if (action === 0) params.threads = [...params.threads].reverse();
          if (action === 1) params.selectedThread = params.threads[1];
          if (action === 2) params.retainedRemoteThreads = params.threads.slice(2, 7);
          if (action === 3) params.enabled = !params.enabled;
          if (action >= 4 && action <= 8 && row.federation) {
            const capability = capabilities[action - 4]!;
            const current = row.federation!.capabilities!;
            // Params are not an immutable API: even in-place capability changes must be seen.
            const index = current.indexOf(capability);
            if (index < 0) current.push(capability);
            else current.splice(index, 1);
          }
          if (action === 9 && row.federation) row.federation.peerStatus = row.federation.peerStatus === "connected" ? "disconnected" : "connected";
          if (action === 10 && row.federation) {
            const target = row.federation!.ref.target;
            if (target.scope === "remote") target.instanceId = target.instanceId === "moved-owner" ? "owner-0" : "moved-owner";
          }
          if (action === 11) params.threads = params.threads.map((value) => ({ ...value, title: "Fresh metadata", linkedDirectories: [] }));
          if (action === 12) row.federation = row.federation ? undefined : {
            ...thread(0).federation!,
            ref: { backend: row.source, threadId: row.id, target: { scope: "remote", instanceId: "owner-0" } },
          };
          if (action === 13) params.threads = [...params.threads.slice(1), thread(nextThread++)];
          if (action === 14) params.selectedThread = thread(16);
          if (action === 15) params.retainedRemoteThreads = [];
          if (action === 16) {
            row.source = row.source === "codex" ? "claude" : "codex";
            if (row.federation) row.federation.ref.backend = row.source;
          }
          rendered.rerender({ ...params });
          const expected = params.enabled ? buildFederationThreadEventSubscriptions(params) : [];
          expect(setFederationEventSubscriptions.mock.lastCall?.[0]).toEqual({ consumer: "thread_view", subscriptions: expected });
          expect(rendered.result.current).toEqual(expected.filter((value) => value.eventClasses.includes("scheduled_actions"))
            .map((value) => ({ scope: "remote", instanceId: value.sourceInstanceId })));
        }
      } finally {
        rendered.unmount();
        expect(setFederationEventSubscriptions.mock.lastCall?.[0]).toEqual({ consumer: "thread_view", subscriptions: [] });
      }
    }), { numRuns: 25 });
  });

  it.each([32, 64])("budgets one relevant capability action at %i loaded threads", (count) => {
    const { params, rendered, setFederationEventSubscriptions } = harness(Array.from({ length: count }, (_, index) => thread(index)));
    const stringify = vi.spyOn(JSON, "stringify");
    const sort = vi.spyOn(Array.prototype, "sort");
    try {
      params.selectedThread!.federation!.capabilities = capabilities.filter((value) => value !== "scheduled_actions");
      rendered.rerender({ ...params });
      expect({
        canonicalSerializations: stringify.mock.calls.filter(([value]) => isSubscriptionSerialization(value)).length,
        canonicalSorts: sort.mock.contexts.filter(isSubscriptionSort).length,
        ipcCalls: setFederationEventSubscriptions.mock.calls.length,
      }).toEqual({ canonicalSerializations: 1, canonicalSorts: 15, ipcCalls: 2 });
      expect(rendered.result.current).toEqual([]);
    } finally {
      stringify.mockRestore();
      sort.mockRestore();
      rendered.unmount();
    }
  });

  it.each([false, true])("does not reconstruct a plan when titles are cleared (local=%s)", (local) => {
    const rows = Array.from({ length: local ? 64 : 8 }, (_, index) => {
      const row = thread(index);
      return local ? { ...row, federation: undefined } : row;
    });
    const { params, rendered } = harness(rows);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      // The generated metadata regression shrinks to one empty-title update.
      const renamed = rows.map((row) => ({ ...row, title: "", updatedAt: 0 }));
      rendered.rerender({ ...params, threads: renamed, selectedThread: renamed[0], retainedRemoteThreads: renamed.slice(1, 3) });
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
      rendered.unmount();
    }
  });

  it("clears the previous API consumer and publishes the cached plan to its replacement", () => {
    const { params, rendered, setFederationEventSubscriptions } = harness([thread(0), thread(1)]);
    const replacement = vi.fn(async ({ subscriptions }) => ({ subscriptions }));
    try {
      rendered.rerender({ ...params, desktopApi: { setFederationEventSubscriptions: replacement } as DesktopApi });
      expect(setFederationEventSubscriptions.mock.lastCall?.[0]).toEqual({ consumer: "thread_view", subscriptions: [] });
      expect(replacement).toHaveBeenCalledExactlyOnceWith({
        consumer: "thread_view", subscriptions: buildFederationThreadEventSubscriptions(params),
      });
    } finally {
      rendered.unmount();
      expect(replacement.mock.lastCall?.[0]).toEqual({ consumer: "thread_view", subscriptions: [] });
    }
  });
});
