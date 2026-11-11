import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AppServerNotification, ThreadExecutionMode } from "@pwragent/shared";

import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/owner-conformance-codex-transport")).OwnerConformanceCodexTransport,
}));
vi.mock("@pwrdrvr/codex-discovery", async (importOriginal) => {
  const { stubbedCodexDiscovery } = await import("./helpers/codex-discovery-stub");
  return stubbedCodexDiscovery(await importOriginal());
});

type TerminalMethod = "turn/completed" | "turn/failed" | "turn/cancelled";
type RegistryState = {
  activeTurnKeys: Set<string>;
  activeCodexTurnModes: Map<string, ThreadExecutionMode>;
  activeCodexTurnCollaborationModes: Map<string, "default" | "plan">;
  threadHasActiveTurn(threadId: string): boolean;
  resolveCodexThreadExecutionModeForActiveTurn(threadId: string): Promise<ThreadExecutionMode>;
};
const identity = { backend: "codex" as const, threadId: "thread" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function terminal(method: TerminalMethod, threadId = "thread", turnId = "turn"): AppServerNotification {
  const params = { threadId, turnId };
  if (method === "turn/failed") return { method, params: { ...params,
    turn: { id: turnId, status: "failed", error: { message: "Fixture failure" } },
  } };
  if (method === "turn/cancelled") return { method, params: { ...params, turn: { id: turnId, status: "cancelled" } } };
  return { method, params: { ...params, turn: { id: turnId, status: "completed", output: [] } } };
}

function fixture() {
  const temp = createTempStateDb("pwragent-turn-ordering-");
  const db = StateDb.open(temp.dbPath);
  const overlayStore = new SqliteOverlayStore(db);
  const client = new CodexAppServerClient({ directoryResolver: async () => [] });
  let notify!: (notification: AppServerNotification) => Promise<void> | void;
  vi.spyOn(client, "onNotification").mockImplementation((listener) => {
    notify = listener;
    return () => {};
  });
  const registry = createDesktopBackendRegistry({
    codexClient: client, overlayStore, messagingStore: null, pdfToolMcpServer: null,
    threadTitleGenerationService: null, discoverLocalAcpAgents: async () => [],
    resolveLiveProfileRuntimeInstanceIds: () => [],
  });
  const state = registry as unknown as RegistryState;
  return { registry, state, client, overlayStore,
    // Invoke the subscribed production listener independently, like the transport.
    notify: async (notification: AppServerNotification) => { await notify(notification); },
    assertEnded: (threadId = "thread") => {
      // Provider terminal ownership wins over every delayed start continuation.
      expect({
        busy: state.threadHasActiveTurn(threadId),
        modes: [...state.activeCodexTurnModes.keys()].filter(key => key.startsWith(`${threadId}:`)),
        turns: [...state.activeTurnKeys].filter(key => key.startsWith(`codex:${threadId}:`)),
        collaboration: [...state.activeCodexTurnCollaborationModes.keys()].filter(key => key.startsWith(`codex:${threadId}:`)),
      }).toEqual({ busy: false, modes: [], turns: [], collaboration: [] });
    },
    close: async () => {
      await registry.close();
      db.close();
      removeTempStateDbDir(temp.tempDir);
      vi.restoreAllMocks();
    },
  };
}

async function exerciseTerminalDuringModeLookup(
  method: TerminalMethod,
  executionMode: ThreadExecutionMode,
  pending: boolean,
  terminalFirst: boolean,
  scheduler: fc.Scheduler,
) {
  const f = fixture();
  const entered = [deferred(), deferred()];
  const resolveMode = f.state.resolveCodexThreadExecutionModeForActiveTurn.bind(f.state);
  let calls = 0;
  vi.spyOn(f.state, "resolveCodexThreadExecutionModeForActiveTurn").mockImplementation(async (threadId) => {
    const mode = await resolveMode(threadId);
    const scheduled = scheduler.schedule(Promise.resolve(mode), threadId);
    entered[calls++]!.resolve();
    return await scheduled;
  });
  const started: Promise<void>[] = [];
  try {
    await f.overlayStore.setThreadExecutionMode({ ...identity, executionMode });
    if (pending) {
      // A local submission installs collaboration ownership before its synthetic
      // started event. The real notification may arrive before that lookup ends.
      f.state.activeCodexTurnCollaborationModes.set("codex:thread:pending:thread", "plan");
      started.push(f.notify({ method: "turn/started", params: {
        threadId: "thread", turnId: "pending:thread", turn: { id: "pending:thread", status: "in_progress" },
      } }));
      await entered[0]!.promise;
    }
    started.push(f.notify({ method: "turn/started", params: {
      threadId: "thread", turnId: "turn", turn: { id: "turn", status: "in_progress" },
    } }));
    await entered[pending ? 1 : 0]!.promise;
    if (!terminalFirst) {
      await scheduler.waitAll();
      await Promise.all(started);
    }
    await f.notify(terminal(method));
    expect(f.state.threadHasActiveTurn("thread")).toBe(false);
    await scheduler.waitAll();
    await Promise.all(started);
    f.assertEnded();
  } finally {
    await scheduler.waitAll();
    await Promise.all(started);
    await f.close();
  }
}

async function exerciseNativeReviewInnerLookup(method: TerminalMethod, separateThread: boolean) {
  const f = fixture();
  const reviewThreadId = separateThread ? "review-thread" : "thread";
  const innerEntered = deferred(), innerRelease = deferred();
  const reviewEntered = deferred(), reviewRelease = deferred();
  const initializeResult = { userAgent: "fixture", methods: ["turn/start", "review/start"] };
  vi.spyOn(f.client, "getInitializeResult").mockResolvedValue(initializeResult);
  let innerStarted: Promise<void> | undefined;
  vi.spyOn(f.client, "startReview").mockImplementation(async () => {
    innerStarted = f.notify({ method: "turn/started", params: {
      threadId: reviewThreadId, turnId: "inner", turn: { id: "inner", status: "in_progress" },
    } });
    await innerEntered.promise;
    return { threadId: "thread", reviewThreadId, turnId: "turn" };
  });
  const resolveMode = f.state.resolveCodexThreadExecutionModeForActiveTurn.bind(f.state);
  let calls = 0;
  vi.spyOn(f.state, "resolveCodexThreadExecutionModeForActiveTurn").mockImplementation(async (threadId) => {
    const mode = await resolveMode(threadId);
    const first = calls++ === 0;
    (first ? innerEntered : reviewEntered).resolve();
    await (first ? innerRelease : reviewRelease).promise;
    return mode;
  });
  const review = f.registry.startReview({ ...identity, target: { type: "uncommittedChanges" } });
  try {
    await reviewEntered.promise;
    await f.notify(terminal(method, reviewThreadId));
    reviewRelease.resolve();
    await review;
    f.assertEnded(reviewThreadId);
    innerRelease.resolve();
    await innerStarted;
    f.assertEnded();
    f.assertEnded(reviewThreadId);
  } finally {
    reviewRelease.resolve();
    innerRelease.resolve();
    await review;
    await innerStarted;
    await f.close();
  }
}

describe("Codex turn terminal ownership", () => {
  it("does not restore a completed turn's mode after its pending lookup returns", async () => {
    await exerciseTerminalDuringModeLookup("turn/completed", "default", false, true, fc.schedulerFor([1]));
  });

  it("terminal ownership survives mode-read ordering and pending-to-real handoff", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("turn/completed", "turn/failed", "turn/cancelled"),
      fc.constantFrom("default", "auto", "full-access"),
      fc.boolean(), fc.boolean(), fc.scheduler(),
      exerciseTerminalDuringModeLookup,
    ), { numRuns: 25 });
  });

  it("native review release retains terminal evidence across the mode lookup", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("turn/completed", "turn/failed", "turn/cancelled"),
      fc.boolean(),
      async (method, separateThread) => {
        const f = fixture();
        const reviewThreadId = separateThread ? "review-thread" : "thread";
        const entered = deferred(), release = deferred();
        const initializeResult = { userAgent: "fixture", methods: ["turn/start", "review/start"] };
        vi.spyOn(f.client, "getInitializeResult").mockResolvedValue(initializeResult);
        vi.spyOn(f.client, "startReview").mockResolvedValue({ threadId: "thread", reviewThreadId, turnId: "turn" });
        const resolveMode = f.state.resolveCodexThreadExecutionModeForActiveTurn.bind(f.state);
        vi.spyOn(f.state, "resolveCodexThreadExecutionModeForActiveTurn").mockImplementation(async (threadId) => {
          const mode = await resolveMode(threadId);
          entered.resolve();
          await release.promise;
          return mode;
        });
        const review = f.registry.startReview({ ...identity, target: { type: "uncommittedChanges" } });
        try {
          await entered.promise;
          await f.notify(terminal(method, reviewThreadId));
          release.resolve();
          await review;
          f.assertEnded();
          f.assertEnded(reviewThreadId);
        } finally {
          release.resolve();
          await review;
          await f.close();
        }
      },
    ), { numRuns: 25 });
  });

  it("retires a native review's inner key before its delayed mode read returns", async () => {
    await exerciseNativeReviewInnerLookup("turn/completed", false);
  });

  it("native review release retires an inner started event still reading its mode", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("turn/completed", "turn/failed", "turn/cancelled"),
      fc.boolean(),
      exerciseNativeReviewInnerLookup,
    ), { numRuns: 25 });
  });
});
