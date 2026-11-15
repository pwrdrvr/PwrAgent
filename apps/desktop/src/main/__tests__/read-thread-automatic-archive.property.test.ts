import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AppServerReadThreadResponse, ThreadSearchResult } from "@pwragent/shared";
import type { RegistryReadThreadRequest } from "../app-server/registry-host-ports";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { OverlayStoreLike } from "../state/overlay-store-sqlite";
import {
  ProviderTranscriptThreadSearchAdapter,
  registryTranscriptReader,
} from "../thread-search/thread-search-provider-adapters";

// Rule: reading a thread is use of it, and cancels its pending automatic
// archive, unless the read is a background evaluation: a Continue After
// prerequisite or idle check, or a content search scanning it for a match.
// Before the fix every read cancelled, so a long-idle orchestrator whose
// workers kept producing events never archived while a wait was parked, and
// a content search cancelled the archive of every thread it scanned.

type Reader = "operator" | "agent" | "timer" | "dependency" | "search";

const BACKGROUND_READERS: ReadonlySet<Reader> = new Set(["dependency", "search"]);

const THREADS = ["orchestrator", "worker"] as const;

/** The request each direct reader sends, in the shape its call site builds it. */
function requestFor(reader: Exclude<Reader, "search">, threadId: string, viewOnly: boolean): RegistryReadThreadRequest {
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

function candidate(threadId: string): ThreadSearchResult {
  return { backend: "codex", threadId, score: 0, confidence: "low", matchReasons: [], snippets: [] } as unknown as ThreadSearchResult;
}

/** Reads the way the renderer and agent search adapters do. */
async function read(registry: DesktopBackendRegistry, reader: Reader, threadId: string, viewOnly: boolean): Promise<void> {
  if (reader !== "search") {
    await registry.readThread(requestFor(reader, threadId, viewOnly));
    return;
  }
  const search = new ProviderTranscriptThreadSearchAdapter(
    registryTranscriptReader(async (request) => await registry.readThread(request)),
  );
  const response = await search.searchContent({ query: "needle", candidates: [candidate(threadId)], limit: 1 });
  expect(response.unavailableScopes).toEqual([]);
}

function emptyResponse(threadId: string): AppServerReadThreadResponse {
  return {
    backend: "codex", threadId, fetchedAt: 0, replay: { messages: [], entries: [] },
  } as unknown as AppServerReadThreadResponse;
}

function registryRecordingArchiveCancels() {
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
  reader: fc.constantFrom<Reader>("operator", "agent", "timer", "dependency", "search"),
  threadId: fc.constantFrom(...THREADS),
  viewOnly: fc.boolean(),
});

describe("readThread and automatic archive", () => {
  it("cancels a thread's automatic archive exactly when someone other than a background evaluation reads it (model)", async () => {
    await fc.assert(fc.asyncProperty(fc.array(readArbitrary, { minLength: 1, maxLength: 12 }), async (reads) => {
      const { registry, cancelled } = registryRecordingArchiveCancels();
      try {
        const model = new Set<string>();
        for (const { reader, threadId, viewOnly } of reads) {
          await read(registry, reader, threadId, viewOnly);
          if (!BACKGROUND_READERS.has(reader)) model.add(threadId);
          expect([...cancelled].sort()).toEqual([...model].sort());
        }
      } finally {
        await registry.close();
      }
    }), { numRuns: 50 });
  });

  it("keeps a parked orchestrator's archive through repeated dependency reads", async () => {
    const { registry, cancelled } = registryRecordingArchiveCancels();
    try {
      await read(registry, "dependency", "worker", false);
      await read(registry, "dependency", "orchestrator", true);
      expect(cancelled.size).toBe(0);
      await read(registry, "operator", "orchestrator", true);
      expect([...cancelled]).toEqual(["orchestrator"]);
    } finally {
      await registry.close();
    }
  });

  it("keeps a thread's archive while a content search scans it", async () => {
    const { registry, cancelled } = registryRecordingArchiveCancels();
    try {
      await read(registry, "search", "worker", false);
      expect(cancelled.size).toBe(0);
    } finally {
      await registry.close();
    }
  });
});
