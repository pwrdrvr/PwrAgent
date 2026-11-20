import { ResearchAdmissionRefused, type ResearchPorts, type ResearchService } from "@pwragent/owner-core/research-service";
import type {
  HandoffTaskResult,
  SendMessageToThreadResult,
} from "@pwragent/shared/contracts/thread-orchestration-tools";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { getMainLogger } from "../log";
import { createResearchAgentHandler } from "./research-runtime";

const mainLog = getMainLogger("pwragent:main");

export function createResearchRegistryPorts(registry: DesktopBackendRegistry): Pick<ResearchPorts, "spawn" | "stop" | "notify" | "cancelQueued"> {
  return {
    spawn: async (context, task, title, workspaceMode, onCreated) => {
      let refused: ResearchAdmissionRefused | undefined;
      const response = await registry.handoffResearchWorker({ operation: "handoff_task", context,
        args: { task, title, workspaceMode, seedMode: "clean", groupingMode: "subthread", messagingAttachment: "none" },
      }, (worker) => {
        try { onCreated(worker); }
        catch (error) { if (error instanceof ResearchAdmissionRefused) refused = error; throw error; }
      });
      if (refused) throw refused;
      if (!response.ok) {
        if (["invalid_arguments", "forbidden", "unsupported_backend", "unsupported_workspace", "unsupported_capability", "requires_confirmation", "ambiguous_workspace", "project_paused"].includes(response.error.code)) throw new ResearchAdmissionRefused(response.error.message);
        throw new Error(response.error.message);
      }
      const result = response.data as HandoffTaskResult;
      if (!result.threadId) throw new Error("Worker creation is unresolved. Inspect the pending handoff; do not retry it.");
      // startTurn may throw after provider admission. Only an explicit
      // ResearchAdmissionRefused can certify that no model work started.
      if (result.turnStartFailure) throw new Error(result.turnStartFailure.message);
      return { backend: result.backend, threadId: result.threadId, turnId: result.turnId };
    },
    stop: async (worker) => {
      if (!worker.turnId) throw new Error("Worker turn has not been confirmed");
      const active = registry.getActiveTurnForThread(worker);
      if (active && active.turnId !== worker.turnId) throw new Error("Worker has a different active turn. Inspect it before stopping.");
      await registry.interruptTurn({ ...worker, turnId: worker.turnId });
    },
    notify: async (context, target, prompt) => {
      if (context.kind === "operator") {
        const receipt = await registry.submitTurn({ backend: target.backend, threadId: target.threadId, origin: "manual", delivery: "new_turn", input: [{ type: "text", text: prompt }] });
        return receipt.status === "queued" ? { queueEntryId: receipt.entry.id } : { turnId: receipt.turnId };
      }
      if (!context.turnId || !context.callId) throw new Error("Research feedback needs its live calling turn");
      const response = await registry.deliverResearchMessage({ operation: "send_message_to_thread", context,
        args: { backend: target.backend, threadId: target.threadId, prompt, delivery: "new_turn" },
      });
      if (!response.ok) throw new Error(response.error.message);
      const receipt = response.data as SendMessageToThreadResult;
      return receipt.queueStatus === "queued" ? { queueEntryId: receipt.queueEntryId } : { turnId: receipt.turnId };
    },
    cancelQueued: async (entryId) => {
      const result = registry.cancelQueuedTurnWithDisposition(entryId, "Research run stopped");
      if (result.disposition === "cancelled") return {};
      if (result.disposition === "already_admitted" && result.turnId) return { turnId: result.turnId };
      throw new Error("Revision queue outcome is unknown. Inspect the worker thread.");
    },
  };
}

export function bindResearchRegistry(registry: DesktopBackendRegistry, research: ResearchService, enabled: () => boolean): () => void {
  registry.setResearchHandler(createResearchAgentHandler(research, (context) => registry.researchContextIsLive(context), enabled), (thread) => research.isWorker(thread), enabled);
  return registry.onEvent((event) => {
    const method = event.notification.method;
    if (method === "thread/turnQueue/updated") {
      const params = event.notification.params as { threadId?: string; queueEntryId?: string; status?: string; turnId?: string };
      if (params.threadId && params.queueEntryId && params.status) void research.observeQueue({ backend: event.backend, threadId: params.threadId }, params.queueEntryId, params.status, params.turnId)
        .catch((error) => mainLog.warn("research queue reconciliation failed", { error: String(error) }));
      return;
    }
    if (!["turn/started", "turn/completed", "turn/failed", "turn/cancelled"].includes(method)) return;
    const params = event.notification.params as { threadId?: string; turnId?: string; turn?: { id?: string; status?: string; error?: { message?: string } } };
    const turnId = params.turnId ?? params.turn?.id;
    if (!params.threadId || !turnId) return;
    const target = { backend: event.backend, threadId: params.threadId };
    if (method === "turn/started") void research.observeStart(target, turnId).catch((error) => mainLog.warn("research worker cancellation failed", { error: String(error) }));
    else research.observeEnd(target, turnId, { failed: method === "turn/failed" || params.turn?.status === "failed", note: params.turn?.error?.message });
  });
}
