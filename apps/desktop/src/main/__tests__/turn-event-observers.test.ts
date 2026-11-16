import { setImmediate as settle } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AppServerBackendKind, AppServerPendingRequestNotification } from "@pwragent/shared";
import type { ReviewSubAgentRecord } from "../app-server/backend-registry-types";
import type { TurnEventDelivery, TurnEventObserver } from "../app-server/turn-event-observer";
import { registryModules } from "../app-server/backend-registry-wiring";
import { buildPendingRequestKey } from "../app-server/thread-turn-keys";
import type { StateDb } from "../state/state-db";
import { registryWithInMemoryStore } from "./helpers/registry-in-memory-fixture";
import { registryContextStandIn } from "./helpers/registry-context-stand-in";
import { ThreadMcpConnections } from "../app-server/thread-mcp-connections";

const databases: StateDb[] = [];
const registries: ReturnType<typeof registryWithInMemoryStore>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const registry of registries.splice(0)) await registry.close();
  for (const db of databases.splice(0)) db.close();
});

function event(method = "turn/completed", backend: AppServerBackendKind = "codex"): AgentEvent {
  return { backend, notification: { method, params: {
    threadId: "thread", turnId: "turn", turn: { id: "turn", status: method === "turn/started" ? "in_progress" : "completed", output: [] },
  } } } as AgentEvent;
}
function delivery(value = event(), extra: Partial<TurnEventDelivery> = {}): TurnEventDelivery {
  return { event: value, liveThreadUsageWork: undefined, precedingLiveThreadUsageBarrier: undefined,
    codexStatusSequence: undefined, codexStartDelivery: undefined, ...extra };
}
function fixture() {
  const registry = registryWithInMemoryStore(databases);
  registries.push(registry);
  const modules = registryModules(registry);
  const invoke = async (name: string, kind: keyof Omit<TurnEventObserver, "name">, value = delivery()) => {
    const observer = modules.turnEventObservers.observers.find(observer => observer.name === name);
    expect(observer, name).toBeDefined();
    const handler = observer![kind];
    expect(handler, `${name}.${kind}`).toBeTypeOf("function");
    return await handler!(value);
  };
  return { registry, modules, invoke, ports: registry.constructionPorts() };
}
const review = (mode: "native" | "managed" = "native"): ReviewSubAgentRecord => ({
  backend: "codex", parentBackend: "codex", createdAt: 1, displayText: "Contrived review", mode,
  parentThreadId: "thread", reviewThreadId: "thread", task: "Fixture", turnId: "outer",
});

// These hooks remain on the turn engine. Moved domain hooks are always reached
// through registryModules, never through a facade cast or a negative assertion.
type RetainedEventHooks = {
  withThreadMessageContext(event: AgentEvent): Promise<AgentEvent>;
  rememberFileChangeApprovalContext(event: AgentEvent): void;
  withEmbeddedFileChangeApprovalContext(event: AgentEvent): AgentEvent;
  rememberThreadTitleFromEvent(event: AgentEvent): void;
  notifyForAttentionRequired(event: AgentEvent): void;
  notifyForTerminalOutcome(event: AgentEvent): Promise<void>;
  emitToListeners(event: AgentEvent): Promise<void>;
  appendTurnFailure(params: unknown): Promise<void>;
};

