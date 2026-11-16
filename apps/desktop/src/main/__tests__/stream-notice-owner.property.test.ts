import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import { registryModules } from "../app-server/backend-registry-wiring";
import type { ReviewSubAgentRecord, TaskMonitorDelegationRecord } from "../app-server/backend-registry-types";
import type { StateDb } from "../state/state-db";
import { taskMonitorThreadKey } from "../app-server/thread-turn-keys";
import { registryWithInMemoryStore } from "./helpers/registry-in-memory-fixture";

describe("stream notice owner context", () => {
  it("resolves every retry through nested native, review, live and finishing monitor ownership", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("native", "review", "monitor", "finishing"), { minLength: 1, maxLength: 6 }),
      async (links) => {
        const databases: StateDb[] = [];
        const registry = registryWithInMemoryStore(databases);
        const modules = registryModules(registry);
        const monitors = modules.subAgentMonitorService;
        const reviews = modules.managedReviewService.activeReviewSubAgentRecords as Map<string, ReviewSubAgentRecord>;
        const internals = monitors as unknown as {
          taskMonitorDelegations: Map<string, TaskMonitorDelegationRecord>;
          completedTaskMonitorsByThread: Map<string, TaskMonitorDelegationRecord>;
        };
        const events: AgentEvent[] = [];
        registry.onEvent((event) => { events.push(event); });
        try {
          links.forEach((kind, index) => {
            const threadId = `worker-${index}`;
            const parentThreadId = index + 1 === links.length ? "owner" : `worker-${index + 1}`;
            if (kind === "native") {
              monitors.setCodexNativeSubAgentParent(threadId, parentThreadId);
            } else if (kind === "review") {
              reviews.set(threadId, {
                backend: "codex", parentBackend: "codex", parentThreadId, reviewThreadId: threadId,
                createdAt: 1, displayText: "Review", mode: "managed", task: "Review", turnId: "turn",
              });
            } else {
              const record = {
                backend: "codex", monitorId: threadId, monitorThreadId: threadId,
                parentBackend: "codex", parentThreadId,
              } as TaskMonitorDelegationRecord;
              if (kind === "monitor") internals.taskMonitorDelegations.set(threadId, record);
              else internals.completedTaskMonitorsByThread.set(taskMonitorThreadKey("codex", threadId), record);
            }
          });
          for (const method of ["error", "warning"] as const) {
            await registry.publishLocalEvent({
              backend: "codex",
              notification: method === "error"
                ? { method, params: { threadId: "worker-0", turnId: "turn", willRetry: true, error: { message: "Reconnecting" } } }
                : { method, params: { threadId: "worker-0", message: "Provider warning" } },
            });
            expect(events.find((event) => event.notification.method === method)).toMatchObject({
              backend: "codex",
              notification: { params: { threadId: "worker-0" } },
              errorNoticeContext: { backend: "codex", threadId: "owner" },
            });
          }
        } finally {
          internals.taskMonitorDelegations.clear();
          internals.completedTaskMonitorsByThread.clear();
          reviews.clear();
          await registry.close();
          for (const db of databases) db.close();
        }
      },
    ), { numRuns: 25 });
  });

  it("routes a finishing Codex Job Monitor retry to its Claude parent", async () => {
    const databases: StateDb[] = [];
    const registry = registryWithInMemoryStore(databases);
    const monitors = registryModules(registry).subAgentMonitorService as unknown as {
      completedTaskMonitorsByThread: Map<string, TaskMonitorDelegationRecord>;
    };
    monitors.completedTaskMonitorsByThread.set(taskMonitorThreadKey("codex", "worker"), {
      backend: "codex", monitorThreadId: "worker", parentBackend: "claude", parentThreadId: "owner",
    } as TaskMonitorDelegationRecord);
    const events: AgentEvent[] = [];
    registry.onEvent((event) => { events.push(event); });
    try {
      await registry.publishLocalEvent({
        backend: "codex",
        notification: { method: "error", params: {
          threadId: "worker", turnId: "turn", willRetry: true, error: { message: "Reconnecting" },
        } },
      });
      expect(events.find((event) => event.notification.method === "error")).toMatchObject({
        errorNoticeContext: { backend: "claude", threadId: "owner", taskMonitor: true },
        notification: { params: { threadId: "worker", turnId: "turn" } },
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: { method: "turn/completed", params: {
          threadId: "worker", turnId: "turn", turn: { id: "turn", status: "completed", output: [] },
        } },
      });
      expect(events.find((event) => event.notification.method === "turn/completed"
        && event.notification.params.threadId === "worker")).toMatchObject({
        errorNoticeContext: { backend: "claude", threadId: "owner", taskMonitor: true },
      });
    } finally {
      monitors.completedTaskMonitorsByThread.clear();
      await registry.close();
      for (const db of databases) db.close();
    }
  });
});
