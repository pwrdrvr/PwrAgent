import { headlessAutomationRecords } from "./helpers/headless-automation-records";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  AppServerBackendKind,
  AppServerNotification,
} from "@pwragent/shared/contracts/normalized-app-server";
import { registryModules } from "../app-server/backend-registry-wiring";
import type { TaskMonitorDelegationRecord } from "../app-server/backend-registry-types";
import { taskMonitorThreadKey } from "../app-server/thread-turn-keys";
import { FederationAccountingStream } from "../federation/federation-event-stream";
import { eventMatchesThreadSelection, unsequencedFederationEventPayload } from "../federation/federation-runtime";
import type { StateDb } from "../state/state-db";
import { appNoticeReducer, INITIAL_APP_NOTICE_STATE } from "../../renderer/src/features/notifications/app-notice-state";
import { registryWithInMemoryStore } from "./helpers/registry-in-memory-fixture";

const workerKinds = ["monitor", "finishing", "native", "review", "automation"] as const;
type WorkerKind = typeof workerKinds[number];
const progressMethods = [
  "item/agentMessage/delta", "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta", "item/plan/delta",
] as const;
type TerminalMethod = "turn/completed" | "turn/failed" | "turn/cancelled";

function modelProgress(method: typeof progressMethods[number], threadId = "worker-a"): AppServerNotification {
  const params = { threadId, turnId: "turn", itemId: "item", delta: "Resumed model output" };
  if (method === "item/agentMessage/delta") return { method, params };
  if (method === "item/plan/delta") return { method, params: {
    threadId, turnId: "turn", item: { id: "plan", type: "plan" }, delta: params.delta,
  } };
  // Raw Codex reasoning notifications are forwarded without normalization.
  const notification = method === "item/reasoning/textDelta"
    ? { method, params: { ...params, contentIndex: 0 } }
    : { method, params: { ...params, summaryIndex: 0 } };
  return notification as unknown as AppServerNotification;
}