describe("domain observers", () => {
  it("review-forwarding awaits the review owner's forwarding", async () => {
    const f = fixture(), value = delivery();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(f.modules.managedReviewService, "forwardManagedReviewActivity").mockReturnValue(gate);
    let finished = false;
    const work = f.invoke("review-forwarding", "onEvent", value).then(() => { finished = true; });
    await settle();
    expect(finished).toBe(false);
    release();
    await work;
    expect(spy).toHaveBeenCalledExactlyOnceWith(value.event);
  });
  it("review-output records through the review owner", async () => {
    const f = fixture(), value = delivery();
    const spy = vi.spyOn(f.modules.managedReviewService, "rememberManagedReviewOutput").mockImplementation(() => {});
    await f.invoke("review-output", "onEvent", value);
    expect(spy).toHaveBeenCalledExactlyOnceWith(value.event);
  });
  it("review-terminal retains the live record before completion and publishes managed terminals", async () => {
    const f = fixture(), record = review("managed"), value = delivery();
    vi.spyOn(f.modules.managedReviewService, "findActiveReviewSubAgentForTerminal").mockReturnValue({ key: "fixture", record });
    const calls: string[] = [];
    vi.spyOn(f.modules.managedReviewService, "completeReviewSubAgent").mockImplementation(async () => { calls.push("complete"); });
    vi.spyOn(f.modules.managedReviewService, "publishManagedReviewTerminal").mockImplementation(async () => { calls.push("publish"); });
    await f.invoke("review-terminal", "onTurnTerminal", value);
    expect(value.managedReview).toBe(record);
    expect(calls).toEqual(["complete", "publish"]);
  });
  it("review-boundary correlates the inner terminal to the outer inline review", async () => {
    const f = fixture(), value = delivery(event(), { managedReview: review() });
    const spy = vi.spyOn(f.modules.managedReviewService, "drainPendingReviewStartsForTerminalTurn").mockResolvedValue();
    await f.invoke("review-boundary", "onTurnTerminal", value);
    expect(value.lifecycleTurnId).toBe("outer");
    expect(spy).toHaveBeenCalledWith({ backend: "codex", threadId: "thread", turnId: "outer", method: "turn/completed" });
  });
  it("review-metadata replaces the event before listener delivery", async () => {
    const f = fixture(), value = delivery(), transformed = { ...value.event };
    vi.spyOn(f.modules.managedReviewService, "withReviewRuntimeMetadata").mockReturnValue(transformed);
    await f.invoke("review-metadata", "onEvent", value);
    expect(value.event).toBe(transformed);
  });
  it("monitor-activity records the event", async () => {
    const f = fixture(), value = delivery();
    const spy = vi.spyOn(f.modules.subAgentMonitorService, "recordTaskMonitorActivity").mockImplementation(() => {});
    await f.invoke("monitor-activity", "onEvent", value);
    expect(spy).toHaveBeenCalledExactlyOnceWith(value.event);
  });
  it("monitor-terminal awaits monitor completion", async () => {
    const f = fixture(), value = delivery();
    const spy = vi.spyOn(f.modules.subAgentMonitorService, "handleTaskMonitorTerminalNotification").mockResolvedValue();
    await f.invoke("monitor-terminal", "onTurnTerminal", value);
    expect(spy).toHaveBeenCalledExactlyOnceWith("codex", value.event.notification);
  });
  it("monitor-accounting preserves native activity, notification, name and usage order", async () => {
    const f = fixture(), calls: string[] = [];
    for (const method of ["recordCodexNativeSubAgentActivity", "recordCodexNativeSubAgentNotifications", "recordCodexNativeSubAgentNames", "recordTaskMonitorUsage"] as const) {
      vi.spyOn(f.modules.subAgentMonitorService, method).mockImplementation(async () => { calls.push(method); });
    }
    await f.invoke("monitor-accounting", "onEvent");
    expect(calls).toEqual(["recordCodexNativeSubAgentActivity", "recordCodexNativeSubAgentNotifications", "recordCodexNativeSubAgentNames", "recordTaskMonitorUsage"]);
  });
  it("usage-terminal-barrier waits for preceding live usage", async () => {
    const f = fixture();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let finished = false;
    const work = f.invoke("usage-terminal-barrier", "onTurnTerminal", delivery(event(), { precedingLiveThreadUsageBarrier: barrier })).then(() => { finished = true; });
    await settle();
    expect(finished).toBe(false);
    release();
    await work;
    expect(finished).toBe(true);
  });
  it("usage-terminal publishes written pricing in finally and propagates the original failure", async () => {
    const f = fixture(), calls: string[] = [], failure = new Error("Contrived persist failure");
    vi.spyOn(f.modules.threadUsageLedger, "flushLiveThreadUsageLines").mockImplementation(async () => { calls.push("flush"); return { activeTurnIds: ["turn"] }; });
    vi.spyOn(f.modules.subAgentMonitorService, "persistLiveCodexNativeSubAgentUsage").mockImplementation(async () => { calls.push("native"); throw failure; });
    vi.spyOn(f.modules.threadUsageLedger, "emitThreadPricingUpdated").mockImplementation(async () => { calls.push("pricing"); });
    await expect(f.invoke("usage-terminal", "onTurnTerminal")).rejects.toBe(failure);
    expect(calls).toEqual(["flush", "native", "pricing"]);
  });
  it("usage-terminal reads replacement store methods and the limit host at call time", async () => {
    const f = fixture();
    const limits = { accountKey: "fixture-account" } as NonNullable<ReturnType<typeof f.ports.turnLimitObservation>>;
    const host = f.registry as unknown as Pick<typeof f.ports, "turnLimitObservation">;
    const observation = vi.spyOn(host, "turnLimitObservation").mockReturnValue(limits);
    vi.spyOn(f.modules.threadUsageLedger, "usageAccountForTurn").mockResolvedValue("fixture-account");
    vi.spyOn(f.modules.threadUsageLedger, "flushLiveThreadUsageLines").mockResolvedValue(undefined);
    vi.spyOn(f.modules.subAgentMonitorService, "persistLiveCodexNativeSubAgentUsage").mockResolvedValue();
    vi.spyOn(f.modules.threadUsageLedger, "flushPendingTokenMiserLedger").mockResolvedValue(false);
    const store = vi.spyOn(f.ports.overlayStore, "completeThreadUsageTurn").mockResolvedValue(false);
    await f.invoke("usage-terminal", "onTurnTerminal");
    expect(observation).toHaveBeenCalledExactlyOnceWith("codex");
    expect(store).toHaveBeenCalledWith(expect.objectContaining({ backend: "codex", threadId: "thread", turnId: "turn", limitObservation: limits }));
  });
  it("usage-accounting preserves fail-open Token Miser and all-event accounting order", async () => {
    const f = fixture(), calls: string[] = [];
    vi.spyOn(f.modules.threadUsageLedger, "recordLiveThreadUsage").mockImplementation(async () => { calls.push("live"); });
    vi.spyOn(f.modules.threadUsageLedger, "recordTokenMiserParentModelRequest").mockImplementation(async () => { calls.push("miser"); throw new Error("Contrived filesystem failure"); });
    vi.spyOn(f.modules.threadUsageLedger, "handleThreadCompactionReplayBoundary").mockImplementation(async () => { calls.push("compaction"); });
    vi.spyOn(f.modules.threadUsageLedger, "recordToolInvocationAccounting").mockImplementation(async () => { calls.push("tools"); });
    vi.spyOn(f.modules.threadUsageLedger, "forgetCompletedTurnReplayObservations").mockImplementation(() => { calls.push("forget"); });
    await f.invoke("usage-accounting", "onEvent");
    expect(calls).toEqual(["live", "miser", "compaction", "tools", "forget"]);
  });
  it("usage-finish releases live work before fan-out", async () => {
    const f = fixture();
    const work = f.modules.threadUsageLedger.registerLiveThreadUsageEmitWork("codex", "thread");
    const spy = vi.spyOn(f.modules.threadUsageLedger, "finishLiveThreadUsageEmitWork");
    await f.invoke("usage-finish", "onEvent", delivery(event(), { liveThreadUsageWork: work }));
    expect(spy).toHaveBeenCalledExactlyOnceWith(work);
    await work.settled;
  });
  it("directory-lifecycle repairs only known Codex workspaces", async () => {
    const f = fixture();
    const host = f.registry as unknown as { getCachedThreadSummary: typeof f.ports.getCachedThreadSummary };
    vi.spyOn(host, "getCachedThreadSummary").mockReturnValue({ projectKey: "fixture" } as ReturnType<typeof host.getCachedThreadSummary>);
    const spy = vi.spyOn(f.modules.threadDirectoryService, "repairCodexThreadDirectoryRelationship").mockResolvedValue();
    await f.invoke("directory-lifecycle", "onEvent");
    expect(spy).toHaveBeenCalledExactlyOnceWith({ reason: "selected-thread", threadId: "thread" });
  });
  it("mcp-terminal cancels the matching gateway turn through its late host", async () => {
    const f = fixture(), cancel = vi.fn();
    const host = f.registry as unknown as { mcpGatewayTools: { cancel: typeof cancel } };
    Object.assign(host, { mcpGatewayTools: { cancel } });
    await f.invoke("mcp-terminal", "onTurnTerminal");
    expect(cancel).toHaveBeenCalledExactlyOnceWith("codex", "thread", "turn");
  });
  it("constructs an MCP observer without reading its late host or context stores", () => {
    const f = fixture();
    const host = vi.fn(() => f.ports);
    const module = new ThreadMcpConnections(registryContextStandIn(), { forgeToolBridge: f.modules.forgeToolBridge }, host);
    const observer = module.turnEventObserver();
    expect(host).not.toHaveBeenCalled();
    expect(observer.onTurnTerminal).toBeTypeOf("function");
  });
  it("forge-terminal raises only the withdrawn approval notice", async () => {
    const f = fixture();
    const requests = [{ method: "mcpServer/elicitation/request", params: { threadId: "thread", turnId: "turn", requestId: "fixture" } }] as AppServerPendingRequestNotification[];
    const spy = vi.spyOn(f.modules.forgeToolBridge, "raiseWithdrawnForgeApprovalTodo").mockResolvedValue();
    await f.invoke("forge-terminal", "onTurnTerminal", delivery(event(), { withdrawnForgeApprovals: requests }));
    expect(spy).toHaveBeenCalledExactlyOnceWith("codex", "thread", requests);
  });
  it("workspace-boundary drains the correlated terminal ID", async () => {
    const f = fixture();
    const spy = vi.spyOn(f.modules.threadWorkspaceService, "drainPendingThreadWorkspaceMovesForTerminalTurn").mockImplementation(() => {});
    await f.invoke("workspace-boundary", "onTurnTerminal", delivery(event(), { lifecycleTurnId: "outer" }));
    expect(spy).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "thread", turnId: "outer" });
  });
  it("workspace-status drains precisely the IDs retired by status cleanup", async () => {
    const f = fixture(), endedTurnIds = new Set(["one", "two"]);
    const spy = vi.spyOn(f.modules.threadWorkspaceService, "drainPendingThreadWorkspaceMovesForTurnIds").mockImplementation(() => {});
    await f.invoke("workspace-status", "onStatusChanged", delivery({ backend: "claude", notification: { method: "thread/status/changed", params: { threadId: "thread", status: { type: "idle" } } } }, { endedTurnIds }));
    expect(spy).toHaveBeenCalledExactlyOnceWith({ backend: "claude", threadId: "thread", turnIds: endedTurnIds });
  });
  it("runtime-terminal requests a Codex managed-runtime restart", async () => {
    const f = fixture();
    const spy = vi.spyOn(f.modules.codexRuntimeSupervisor, "maybeRestartCodexForManagedRuntimeChange").mockResolvedValue(false);
    await f.invoke("runtime-terminal", "onTurnTerminal");
    expect(spy).toHaveBeenCalledOnce();
  });
  it("runtime-settled refreshes known background terminals while the owner runs", async () => {
    const f = fixture();
    const runtime = f.modules.codexRuntimeSupervisor;
    vi.spyOn(runtime, "backgroundTerminalRecords", "get").mockReturnValue(new Map([["thread", []]]));
    const spy = vi.spyOn(runtime, "refreshCodexBackgroundTerminalsAfterTurn").mockResolvedValue();
    await f.invoke("runtime-settled", "onEvent");
    expect(spy).toHaveBeenCalledExactlyOnceWith("thread");
  });
});

