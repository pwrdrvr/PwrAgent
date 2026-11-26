import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type {
  AppServerNotification,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";

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
  const activity = registryModules(registry).turnState;
  return { registry, state, activity, client, overlayStore,
    // Invoke the subscribed production listener independently, like the transport.
    notify: async (notification: AppServerNotification) => { await notify(notification); },
    assertEnded: (threadId = "thread") => {
      // Provider terminal ownership wins over every delayed start continuation.
      expect({
        busy: state.threadHasActiveTurn(threadId),
        modes: activity.executionKeys().filter(key => key.startsWith(`${threadId}:`)),
        turns: activity.registeredTurnKeys().filter(key => key.startsWith(`codex:${threadId}:`)),
        collaboration: activity.codex(threadId).turns.filter(turn => turn.collaboration).map(turn => turn.turnId),
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
      f.activity.setCollaboration("codex:thread:pending:thread", "plan");
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

async function exerciseTerminalBeforeStartRegistration(method: TerminalMethod, terminalFirst: boolean, stage: "review-forward" | "headless" = "review-forward") {
  const f = fixture();
  const entered = deferred(), release = deferred();
  const reviews = registryModules(f.registry).managedReviewService;
  const forward = reviews.forwardManagedReviewActivity.bind(reviews);
  if (stage === "review-forward") {
    vi.spyOn(reviews, "forwardManagedReviewActivity").mockImplementation(async event => {
      await forward(event);
      if (event.notification.method === "turn/started") { entered.resolve(); await release.promise; }
    });
  } else {
    // Automation mirroring precedes emit() and the event observers.
    // Capturing a receipt only in emit() would already be too late.
    const early = registryModules(f.registry).headlessAutomation;
    const original = early.emitHeadlessAutomationLifecycle.bind(early);
    vi.spyOn(early, "emitHeadlessAutomationLifecycle").mockImplementation(async (backend, notification) => {
      await original(backend, notification);
      if (notification.method === "turn/started") { entered.resolve(); await release.promise; }
    });
  }
  const started = f.notify({ method: "turn/started", params: {
    threadId: "thread", turnId: "turn", turn: { id: "turn", status: "in_progress" },
  } });
  try {
    await entered.promise;
    if (!terminalFirst) { release.resolve(); await started; }
    await f.notify(terminal(method));
    release.resolve();
    await started;
    f.assertEnded();
    expect(f.activity.codex("thread").deliveries).toEqual([]);
  } finally {
    release.resolve();
    await started;
    await f.close();
  }
}

async function exerciseNativeReviewPendingInnerDelivery(method: TerminalMethod, separateThread: boolean, terminalId = "turn") {
  const f = fixture();
  const entered = deferred(), release = deferred();
  const reviewThreadId = separateThread ? "review-thread" : "thread";
  const reviews = registryModules(f.registry).managedReviewService;
  const forward = reviews.forwardManagedReviewActivity.bind(reviews);
  vi.spyOn(reviews, "forwardManagedReviewActivity").mockImplementation(async event => {
    await forward(event);
    if (event.notification.method === "turn/started" && event.notification.params.turnId === "inner") {
      entered.resolve(); await release.promise;
    }
  });
  const initializeResult = { userAgent: "fixture", methods: ["turn/start", "review/start"] };
  vi.spyOn(f.client, "getInitializeResult").mockResolvedValue(initializeResult);
  let inner: Promise<void> | undefined;
  vi.spyOn(f.client, "startReview").mockImplementation(async () => {
    inner = f.notify({ method: "turn/started", params: {
      threadId: reviewThreadId, turnId: "inner", turn: { id: "inner", status: "in_progress" },
    } });
    await entered.promise;
    return { threadId: "thread", reviewThreadId, turnId: "turn" };
  });
  const review = f.registry.startReview({ ...identity, target: { type: "uncommittedChanges" } });
  const deliveredTerminals: AgentEvent[] = [];
  f.registry.onEvent((event) => {
    if (event.notification.method === method && event.notification.params.threadId === reviewThreadId) {
      deliveredTerminals.push(event);
    }
  });
  try {
    await review;
    expect(f.state.threadHasActiveTurn("thread")).toBe(true);
    await f.notify(terminal(method, reviewThreadId, terminalId));
    release.resolve();
    await inner;
    f.assertEnded();
    f.assertEnded(reviewThreadId);
    expect(f.activity.codex(reviewThreadId).deliveries).toEqual([]);
    // The owner retires both IDs for an inline review. The listener must see
    // the same boundary, with the original provider identity still intact.
    expect(deliveredTerminals).toHaveLength(1);
    expect(deliveredTerminals[0]?.notification.params).toMatchObject({ turnId: terminalId });
    expect(deliveredTerminals[0]?.relatedReviewTurnId).toBe(
      separateThread ? undefined : terminalId === "turn" ? "inner" : "turn",
    );
  } finally {
    release.resolve();
    await review;
    await inner;
    await f.close();
  }
}

describe("Codex turn terminal ownership", () => {
  it("retains a native review's inner delivery before registration", async () => {
    await exerciseNativeReviewPendingInnerDelivery("turn/completed", false);
  });

  it("native review terminal owns a pending inner start delivery", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("turn/completed", "turn/failed", "turn/cancelled"), fc.boolean(),
      async (method, separateThread) => await exerciseNativeReviewPendingInnerDelivery(method, separateThread),
    ), { numRuns: 8 });
  });

  it("forwards the outer review ID when the inline review ends under the inner ID", async () => {
    await exerciseNativeReviewPendingInnerDelivery("turn/completed", false, "inner");
  });

  it("captures start ownership before the first listener await", async () => {
    await exerciseTerminalBeforeStartRegistration("turn/completed", true, "headless");
  });

  it("terminal ownership survives listener bookkeeping before emit", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("turn/completed", "turn/failed", "turn/cancelled"), fc.boolean(),
      async (method, terminalFirst) => await exerciseTerminalBeforeStartRegistration(method, terminalFirst, "headless"),
    ), { numRuns: 8 });
  });

  it("does not restore a turn that finished during awaited start bookkeeping", async () => {
    await exerciseTerminalBeforeStartRegistration("turn/completed", true);
  });

  it("terminal ownership survives interleaved start bookkeeping before registration", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("turn/completed", "turn/failed", "turn/cancelled"), fc.boolean(),
      async (method, terminalFirst) => await exerciseTerminalBeforeStartRegistration(method, terminalFirst),
    ), { numRuns: 8 });
  });

  it("does not restore a completed turn's mode after its pending lookup returns", async () => {
    await exerciseTerminalDuringModeLookup("turn/completed", "default", false, true, fc.schedulerFor([1]));
  });

  it("terminal ownership survives mode-read ordering and pending-to-real handoff", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("turn/completed", "turn/failed", "turn/cancelled"),
      fc.constantFrom("default", "auto", "full-access"),
      fc.boolean(), fc.boolean(), fc.scheduler(),
      exerciseTerminalDuringModeLookup,
    ), { numRuns: 8 });
  });

  it.each([
    ["turn/completed", false, false],
    ["turn/completed", false, true],
    ["turn/completed", true, false],
    ["turn/completed", true, true],
    ["turn/failed", false, false],
    ["turn/failed", false, true],
    ["turn/failed", true, false],
    ["turn/failed", true, true],
    ["turn/cancelled", false, false],
    ["turn/cancelled", false, true],
    ["turn/cancelled", true, false],
    ["turn/cancelled", true, true],
  ] as const)("native review release retains terminal evidence across the mode lookup [%#]", async (method, separateThread, terminalUsesInnerId) => {
    const f = fixture();
    const reviewThreadId = separateThread ? "review-thread" : "thread";
    const terminalId = terminalUsesInnerId && !separateThread ? "inner" : "turn";
    const entered = deferred(), release = deferred();
    const initializeResult = { userAgent: "fixture", methods: ["turn/start", "review/start"] };
    vi.spyOn(f.client, "getInitializeResult").mockResolvedValue(initializeResult);
    vi.spyOn(f.client, "startReview").mockResolvedValue({ threadId: "thread", reviewThreadId, turnId: "turn" });
    const resolveMode = f.state.resolveCodexThreadExecutionModeForActiveTurn.bind(f.state);
    let lookupWaiting = false;
    vi.spyOn(f.state, "resolveCodexThreadExecutionModeForActiveTurn").mockImplementation(async (threadId) => {
      const mode = await resolveMode(threadId);
      if (!lookupWaiting) {
        lookupWaiting = true;
        entered.resolve();
        await release.promise;
      }
      return mode;
    });
    const received: AgentEvent[] = [];
    f.registry.onEvent((event) => { received.push(event); });
    const review = f.registry.startReview({ ...identity, target: { type: "uncommittedChanges" } });
    try {
      await entered.promise;
      await f.notify({ method: "turn/started", params: {
        threadId: reviewThreadId, turnId: "inner", turn: { id: "inner", status: "in_progress" },
      } });
      await f.notify(terminal(method, reviewThreadId, terminalId));
      release.resolve();
      await review;
      f.assertEnded();
      f.assertEnded(reviewThreadId);
      expect(received.find((event) => event.notification.method === "turn/started")).toBeDefined();
      const terminalEvents = received.filter((event) => event.notification.method === method
        && event.notification.params.threadId === reviewThreadId);
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]?.notification.params).toMatchObject({ turnId: terminalId });
      expect(terminalEvents[0]?.relatedReviewTurnId).toBe(
        separateThread ? undefined : terminalId === "turn" ? "inner" : "turn",
      );
    } finally {
      release.resolve();
      await review;
      await f.close();
    }
  });

  it("retires a native review's inner key before its delayed mode read returns", async () => {
    await exerciseNativeReviewInnerLookup("turn/completed", false);
  });

  it("native review release retires an inner started event still reading its mode", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("turn/completed", "turn/failed", "turn/cancelled"),
      fc.boolean(),
      exerciseNativeReviewInnerLookup,
    ), { numRuns: 8 });
  });
});