async function exercise(kind: WorkerKind, parentBackend: AppServerBackendKind,
  methods: readonly typeof progressMethods[number][], sequenced: boolean,
  terminalMethod: TerminalMethod = "turn/completed") {
  const databases: StateDb[] = [];
  const registry = registryWithInMemoryStore(databases);
  const modules = registryModules(registry);
  const monitors = modules.subAgentMonitorService;
  const monitorState = monitors as unknown as {
    taskMonitorDelegations: Map<string, TaskMonitorDelegationRecord>;
    completedTaskMonitorsByThread: Map<string, TaskMonitorDelegationRecord>;
  };
  const headless = headlessAutomationRecords(registry);
  const automationOwner = vi.spyOn(modules.headlessAutomation, "headlessAutomationErrorNoticeContext");
  // Native Codex workers have Codex parents. Other workers can cross providers.
  const ownerBackend = kind === "native" || kind === "automation" ? "codex" : parentBackend;
  for (const worker of ["worker-a", "worker-b"]) {
    if (kind === "native") monitors.setCodexNativeSubAgentParent(worker, "owner");
    else if (kind === "review") modules.turnState.activateReview({
      backend: "codex", parentBackend: ownerBackend, parentThreadId: "owner", reviewThreadId: worker,
      createdAt: 1, displayText: "Review", mode: "managed", task: "Review", turnId: "turn",
    });
    else if (kind === "automation") headless.set(worker, {
      backend: "codex", executionThreadId: worker, agentThreadId: "owner", automationName: "Fixture job",
    });
    else {
      const record = { backend: "codex", monitorId: worker, monitorThreadId: worker,
        parentBackend: ownerBackend, parentThreadId: "owner" } as TaskMonitorDelegationRecord;
      if (kind === "monitor") monitorState.taskMonitorDelegations.set(worker, record);
      else monitorState.completedTaskMonitorsByThread.set(taskMonitorThreadKey("codex", worker), record);
    }
  }
  const resolveOwner = vi.spyOn(monitors, "resolveSubAgentThreadOwner");
  const findMonitor = vi.spyOn(monitors, "taskMonitorForThread");
  const ownerStream = new FederationAccountingStream();
  const viewerStream = new FederationAccountingStream();
  let sequence = 0;
  let progressDeliveries = 0;
  let state = INITIAL_APP_NOTICE_STATE;
  let lastEvent: AgentEvent | undefined;
  registry.onEvent((event) => {
    lastEvent = event;
    // Production sparse selection runs before either federation transport.
    if (!eventMatchesThreadSelection(event, "transcript", {
      kind: "threads", threads: [{ backend: ownerBackend, threadId: "owner" }],
    })) return;
    if (progressMethods.includes(event.notification.method as typeof progressMethods[number])) progressDeliveries += 1;
    expect(eventMatchesThreadSelection(event, "transcript", {
      kind: "threads", threads: [{ backend: ownerBackend, threadId: "unrelated" }],
    })).toBe(false);
    const payload = sequenced
      ? ownerStream.encode(event, { epoch: "fixture", sequence: ++sequence })
      : unsequencedFederationEventPayload(event);
    const received = sequenced
      ? viewerStream.decode(JSON.parse(JSON.stringify(payload)))!
      : JSON.parse(JSON.stringify(payload)) as AgentEvent;
    expect(received.notification).toEqual(event.notification);
    // The receiving federation runtime supplies the owning peer identity.
    for (const instanceId of ["peer-a", "peer-b"]) {
      if (instanceId === "peer-b" && event.notification.method !== "error") continue;
      state = appNoticeReducer(state, {
        type: "codex-stream-event", backend: received.backend, instanceId,
        notification: received.notification as { method: string; params: Record<string, unknown> },
        errorNoticeContext: received.errorNoticeContext, threadLabel: "Fixture owner",
      });
    }
  });
  const publish = async (notification: AppServerNotification) => {
    await registry.publishLocalEvent({ backend: "codex", notification });
  };
  try {
    for (const threadId of ["worker-a", "worker-b"]) await publish({ method: "error", params: {
      threadId, turnId: "turn", willRetry: true, error: { message: "Reconnecting" },
    } });
    expect(state.durable).toHaveLength(4);
    const incident = state.durable.find((notice) => notice.id.includes('"peer-a","worker-a"'))!;
    expect(incident.threadLink).toMatchObject({ backend: ownerBackend, threadId: "owner", instanceId: "peer-a" });
    resolveOwner.mockClear();
    findMonitor.mockClear();
    automationOwner.mockClear();
    // Empty text and local command output cannot establish model recovery.
    await publish({ method: "item/agentMessage/delta", params: {
      threadId: "worker-a", turnId: "turn", itemId: "item", delta: "  ",
    } });
    await publish({ method: "item/commandExecution/outputDelta", params: {
      threadId: "worker-a", turnId: "turn", itemId: "command", delta: "output",
    } });
    await publish({ method: "item/agentMessage/delta", params: {
      threadId: "worker-a", turnId: "other-turn", itemId: "item", delta: "Other turn",
    } });
    expect(state.durable).toHaveLength(4);
    for (const method of methods) {
      await publish(modelProgress(method));
      // Rule: first nonempty model output clears exactly its worker/turn/peer
      // incident for a parent-only subscriber, before any terminal event.
      expect(state.durable).toHaveLength(3);
      expect(state.transient).toHaveLength(1);
      expect(state.transient[0]).toMatchObject({
        id: incident.id, tone: "success", title: "Codex resumed", threadLink: incident.threadLink,
      });
      expect(lastEvent).toMatchObject({ backend: "codex", notification: {
        method, params: { threadId: "worker-a", turnId: "turn" },
      } });
    }
    // Token count must not multiply scans of monitor/review/automation ownership.
    expect(resolveOwner).not.toHaveBeenCalled();
    expect(findMonitor).not.toHaveBeenCalled();
    expect(automationOwner).not.toHaveBeenCalled();
    expect(progressDeliveries).toBe(1);
    // A later retry in the same turn re-arms delivery after the first recovery.
    await publish({ method: "error", params: {
      threadId: "worker-a", turnId: "turn", willRetry: true, error: { message: "Reconnecting again" },
    } });
    expect(state.durable).toHaveLength(4);
    await publish(modelProgress(methods[0]!));
    expect(state.durable).toHaveLength(3);
    expect(state.transient[0]).toMatchObject({ id: incident.id, tone: "success" });
    // Leave an incident pending to exercise terminal cleanup without model output.
    await publish({ method: "error", params: {
      threadId: "worker-a", turnId: "turn", willRetry: true, error: { message: "Final retry" },
    } });
    if (kind === "monitor") {
      // complete_monitoring moves the monitor to finishing before Codex ends.
      // The fixture does that boundary without starting a real parent turn.
      const record = monitorState.taskMonitorDelegations.get("worker-a")!;
      monitorState.taskMonitorDelegations.delete("worker-a");
      monitorState.completedTaskMonitorsByThread.set(taskMonitorThreadKey("codex", "worker-a"), record);
    }
    const params = { threadId: "worker-a", turnId: "turn" };
    const terminal: AppServerNotification = terminalMethod === "turn/failed"
      ? { method: terminalMethod, params: { ...params, turn: { id: "turn", status: "failed", error: { message: "Fixture failure" } } } }
      : terminalMethod === "turn/cancelled"
        ? { method: terminalMethod, params: { ...params, turn: { id: "turn", status: "cancelled" } } }
        : { method: terminalMethod, params: { ...params, turn: { id: "turn", status: "completed", output: [] } } };
    await publish(terminal);
    expect(lastEvent).toMatchObject({ backend: "codex", notification: {
      method: terminalMethod, params: { threadId: "worker-a", turnId: "turn", turn: { id: "turn" } },
    }, errorNoticeContext: { backend: ownerBackend, threadId: "owner" } });
    // Completed incidents cannot retain ownership on delayed model tokens.
    await publish({ method: "item/agentMessage/delta", params: {
      threadId: "worker-a", turnId: "turn", itemId: "late", delta: "Late text",
    } });
    expect(lastEvent?.errorNoticeContext).toBeUndefined();
    const recoveredBefore = state.transient.length;
    // Another worker's active incident survives that terminal boundary.
    await publish(modelProgress("item/plan/delta", "worker-b"));
    expect(state.durable).toHaveLength(2);
    expect(state.transient).toHaveLength(recoveredBefore + 1);
  } finally {
    resolveOwner.mockRestore();
    findMonitor.mockRestore();
    automationOwner.mockRestore();
    monitorState.taskMonitorDelegations.clear();
    monitorState.completedTaskMonitorsByThread.clear();
    for (const record of modules.turnState.liveReviewRecords().values()) modules.turnState.finishReview(record);
    headless.clear();
    await registry.close();
    for (const db of databases) db.close();
  }
}

describe("sparse parent stream recovery", () => {
  it.each(workerKinds)("recovers a hidden %s on its first message delta", async (kind) => {
    await exercise(kind, "claude", ["item/agentMessage/delta"], true);
  });

  it("recovers only the matching incident for every model stream and transport", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...workerKinds), fc.constantFrom("codex" as const, "claude" as const),
      fc.array(fc.constantFrom(...progressMethods), { minLength: 1, maxLength: 12, size: "max" }),
      fc.boolean(), fc.constantFrom<TerminalMethod>("turn/completed", "turn/failed", "turn/cancelled"), exercise,
    ), { numRuns: 25 });
  });
});