describe("turn engine observers", () => {
  it("message-context transforms before approval recording and embedding", async () => {
    const f = fixture(), hooks = f.registry as unknown as RetainedEventHooks, calls: string[] = [];
    const value = delivery(), transformed = { ...value.event };
    vi.spyOn(hooks, "withThreadMessageContext").mockImplementation(async () => { calls.push("context"); return transformed; });
    vi.spyOn(hooks, "rememberFileChangeApprovalContext").mockImplementation(value => { expect(value).toBe(transformed); calls.push("remember"); });
    vi.spyOn(hooks, "withEmbeddedFileChangeApprovalContext").mockImplementation(value => { calls.push("embed"); return value; });
    await f.invoke("message-context", "onEvent", value);
    expect(value.event).toBe(transformed);
    expect(calls).toEqual(["context", "remember", "embed"]);
  });
  it("thread-state records titles and persists acknowledged Codex names", async () => {
    const f = fixture(), hooks = f.registry as unknown as RetainedEventHooks;
    const spy = vi.spyOn(hooks, "rememberThreadTitleFromEvent");
    const value = delivery({ backend: "codex", notification: { method: "thread/name/updated", params: { threadId: "thread", threadName: "Fixture name", titleSource: "derived" } } });
    await f.invoke("thread-state", "onEvent", value);
    expect(spy).toHaveBeenCalledExactlyOnceWith(value.event);
    expect((await f.ports.overlayStore.getThreadMetadata?.({ backend: "codex", threadId: "thread" }))?.title?.text).toBe("Fixture name");
  });
  it("turn-started registers execution ownership and rejects a retired receipt", async () => {
    const f = fixture(), state = f.modules.turnState;
    const receipt = state.beginStartDelivery("thread", "turn");
    const value = delivery(event("turn/started"), { codexStartDelivery: receipt });
    await f.invoke("turn-started", "onTurnStarted", value);
    expect(state.registeredTurnKeys()).toEqual(["codex:thread:turn"]);
    state.observeTurnTerminal("thread", "turn");
    state.unregisterTurn("codex:thread:turn");
    state.forgetExecution("thread:turn");
    await f.invoke("turn-started", "onTurnStarted", value);
    expect(state.registeredTurnKeys()).toEqual([]);
    expect(state.executionKeys()).toEqual([]);
    state.endStartDelivery(receipt);
  });
  it("terminal-requests cancels owned elicitation and resolves its bus event", async () => {
    const f = fixture(), resolve = vi.fn();
    const request = { method: "mcpServer/elicitation/request", params: { threadId: "thread", turnId: "turn", requestId: "fixture-request" } } as AppServerPendingRequestNotification;
    const key = buildPendingRequestKey({ backend: "codex", threadId: "thread", requestId: "fixture-request" });
    f.ports.pendingServerRequests.set(key, { backend: "codex", notification: request, resolve, reject: vi.fn() });
    const seen: AgentEvent[] = [];
    f.registry.onEvent(value => { seen.push(value); });
    await f.invoke("terminal-requests", "onTurnTerminal");
    expect(f.ports.pendingServerRequests.has(key)).toBe(false);
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ action: "cancel", content: null, _meta: null });
    expect(seen.map(value => value.notification.method)).toContain("serverRequest/resolved");
  });
  it("terminal-resources releases PDF attachments and reconciles Codex status", async () => {
    const f = fixture(), releaseTurn = vi.fn();
    const host = f.registry as unknown as { pdfAttachmentStore: { releaseTurn: typeof releaseTurn } };
    Object.assign(host, { pdfAttachmentStore: { releaseTurn } });
    f.modules.turnState.seedStatus("thread", "active");
    await f.invoke("terminal-resources", "onTurnTerminal");
    expect(releaseTurn).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "thread", turnId: "turn" });
    expect(f.modules.turnState.providerActive("thread")).toBe(false);
  });
  it("terminal-activity retires registration, execution and collaboration", async () => {
    const f = fixture(), state = f.modules.turnState;
    state.registerTurn("codex:thread:turn");
    state.setCollaboration("codex:thread:turn", "plan");
    state.acceptExecution("thread:turn", "default");
    await f.invoke("terminal-activity", "onTurnTerminal");
    expect(state.registeredTurnKeys()).toEqual([]);
    expect(state.executionKeys()).toEqual([]);
    expect(state.collaborationMode("codex:thread:turn")).toBeUndefined();
  });
  it("terminal-modes flushes queued modes at the resume boundary", async () => {
    const f = fixture();
    const host = f.registry as unknown as Pick<typeof f.ports, "scheduleQueuedAgentChange" | "flushQueuedExecutionModeIfPresent">;
    const calls: string[] = [];
    vi.spyOn(host, "scheduleQueuedAgentChange").mockImplementation(() => { calls.push("agent"); });
    vi.spyOn(host, "flushQueuedExecutionModeIfPresent").mockImplementation(async () => { calls.push("mode"); });
    await f.invoke("terminal-modes", "onTurnTerminal");
    expect(calls).toEqual(["agent", "mode"]);
  });
  it("terminal-queue releases the correlated lifecycle ID", async () => {
    const f = fixture();
    const spy = vi.spyOn(f.ports.threadTurnQueue, "releaseThread").mockResolvedValue();
    await f.invoke("terminal-queue", "onTurnTerminal", delivery(event(), { lifecycleTurnId: "outer" }));
    expect(spy).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "thread", turnId: "outer", status: "turn/completed" });
  });
  it("turn-failure durably appends non-ACP failure markers", async () => {
    const f = fixture(), hooks = f.registry as unknown as RetainedEventHooks;
    const spy = vi.spyOn(hooks, "appendTurnFailure").mockResolvedValue();
    await f.invoke("turn-failure", "onTurnTerminal", delivery(event("turn/failed")));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ backend: "codex", threadId: "thread", failure: expect.objectContaining({ turnId: "turn" }) }));
  });
  it("turn-status retires non-review activity and consumes stray review idle", async () => {
    const f = fixture(), state = f.modules.turnState;
    state.registerTurn("claude:thread:turn");
    const value = delivery({ backend: "claude", notification: { method: "thread/status/changed", params: { threadId: "thread", status: { type: "idle" } } } });
    await f.invoke("turn-status", "onStatusChanged", value);
    expect(value.endedTurnIds).toEqual(new Set(["turn"]));
    expect(state.registeredTurnKeys()).toEqual([]);
    state.activateReview(review());
    expect(await f.invoke("turn-status", "onStatusChanged", delivery({ ...value.event, backend: "codex" }))).toBe(false);
  });
  it("status-queue releases only after non-active status cleanup", async () => {
    const f = fixture();
    const spy = vi.spyOn(f.ports.threadTurnQueue, "releaseThread").mockResolvedValue();
    const value = delivery({ backend: "claude", notification: { method: "thread/status/changed", params: { threadId: "thread", status: { type: "idle" } } } }, { endedTurnIds: new Set() });
    await f.invoke("status-queue", "onStatusChanged", value);
    expect(spy).toHaveBeenCalledExactlyOnceWith({ backend: "claude", threadId: "thread", status: "idle" });
    spy.mockClear();
    await f.invoke("status-queue", "onStatusChanged", delivery({ backend: "claude", notification: { method: "thread/status/changed", params: { threadId: "thread", status: { type: "active" } } } }));
    expect(spy).not.toHaveBeenCalled();
  });
  it("request-resolution consumes premature resolution while the request is owned", async () => {
    const f = fixture();
    const requestId = "fixture";
    const request = { method: "mcpServer/elicitation/request", params: { threadId: "thread", turnId: "turn", requestId } } as AppServerPendingRequestNotification;
    f.ports.pendingServerRequests.set(buildPendingRequestKey({ backend: "codex", threadId: "thread", requestId }), { backend: "codex", notification: request, resolve: vi.fn(), reject: vi.fn() });
    expect(await f.invoke("request-resolution", "onEvent", delivery({ backend: "codex", notification: { method: "serverRequest/resolved", params: { threadId: "thread", requestId } } }))).toBe(false);
    f.ports.pendingServerRequests.clear();
  });
  it("turn-notifications sends attention before awaited terminal outcome", async () => {
    const f = fixture(), hooks = f.registry as unknown as RetainedEventHooks, calls: string[] = [];
    vi.spyOn(hooks, "notifyForAttentionRequired").mockImplementation(() => { calls.push("attention"); });
    vi.spyOn(hooks, "notifyForTerminalOutcome").mockImplementation(async () => { calls.push("terminal"); });
    await f.invoke("turn-notifications", "onEvent");
    expect(calls).toEqual(["attention", "terminal"]);
  });
  it("turn-listeners adds navigation scope to the final transformed event", async () => {
    const f = fixture(), hooks = f.registry as unknown as RetainedEventHooks;
    const spy = vi.spyOn(hooks, "emitToListeners").mockResolvedValue();
    const value = delivery();
    await f.invoke("turn-listeners", "onEvent", value);
    expect(spy).toHaveBeenCalledExactlyOnceWith(value.event);
    expect(value.event).toHaveProperty("navigationDirectoryScope");
  });
});
