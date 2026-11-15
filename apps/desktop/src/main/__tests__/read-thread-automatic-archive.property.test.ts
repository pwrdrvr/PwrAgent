import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AppServerReadThreadResponse } from "@pwragent/shared";
import type { RegistryReadThreadRequest } from "../app-server/registry-host-ports";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import type { OverlayStoreLike } from "../state/overlay-store-sqlite";

// Rule: reading a thread is use of it, and cancels its pending automatic
// archive, unless the read is a background evaluation that only checks a
// Continue After prerequisite or whether the waiting thread is idle. Before
// the fix every read cancelled, so a long-idle orchestrator whose workers kept
// producing events never archived while a wait was parked.

type Reader = "operator" | "agent" | "timer" | "dependency";

const THREADS = ["orchestrator", "worker"] as const;

/** The request each reader sends, in the shape its call site builds it. */
function requestFor(reader: Reader, threadId: string, viewOnly: boolean): RegistryReadThreadRequest {
  const base = { backend: "codex" as const, threadId, includeTurns: true };
  switch (reader) {
    case "operator": return { ...base, readReason: "thread-view", ...(viewOnly ? { viewOnly } : {}) };
    case "agent": return { ...base, viewOnly };
    // Timers opt out of the Codex idle-recycle clock only.
    case "timer": return { ...base, viewOnly, countsAsActivity: false };
    case "dependency": return {
      ...base, limit: 100, viewOnly: true, preserveAutomaticArchive: true,
      ...(viewOnly ? { countsAsActivity: false } : {}),
    };
  }
}

function emptyResponse(threadId: string): AppServerReadThreadResponse {
  return { backend: "codex", threadId, fetchedAt: 0 } as unknown as AppServerReadThreadResponse;
}

function registryWithReservations() {
  const registry = createDesktopBackendRegistry({
    codexClient: {
      close: async () => {},
      getInitializeResult: async () => ({ methods: [] }),
      listThreads: async () => [],
      onNotification: () => () => {},
      onPendingRequest: () => () => {},
    } as never,
    overlayStore: {} as OverlayStoreLike,
  });
  // The provider read itself is not under test.
  (registry as unknown as { readThreadData: (request: { threadId: string }) => Promise<AppServerReadThreadResponse> })
    .readThreadData = async (request) => emptyResponse(request.threadId);
  const coordinator = registryModules(registry).threadArchiveCoordinator;
  const cancelled = new Set<string>();
  vi.spyOn(coordinator, "cancelAutomaticArchive").mockImplementation((_backend, threadId) => {
    cancelled.add(threadId);
  });
  return { registry, cancelled };
}

const readArbitrary = fc.record({
  reader: fc.constantFrom<Reader>("operator", "agent", "timer", "dependency"),
  threadId: fc.constantFrom(...THREADS),
  viewOnly: fc.boolean(),
});

describe("readThread and automatic archive", () => {
  it("cancels a thread's automatic archive exactly when someone other than a dependency evaluation reads it (model)", async () => {
    await fc.assert(fc.asyncProperty(fc.array(readArbitrary, { minLength: 1, maxLength: 12 }), async (reads) => {
      const { registry, cancelled } = registryWithReservations();
      try {
        const model = new Set<string>();
        for (const read of reads) {
          await registry.readThread(requestFor(read.reader, read.threadId, read.viewOnly));
          if (read.reader !== "dependency") model.add(read.threadId);
          expect([...cancelled].sort()).toEqual([...model].sort());
        }
      } finally {
        await registry.close();
      }
    }), { numRuns: 50 });
  });

  it("keeps a parked orchestrator's archive through repeated dependency reads", async () => {
    const { registry, cancelled } = registryWithReservations();
    try {
      await registry.readThread(requestFor("dependency", "worker", false));
      await registry.readThread(requestFor("dependency", "orchestrator", true));
      expect(cancelled.size).toBe(0);
      await registry.readThread(requestFor("operator", "orchestrator", true));
      expect([...cancelled]).toEqual(["orchestrator"]);
    } finally {
      await registry.close();
    }
  });
});
